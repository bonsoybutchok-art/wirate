/**
 * Shared cash tables: ONE game per table, played by every real player seated there (plus AI that only
 * fill the seats real players leave empty). Pure functions over TableState so the server can run
 * them and tests can drive them. Real players are stored with isMe=false; each viewer gets their own
 * copy from viewFor().
 */
import { chooseBotAction } from '@/poker/bots';
import type { Card } from '@/poker/cards';
import { applyAction, startHand } from '@/poker/engine';
import { reconcileShared } from '@/poker/seating';
import { type GameRules } from '@/poker/session';
import type { Action, Seat, TableState } from '@/poker/types';

export const MAX_MISSED_TURNS = 3;

export interface SharedHuman {
  id: string;
  sessionId: string;
  name: string;
  avatarUrl: string | null;
  avatarEmoji: string;
  stack: number;
}

/** Chips a real player takes off the table; the server pays it into their wallet. */
export interface Departure {
  sessionId: string;
  playerId: string;
  stack: number;
}

function humanSeat(human: SharedHuman, tone: number): Seat {
  return {
    id: human.id,
    sessionId: human.sessionId,
    name: human.name,
    isBot: false,
    isMe: false,
    tone,
    stack: human.stack,
    bet: 0,
    invested: 0,
    hole: [],
    folded: true, // joins at the next hand
    allIn: false,
    acted: false,
    sittingOut: false,
    avatarUrl: human.avatarUrl,
    avatarEmoji: human.avatarEmoji,
    missed: 0,
  };
}

export function findHuman(table: TableState, playerId: string): { seat: Seat; index: number; waiting: boolean } | null {
  const index = table.seats.findIndex((seat) => seat && !seat.isBot && seat.id === playerId);
  if (index !== -1) return { seat: table.seats[index]!, index, waiting: false };
  const waiting = (table.waiting ?? []).findIndex((seat) => seat.id === playerId);
  if (waiting !== -1) return { seat: table.waiting![waiting]!, index: waiting, waiting: true };
  return null;
}

/** Real players who are still playing (not on their way out). */
export function hasActiveHumans(table: TableState): boolean {
  return table.seats.some((seat) => seat && !seat.isBot && !seat.leaving) || (table.waiting ?? []).length > 0;
}

function lastBotIndex(seats: (Seat | null)[]): number {
  for (let index = seats.length - 1; index >= 0; index--) if (seats[index]?.isBot) return index;
  return -1;
}

/** Puts a real player at the table: an empty seat, an AI's seat between hands, or the waiting list. */
export function seatHuman(table: TableState, human: SharedHuman): TableState {
  if (findHuman(table, human.id)) return table;
  const seats = [...table.seats];
  const empty = seats.findIndex((seat) => seat === null);
  if (empty !== -1) {
    seats[empty] = humanSeat(human, empty);
    return { ...table, seats };
  }
  if (!table.hand) {
    const bot = lastBotIndex(seats);
    if (bot !== -1) {
      seats[bot] = humanSeat(human, bot);
      return { ...table, seats };
    }
  }
  return { ...table, waiting: [...(table.waiting ?? []), humanSeat(human, table.waiting?.length ?? 0)] };
}

export interface RemoveResult {
  table: TableState;
  departure: Departure | null;
  /** All-in: the winnings are paid when the hand ends. */
  deferred: boolean;
}

/** A real player leaves. Chips that are no longer in play are paid out now; an all-in stack waits for the hand. */
export function removeHuman(table: TableState, playerId: string): RemoveResult {
  const found = findHuman(table, playerId);
  if (!found) return { table, departure: null, deferred: false };
  const sessionId = found.seat.sessionId;
  if (found.waiting) {
    const waiting = (table.waiting ?? []).filter((seat) => seat.id !== playerId);
    return {
      table: { ...table, waiting },
      departure: sessionId ? { sessionId, playerId, stack: found.seat.stack } : null,
      deferred: false,
    };
  }

  let next: TableState = { ...table, seats: table.seats.map((seat) => (seat ? { ...seat } : null)) };
  const hand = next.hand;
  const live = !!hand && hand.street !== 'complete' && !found.seat.folded;
  if (live && found.seat.allIn) {
    next.seats[found.index] = { ...next.seats[found.index]!, leaving: true };
    return { table: next, departure: null, deferred: true };
  }
  if (live) {
    if (hand!.toAct === found.index) {
      next = applyAction(next, found.index, { type: 'fold' });
    } else {
      next.seats[found.index] = { ...next.seats[found.index]!, folded: true, acted: true };
    }
  }
  const { sessionId: _sessionId, ...seat } = next.seats[found.index]!;
  void _sessionId;
  const departure = sessionId ? { sessionId, playerId, stack: seat.stack } : null;
  // The seat stays until the hand ends so chips already in the pot are counted; its wallet session is closed now.
  next.seats[found.index] = !next.hand ? null : { ...seat, stack: 0, leaving: true, sittingOut: true, folded: true };
  return { table: next, departure, deferred: false };
}

