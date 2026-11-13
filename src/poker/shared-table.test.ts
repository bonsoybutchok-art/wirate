import { describe, expect, it } from 'vitest';
import { emptyTable } from '@/poker/engine';
import { reconcileShared } from '@/poker/seating';
import type { GameRules } from '@/poker/session';
import {
  actShared, autoStepShared, findHuman, hasActiveHumans, playOutAndSettle, removeHuman, seatHuman, viewFor,
  type SharedHuman,
} from '@/poker/shared-table';

const rules: GameRules = { rakePercent: 0, botAggression: 'balanced', botLevel: 'normal', winRate: 50 };
const human = (id: string, stack = 1000): SharedHuman => ({ id, sessionId: `s-${id}`, name: id.toUpperCase(), avatarUrl: null, avatarEmoji: '🙂', stack });

function twoPlayerTable() {
  let table = reconcileShared(seatHuman(emptyTable(), human('a')));
  table = seatHuman(table, human('b')); // table is full of AI between hands: the second player takes an AI seat
  return table;
}

function dealt() {
  let table = twoPlayerTable();
  table = autoStepShared(table, rules).table; // between hands -> deal
  expect(table.hand).not.toBeNull();
  return table;
}

describe('shared table', () => {
  it('seats two real players in the same game and keeps AI only for the rest', () => {
    const table = twoPlayerTable();
    expect(table.seats.filter((s) => s && !s.isBot)).toHaveLength(2);
    expect(table.seats.filter(Boolean)).toHaveLength(8);
  });

  it('deals ONE hand: both players see the same board and dealer, but only their own cards', () => {
    const table = dealt();
    const a = viewFor(table, 'a');
    const b = viewFor(table, 'b');
    expect(a.hand?.number).toBe(b.hand?.number);
    expect(a.dealer).toBe(b.dealer);
    expect(a.hand?.board).toEqual(b.hand?.board);
    const mine = (view: typeof a, id: string) => view.seats.find((s) => s?.id === id)!;
    expect(mine(a, 'a').isMe).toBe(true);
    expect(mine(a, 'b').isMe).toBe(false);
    expect(mine(a, 'a').hole).toEqual(table.seats.find((s) => s?.id === 'a')!.hole);
    expect(mine(a, 'b').hole).not.toEqual(table.seats.find((s) => s?.id === 'b')!.hole);
    expect(JSON.stringify(a)).not.toContain('s-a'); // wallet sessions never reach browsers
    expect(a.hand?.deck).toEqual([]);
  });

  it('only the player whose turn it is can act', () => {
    const table = dealt();
    const actor = table.seats[table.hand!.toAct!]!;
    if (actor.isBot) return; // an AI acts through autoStepShared
    const other = actor.id === 'a' ? 'b' : 'a';
    expect(actShared(table, other, { type: 'fold' })).toBe(table);
    expect(actShared(table, actor.id, { type: 'fold' })).not.toBe(table);
  });

  it('a joiner in the middle of a hand waits for the next hand', () => {
    const base = autoStepShared(reconcileShared(seatHuman(emptyTable(), human('a'))), rules).table;
    expect(base.hand).not.toBeNull();
    const joined = seatHuman(base, human('c'));
    expect(findHuman(joined, 'c')?.waiting).toBe(true);
    let t = joined;
    for (let i = 0; i < 400 && !(t.hand === null && findHuman(t, 'c')?.waiting === false); i++) {
      const step = autoStepShared(t, rules);
      if (step.table === t) break;
      t = step.table;
    }
    expect(findHuman(t, 'c')?.waiting).toBe(false);
  });

  it('a player who leaves mid-hand folds, is paid at once and the table keeps playing for the others', () => {
    const table = dealt();
    const out = removeHuman(table, 'a');
    expect(out.departure?.playerId).toBe('a');
    expect(out.departure?.sessionId).toBe('s-a');
    expect(hasActiveHumans(out.table)).toBe(true); // b is still there
    const again = removeHuman(out.table, 'a');
    expect(again.departure).toBeNull();
  });

  it('when the last real player leaves, AI finish the hand and the stack is paid', () => {
    const base = autoStepShared(reconcileShared(seatHuman(emptyTable(), human('a'))), rules).table;
    const out = removeHuman(base, 'a');
    expect(hasActiveHumans(out.table)).toBe(false);
    const settled = playOutAndSettle(out.table, rules);
    expect(settled.table.hand).toBeNull();
  });

  it('a busted AI is replaced by a new AI with a different name', () => {
    let table = twoPlayerTable();
    const bot = table.seats.find((s) => s?.isBot)!;
    const name = bot.name;
    table = { ...table, seats: table.seats.map((s) => (s === bot ? { ...s, stack: 0 } : s)) };
    const next = autoStepShared(table, rules).table;
    expect(next.seats.some((s) => s?.name === name)).toBe(false);
    expect(next.seats.filter(Boolean)).toHaveLength(8);
  });

  it('players who keep timing out are cashed out', () => {
    let table = dealt();
    let departed = false;
    for (let i = 0; i < 600 && !departed; i++) {
      const step = autoStepShared(table, rules);
      if (step.departures.length > 0) departed = true;
      if (step.table === table) break;
      table = step.table;
    }
    expect(departed).toBe(true);
  });
});
