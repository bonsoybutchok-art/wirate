/**
 * Server-authoritative SHARED cash tables. One game per table lives in table_games (service role only):
 * every real player at the table plays the same hand with the same dealer, cards and board, and AI only
 * fill the seats real players leave empty. table_game_states keeps one small row per player as the
 * pointer "this player sits at this table" (its session_id is the wallet session).
 * Every handler first verifies the signed-in player; the browser receives a view with only its own cards.
 */
import { createServerFn } from '@tanstack/react-start';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import type { Database, Json } from '@/integrations/supabase/types';
import { normalizeWinRate } from '@/poker/bots';
import { emptyTable } from '@/poker/engine';
import { reconcileShared } from '@/poker/seating';
import {
  actShared,
  autoStepShared,
  findHuman,
  hasActiveHumans,
  playOutAndSettle,
  removeHuman,
  seatHuman,
  viewFor,
  type Departure,
  type SharedHuman,
} from '@/poker/shared-table';
import {
  delayFor,
  effectiveRake,
  isBotLevel,
  tableBotLevel,
  isValidAction,
  settleForExit,
  type GameRules,
} from '@/poker/session';
import type { Action, BotLevel, TableState } from '@/poker/types';

type Db = SupabaseClient<Database>;

export interface TableGameView {
  version: number;
  botLevel: BotLevel;
  /** This player's own copy: their cards are visible, everyone else's are hidden until showdown. */
  table: TableState;
  msUntilNext: number;
  /** Sat down in the middle of a hand: joins the next one. */
  waiting: boolean;
}

export interface TableGameResult {
  closed: boolean;
  view: TableGameView | null;
  balance?: number | undefined;
}

/** table_game_states: one pointer row per seated player (session_id is the wallet session). */
interface PointerRow {
  session_id: string;
  player_id: string;
  table_id: string | null;
  bot_level: string;
  state: Json;
  version: number;
  next_at: string;
}

/** table_games: the single shared game of a table. */
interface SharedRow {
  table_id: string;
  bot_level: string;
  state: Json;
  version: number;
  next_at: string;
}

const CLOCK_TOLERANCE_MS = 300;
const POINTER_COLUMNS = 'session_id, player_id, table_id, bot_level, state, version, next_at';
const SHARED_COLUMNS = 'table_id, bot_level, state, version, next_at';

/** Service-role client, loaded inside handlers only (never shipped to the browser). */
async function adminDb(): Promise<Db> {
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  return supabaseAdmin as unknown as Db;
}

// table_games is created by lovable-sql/0005_shared_table_games.sql and is not in the generated types yet.
const sharedTable = (db: Db) => (db as unknown as SupabaseClient).from('table_games');