/** The player's own action; ignored unless it is their turn. */
export function actShared(table: TableState, playerId: string, action: Action): TableState {
  const found = findHuman(table, playerId);
  if (!found || found.waiting || table.hand?.toAct !== found.index) return table;
  const next = applyAction(table, found.index, action);
  if (next === table) return table;
  const seat = next.seats[found.index];
  if (seat && seat.missed) next.seats[found.index] = { ...seat, missed: 0 };
  return next;
}

export interface SharedStep {
  table: TableState;
  departures: Departure[];
}

/** Between hands: pay out leavers and busted players, seat the waiting list, refill with AI, deal. */
function betweenHands(table: TableState, rules: GameRules): SharedStep {
  const departures: Departure[] = [];
  const seats = table.seats.map((seat) => (seat ? { ...seat } : null));
  seats.forEach((seat, index) => {
    if (!seat || seat.isBot) return;
    if (seat.leaving || seat.stack <= 0) {
      if (seat.sessionId) departures.push({ sessionId: seat.sessionId, playerId: seat.id, stack: Math.max(0, seat.stack) });
      seats[index] = null;
    }
  });
  let next: TableState = { ...table, seats, hand: null };
  for (const waiting of next.waiting ?? []) {
    const slot = next.seats.findIndex((seat) => seat === null);
    const index = slot !== -1 ? slot : lastBotIndex(next.seats);
    if (index === -1) continue;
    next.seats[index] = { ...waiting, tone: index };
  }
  next = { ...next, waiting: [] };
  if (!hasActiveHumans(next)) return { table: next, departures };
  next = reconcileShared(next);
  return { table: startHand(next, rules.rakePercent), departures };
}

/** One automatic step: deal the next hand, clear a result, play an AI, or time out a real player. */
export function autoStepShared(table: TableState, rules: GameRules): SharedStep {
  const hand = table.hand;
  if (!hand) return betweenHands(table, rules);
  if (hand.street === 'complete') return { table: { ...table, hand: null }, departures: [] };
  if (hand.toAct === null) return { table, departures: [] };

  const index = hand.toAct;
  const actor = table.seats[index];
  if (!actor) return { table, departures: [] };
  if (actor.isBot) {
    const action = chooseBotAction(table, index, rules.botAggression, rules.botLevel ?? 'normal', rules.winRate);
    return { table: applyAction(table, index, action), departures: [] };
  }

  // A real player ran out of time: check if free, otherwise fold. Too many in a row means they left.
  const toCall = hand.currentBet - actor.bet;
  let next = applyAction(table, index, toCall <= 0 ? { type: 'check' } : { type: 'fold' });
  const missed = (actor.missed ?? 0) + 1;
  const seat = next.seats[index];
  if (seat) next.seats[index] = { ...seat, missed };
  if (missed >= MAX_MISSED_TURNS) {
    const removed = removeHuman(next, actor.id);
    return { table: removed.table, departures: removed.departure ? [removed.departure] : [] };
  }
  return { table: next, departures: [] };
}

/** Last real player left with chips in a live hand: finish the hand with AI only, then pay out. */
export function playOutAndSettle(table: TableState, rules: GameRules): SharedStep {
  let current = table;
  const departures: Departure[] = [];
  for (let guard = 0; guard < 400; guard++) {
    const done = !current.hand && !current.seats.some((seat) => seat && !seat.isBot);
    if (done) break;
    const step = autoStepShared(current, rules);
    departures.push(...step.departures);
    if (step.table === current) break;
    current = step.table;
  }
  return { table: current, departures };
}

const HIDDEN_CARD: Card = { rank: 2, suit: 'S' };

/** What one player may see: their own cards, other cards only at showdown, never the deck or wallet sessions. */
export function viewFor(table: TableState, playerId: string): TableState {
  const hand = table.hand;
  const reveal = !!hand && hand.street === 'complete' && hand.showdown;
  const clean = (seat: Seat): Seat => {
    const { sessionId: _sessionId, ...rest } = seat;
    void _sessionId;
    const mine = seat.id === playerId && !seat.isBot;
    const visible = mine || (reveal && !seat.folded);
    return { ...rest, isMe: mine, hole: visible ? seat.hole : seat.hole.map(() => HIDDEN_CARD) };
  };
  return {
    ...table,
    seats: table.seats.map((seat) => (seat ? clean(seat) : null)),
    waiting: (table.waiting ?? []).map(clean),
    hand: hand ? { ...hand, deck: [] } : null,
  };
}
