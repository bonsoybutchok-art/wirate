import { describe, expect, it } from 'vitest';
import { applyAction, emptyTable, legalActions, startHand } from './engine';
import type { Card } from './cards';
import type { Seat, TableState } from './types';

const seat = (name: string, stack: number, hole: Card[]): Seat => ({
  id: name, name, isBot: false, isMe: false, tone: 0, stack, bet: 0, invested: 0, hole, folded: false, allIn: false,
  acted: false, sittingOut: false, avatarUrl: null, avatarEmoji: '🙂',
});
const c = (rank: number, suit: Card['suit']): Card => ({ rank, suit });

/** A hand that is already on the river with fixed cards, so the result is predictable. */
function riverTable(seats: Seat[], dealer = 0): TableState {
  const table = emptyTable({ smallBlind: 1, bigBlind: 2, minBuyIn: 1, maxBuyIn: 1000 });
  seats.forEach((s, i) => { table.seats[i] = s; });
  table.dealer = dealer;
  table.handCount = 1;
  table.hand = {
    number: 1, street: 'river', board: [c(2, 'C'), c(7, 'D'), c(9, 'H'), c(11, 'S'), c(4, 'D')], deck: [],
    pot: 0, currentBet: 0, minRaise: 2, toAct: null, winners: [], rake: 0, rakePercent: 0, showdown: false,
  };
  return table;
}

describe('showdown payouts', () => {
  it('returns an uncalled bet to its owner instead of paying it out as a win', () => {
    // Ben has the better hand but only 50 chips. Ana put in 100; her extra 50 was never called.
    const ana = seat('Ana', 0, [c(3, 'S'), c(5, 'S')]);
    const ben = seat('Ben', 0, [c(14, 'S'), c(14, 'H')]);
    ana.invested = 100; ana.bet = 0; ben.invested = 50; ben.allIn = true;
    const table = riverTable([ana, ben]);
    table.hand!.pot = 150;
    // Drive showdown through the public API: nobody can act, so start from a completed river.
    const done = applyAllChecked(table);
    expect(done.hand!.winners.map((w) => w.seat)).toEqual([1]);
    expect(done.seats[0]!.stack).toBe(50); // the uncalled 50 came back
    expect(done.seats[1]!.stack).toBe(100); // main pot: 50 + 50
  });

  it('pays an odd chip to the winner closest to the left of the dealer', () => {
    const a = seat('A', 0, [c(14, 'S'), c(13, 'S')]);
    const b = seat('B', 0, [c(14, 'H'), c(13, 'H')]);
    const x = seat('X', 0, [c(3, 'C'), c(5, 'H')]);
    a.invested = b.invested = x.invested = 5;
    const table = riverTable([a, b, x], 0); // dealer = seat 0, so B (seat 1) is first to the left
    table.hand!.pot = 15;
    const done = applyAllChecked(table);
    const amounts = Object.fromEntries(done.hand!.winners.map((w) => [w.seat, w.amount]));
    expect(amounts[1]).toBeGreaterThanOrEqual(amounts[0]!);
    expect(Object.values(amounts).reduce((sum, v) => sum + v, 0)).toBe(15);
  });

  it('splits odd chips in the smallest chip of fractional-blind tables', () => {
    const table = emptyTable({ smallBlind: 0.5, bigBlind: 1, minBuyIn: 1, maxBuyIn: 1000 });
    const a = seat('A', 0, [c(14, 'S'), c(13, 'S')]);
    const b = seat('B', 0, [c(14, 'H'), c(13, 'H')]);
    const x = seat('X', 0, [c(3, 'C'), c(5, 'H')]);
    a.invested = b.invested = x.invested = 2.5;
    [a, b, x].forEach((s, i) => { table.seats[i] = s; });
    table.dealer = 0;
    table.hand = riverTable([]).hand;
    table.hand!.pot = 7.5;
    const done = applyAllChecked(table);
    const amounts = Object.fromEntries(done.hand!.winners.map((w) => [w.seat, w.amount]));
    expect(amounts).toEqual({ 1: 4, 0: 3.5 });
  });

  it('does not let a player re-raise after only a short all-in raise', () => {
    const a = seat('A', 900, []); a.acted = true; a.bet = 100; a.invested = 100;
    const b = seat('B', 0, []); b.acted = true; b.bet = 130; b.invested = 130; b.allIn = true;
    const d = seat('D', 900, []); // has not acted yet
    const table = riverTable([a, b, d]);
    table.hand!.currentBet = 130;
    table.hand!.minRaise = 100;
    table.hand!.toAct = 0;
    expect(legalActions(table, 0)!.canRaise).toBe(false);
    expect(legalActions(table, 0)!.toCall).toBe(30);
    table.hand!.toAct = 2;
    expect(legalActions(table, 2)!.canRaise).toBe(true);
    expect(legalActions(table, 2)!.minTo).toBe(230);
  });

  it('keeps the full big blind as the bet to match when the big blind is short', () => {
    const table = emptyTable({ smallBlind: 10, bigBlind: 20, minBuyIn: 1, maxBuyIn: 1000 });
    table.seats[0] = seat('Short', 5, []);
    table.seats[1] = seat('Deep', 1000, []);
    const next = startHand(table, 0);
    expect(next.hand!.currentBet).toBe(20);
  });

  it('still starts a normal hand', () => {
    const table = emptyTable();
    table.seats[0] = seat('A', 1000, []);
    table.seats[1] = seat('B', 1000, []);
    const next = startHand(table, 0);
    expect(next.hand?.street).toBe('preflop');
    expect(applyAction(next, next.hand!.toAct!, { type: 'fold' }).hand?.street).toBe('complete');
  });
});

/** Everyone left with chips checks the river until the hand finishes at showdown. */
function applyAllChecked(table: TableState): TableState {
  let current = table;
  // Seats that are still able to act check; with all-in players the river closes immediately.
  current = { ...current, hand: { ...current.hand!, toAct: firstToAct(current) } };
  for (let guard = 0; guard < 10 && current.hand!.street !== 'complete'; guard++) {
    const index = current.hand!.toAct;
    if (index === null) break;
    current = applyAction(current, index, { type: 'check' });
  }
  return current;
}
function firstToAct(table: TableState): number | null {
  const i = table.seats.findIndex((s) => s && !s.folded && !s.allIn);
  return i === -1 ? null : i;
}