async function loadPlayer(db: Db, authId: string) {
  const { data, error } = await db
    .from('players')
    .select('id, display_name, avatar_url, avatar_emoji, status')
    .eq('auth_id', authId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Player profile not found');
  return data;
}

async function loadRules(db: Db, row: { table_id: string | null; bot_level?: string }): Promise<GameRules> {
  const { data, error } = await db.from('settings').select('key, value').in('key', ['rake_percent', 'bot_aggression', 'player_win_rate']);
  if (error) throw new Error(error.message);
  const map = new Map((data ?? []).map((entry) => [entry.key, entry.value]));
  const houseRake = Number(map.get('rake_percent') ?? 5);
  const aggression = map.get('bot_aggression');
  const winRate = normalizeWinRate(map.get('player_win_rate'));
  let tableRake: number | null = null;
  if (row.table_id) {
    const { data: tbl } = await db.from('poker_tables').select('rake_percent').eq('id', row.table_id).maybeSingle();
    tableRake = tbl?.rake_percent ?? null;
  }
  return {
    rakePercent: effectiveRake(tableRake, Number.isFinite(houseRake) ? houseRake : 5),
    botAggression: aggression === 'passive' || aggression === 'aggressive' ? aggression : 'balanced',
    botLevel: isBotLevel(row.bot_level) ? row.bot_level : 'normal',
    winRate,
  };
}

async function loadPointer(db: Db, playerId: string, tableId: string): Promise<PointerRow | null> {
  const { data, error } = await db
    .from('table_game_states')
    .select(POINTER_COLUMNS)
    .eq('player_id', playerId)
    .eq('table_id', tableId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PointerRow | null) ?? null;
}

async function loadPointerBySession(db: Db, playerId: string, sessionId: string): Promise<PointerRow | null> {
  const { data, error } = await db
    .from('table_game_states')
    .select(POINTER_COLUMNS)
    .eq('session_id', sessionId)
    .eq('player_id', playerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PointerRow | null) ?? null;
}

/** Pointer rows written by the old one-game-per-player version hold a whole table state. */
function isLegacyState(state: Json): boolean {
  return !!state && typeof state === 'object' && !Array.isArray(state) && 'seats' in state;
}

async function loadShared(db: Db, tableId: string): Promise<SharedRow | null> {
  const { data, error } = await sharedTable(db).select(SHARED_COLUMNS).eq('table_id', tableId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as SharedRow | null) ?? null;
}

function tableOf(row: { state: Json }): TableState {
  return row.state as unknown as TableState;
}

/** Save with an optimistic version check; `saved` is false when someone else changed the game first. */
async function saveShared(
  db: Db,
  row: SharedRow,
  table: TableState,
  keepSchedule = false
): Promise<{ row: SharedRow | null; saved: boolean }> {
  const nextAt = keepSchedule ? row.next_at : new Date(Date.now() + delayFor(table)).toISOString();
  const { data, error } = await sharedTable(db)
    .update({ state: table as unknown as Json, version: row.version + 1, next_at: nextAt, updated_at: new Date().toISOString() })
    .eq('table_id', row.table_id)
    .eq('version', row.version)
    .select(SHARED_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return { row: data as SharedRow, saved: true };
  return { row: await loadShared(db, row.table_id), saved: false };
}

async function deleteShared(db: Db, row: SharedRow): Promise<boolean> {
  const { data, error } = await sharedTable(db).delete().eq('table_id', row.table_id).eq('version', row.version).select('table_id');
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

async function cashOut(db: Db, sessionId: string, amount: number): Promise<number> {
  const { data, error } = await db.rpc('server_cash_out', { p_session: sessionId, p_amount: amount });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

/** Old one-game-per-player tables: play out what is needed and pay the stack. */
async function closeLegacyGame(db: Db, row: PointerRow): Promise<number> {
  const rules = await loadRules(db, row);
  const stack = Math.max(0, Math.floor(settleForExit(tableOf(row), rules)));
  return cashOut(db, row.session_id, stack);
}

/** Write the amount down first, so a failed payout can still be finished later. */
async function recordPending(db: Db, departures: Departure[]): Promise<void> {
  for (const departure of departures) {
    await db
      .from('table_game_states')
      .update({ state: { cashOut: departure.stack } as unknown as Json })
      .eq('session_id', departure.sessionId);
  }
}

async function payOut(db: Db, departures: Departure[]): Promise<Map<string, number>> {
  const balances = new Map<string, number>();
  for (const departure of departures) {
    try {
      balances.set(departure.playerId, await cashOut(db, departure.sessionId, Math.max(0, Math.floor(departure.stack))));
    } catch (err) {
      // The amount is already recorded on the player's pointer row; it is paid the next time they open a table.
      console.error('cash-out failed', departure.sessionId, err);
    }
  }
  return balances;
}

interface Mutation {
  row: SharedRow | null;
  balances: Map<string, number>;
}

/**
 * Change the shared game with an optimistic version check (retrying on conflict), pay out whoever left the
 * table, and delete the game when no real player is left.
 */
async function mutateShared(
  db: Db,
  tableId: string,
  change: (table: TableState) => { table: TableState; departures: Departure[] },
  options: { attempts?: number; keepSchedule?: boolean } = {}
): Promise<Mutation> {
  const attempts = options.attempts ?? 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const row = await loadShared(db, tableId);
    if (!row) return { row: null, balances: new Map() };
    const before = tableOf(row);
    const out = change(before);
    if (out.table === before && out.departures.length === 0) return { row, balances: new Map() };
    await recordPending(db, out.departures);
    const stillPaying = out.table.seats.some((seat) => seat && !seat.isBot && seat.sessionId);
    const idle = !hasActiveHumans(out.table) && !stillPaying;
    if (idle) {
      if (await deleteShared(db, row)) return { row: null, balances: await payOut(db, out.departures) };
      continue;
    }
    const saved = await saveShared(db, row, out.table, options.keepSchedule);
    if (saved.saved) return { row: saved.row, balances: await payOut(db, out.departures) };
  }
  return { row: await loadShared(db, tableId), balances: new Map() };
}

function viewOf(row: SharedRow, playerId: string): TableGameView | null {
  const table = tableOf(row);
  const found = findHuman(table, playerId);
  if (!found) return null;
  return {
    version: row.version,
    botLevel: isBotLevel(row.bot_level) ? row.bot_level : 'normal',
    table: viewFor(table, playerId),
    msUntilNext: Math.max(0, new Date(row.next_at).getTime() - Date.now()),
    waiting: found.waiting,
  };
}

function resultFor(row: SharedRow | null, playerId: string, balance?: number): TableGameResult {
  const view = row ? viewOf(row, playerId) : null;
  return view ? { closed: false, view } : { closed: true, view: null, balance };
}

/**
 * Take this player off their table and pay them. Returns the new balance, or undefined when an all-in
 * stack must wait for the hand to finish.
 */
async function settlePointer(db: Db, playerId: string, pointer: PointerRow): Promise<number | undefined> {
  if (isLegacyState(pointer.state)) return closeLegacyGame(db, pointer);
  if (pointer.table_id) {
    const tableId = pointer.table_id;
    const rules = await loadRules(db, pointer);
    const out = await mutateShared(db, tableId, (table) => {
      const removed = removeHuman(table, playerId);
      // Nobody else is playing: finish the hand with AI only so the stack can be paid now.
      if (removed.deferred && !hasActiveHumans(removed.table)) return playOutAndSettle(removed.table, rules);
      return { table: removed.table, departures: removed.departure ? [removed.departure] : [] };
    });
    const paid = out.balances.get(playerId);
    if (paid !== undefined) return paid;
    if (out.row && findHuman(tableOf(out.row), playerId)) return undefined;
  }
  // Not on any table any more: pay what was written down, or give back the buy-in.
  const pending = (pointer.state as { cashOut?: unknown } | null)?.cashOut;
  let amount = typeof pending === 'number' ? pending : null;
  if (amount === null) {
    const { data } = await db.from('table_sessions').select('buy_in').eq('id', pointer.session_id).maybeSingle();
    amount = Number(data?.buy_in ?? 0);
  }
  return cashOut(db, pointer.session_id, Math.max(0, Math.floor(amount)));
}

/** Close any open session the player left behind (closed tab, lost connection). */
async function settleOpenSessions(db: Db, playerId: string): Promise<void> {
  const { data: sessions, error } = await db
    .from('table_sessions')
    .select('id, buy_in')
    .eq('player_id', playerId)
    .eq('status', 'open');
  if (error) throw new Error(error.message);
  for (const session of sessions ?? []) {
    const pointer = await loadPointerBySession(db, playerId, session.id);
    if (!pointer) {
      // No game was ever created for this seat: return the buy-in.
      await cashOut(db, session.id, Number(session.buy_in));
      continue;
    }
    const balance = await settlePointer(db, playerId, pointer);
    if (balance === undefined) throw new Error('Your last hand is still finishing. Please try again in a few seconds.');
  }
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

const tableInput = (input: { tableId: string }) => ({ tableId: requireUuid(input?.tableId, 'table') });

export const getTableGame = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(tableInput)
  .handler(async ({ data, context }): Promise<TableGameResult> => {
    const db = await adminDb();
    const player = await loadPlayer(db, context.userId);
    const pointer = await loadPointer(db, player.id, data.tableId);
    if (!pointer) return { closed: true, view: null };
    if (isLegacyState(pointer.state)) return { closed: true, view: null, balance: await closeLegacyGame(db, pointer) };
    const row = await loadShared(db, data.tableId);
    if (!row) return { closed: true, view: null };
    if (!findHuman(tableOf(row), player.id)) {
      return { closed: true, view: null, balance: await settlePointer(db, player.id, pointer) };
    }
    return resultFor(row, player.id);
  });

export const sitDownAtTable = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { tableId: string; buyIn: number }) => {
    const buyIn = Number(input?.buyIn);
    if (!Number.isFinite(buyIn) || buyIn <= 0) throw new Error('Invalid buy-in');
    return { tableId: requireUuid(input?.tableId, 'table'), buyIn: Math.floor(buyIn) };
  })
  .handler(async ({ data, context }): Promise<TableGameResult> => {
    const db = await adminDb();
    const player = await loadPlayer(db, context.userId);
    await settleOpenSessions(db, player.id);

    const { data: tableRow, error: tableError } = await db
      .from('poker_tables')
      .select('id, small_blind, big_blind, min_buy_in, max_buy_in, bot_level')
      .eq('id', data.tableId)
      .eq('is_active', true)
      .maybeSingle();
    if (tableError) throw new Error(tableError.message);
    if (!tableRow) throw new Error('Table not found or not active');
    // The bot skill is fixed per table by the admin; players cannot choose it.
    const botLevel = tableBotLevel(tableRow.bot_level);
    const config = {
      smallBlind: Number(tableRow.small_blind),
      bigBlind: Number(tableRow.big_blind),
      minBuyIn: Number(tableRow.min_buy_in),
      maxBuyIn: Number(tableRow.max_buy_in),
    };

    const { data: sessionId, error: buyError } = await db.rpc('server_buy_in', {
      p_auth: context.userId,
      p_amount: data.buyIn,
      p_table_id: data.tableId,
    });
    if (buyError) throw new Error(buyError.message);
    const session = sessionId as string;

    const refund = async (reason: string): Promise<never> => {
      await cashOut(db, session, data.buyIn).catch(() => undefined);
      throw new Error(reason);
    };

    const { error: pointerError } = await db.from('table_game_states').insert({
      session_id: session,
      player_id: player.id,
      table_id: data.tableId,
      bot_level: botLevel,
      state: {} as unknown as Json,
      next_at: new Date().toISOString(),
    });
    if (pointerError) return refund(pointerError.message);

    const human: SharedHuman = {
      id: player.id,
      sessionId: session,
      name: player.display_name,
      avatarUrl: player.avatar_url,
      avatarEmoji: player.avatar_emoji,
      stack: data.buyIn,
    };

    // Join the table's one shared game, or open it when this is the first real player.
    let joined: SharedRow | null = null;
    try {
      for (let attempt = 0; attempt < 6 && !joined; attempt++) {
        const row = await loadShared(db, data.tableId);
        if (!row) {
          const base = reconcileShared(seatHuman(emptyTable(config), human));
          const { data: created, error: insertError } = await sharedTable(db)
            .insert({
              table_id: data.tableId,
              bot_level: botLevel,
              state: base as unknown as Json,
              next_at: new Date(Date.now() + delayFor(base)).toISOString(),
            })
            .select(SHARED_COLUMNS)
            .maybeSingle();
          if (!insertError && created) joined = created as SharedRow; // on conflict someone else just opened it: retry as a joiner
        } else {
          const current = tableOf(row);
          const next = { ...seatHuman(current, human), config };
          const saved = await saveShared(db, row, next, true);
          if (saved.saved) joined = saved.row;
        }
      }
    } catch (err) {
      return refund(err instanceof Error ? err.message : 'Could not join the table');
    }
    if (!joined) return refund('Could not join the table, please try again');

    return resultFor(joined, player.id);
  });

export const tickTableGame = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(tableInput)
  .handler(async ({ data, context }): Promise<TableGameResult> => {
    const db = await adminDb();
    const player = await loadPlayer(db, context.userId);
    const pointer = await loadPointer(db, player.id, data.tableId);
    if (!pointer) return { closed: true, view: null };
    if (isLegacyState(pointer.state)) return { closed: true, view: null, balance: await closeLegacyGame(db, pointer) };
    const row = await loadShared(db, data.tableId);
    if (!row) return { closed: true, view: null };
    const table = tableOf(row);
    if (!findHuman(table, player.id)) {
      return { closed: true, view: null, balance: await settlePointer(db, player.id, pointer) };
    }
    if (!hasActiveHumans(table) || Date.now() < new Date(row.next_at).getTime() - CLOCK_TOLERANCE_MS) {
      return resultFor(row, player.id);
    }

    // Every player's browser asks to advance the game; the version check lets exactly one of them win.
    const rules = await loadRules(db, row);
    const out = await mutateShared(db, data.tableId, (current) => autoStepShared(current, rules), { attempts: 1 });
    return resultFor(out.row, player.id, out.balances.get(player.id));
  });

export const actAtTable = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { tableId: string; action: Action }) => {
    if (!isValidAction(input?.action)) throw new Error('Invalid action');
    return { tableId: requireUuid(input?.tableId, 'table'), action: input.action };
  })
  .handler(async ({ data, context }): Promise<TableGameResult> => {
    const db = await adminDb();
    const player = await loadPlayer(db, context.userId);
    const pointer = await loadPointer(db, player.id, data.tableId);
    if (!pointer || isLegacyState(pointer.state)) return { closed: true, view: null };
    const out = await mutateShared(
      db,
      data.tableId,
      (table) => ({ table: actShared(table, player.id, data.action), departures: [] }),
      { attempts: 3 }
    );
    return resultFor(out.row, player.id);
  });

export const leaveTable = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator(tableInput)
  .handler(async ({ data, context }): Promise<TableGameResult> => {
    const db = await adminDb();
    const player = await loadPlayer(db, context.userId);
    const pointer = await loadPointer(db, player.id, data.tableId);
    if (!pointer) return { closed: true, view: null };
    const balance = await settlePointer(db, player.id, pointer);
    return { closed: true, view: null, balance };
  });
