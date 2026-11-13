/**
 * Solver-style building blocks used by the strongest bots (admin win rate below 50):
 * pot odds, expected value of a call, and balanced (polarized) betting ranges.
 * These only shape how bots play; they never touch the deck or dealt cards.
 */

/** Equity a call needs to break even: toCall / (pot + toCall). */
export function breakEvenEquity(toCall: number, pot: number): number {
  if (toCall <= 0) return 0;
  return toCall / (pot + toCall);
}

/** Expected chips won long-run by calling; positive means the call makes money. */
export function evCall(equity: number, pot: number, toCall: number): number {
  return equity * (pot + toCall) - toCall;
}

/**
 * Bluff share that makes a betting range unexploitable: when a bot bets `bet` into `pot`,
 * the caller is offered pot odds of bet/(pot+2*bet), so that share of the bets must be bluffs.
 */
export function balancedBluffShare(bet: number, pot: number): number {
  const size = Math.max(0, bet);
  const total = pot + 2 * size;
  return total > 0 ? size / total : 0;
}

export type PolarMode = 'value' | 'bluff' | 'check';

/**
 * Polarized plan for an unchecked betting round: bet big at the very top of the range, bluff
 * the balanced share at the bottom, and check middling hands back so the range has no
 * exploitable middle. `bluffBoost` scales the bluff frequency (from reads or temperament).
 */
export function polarizedPlan(
  equity: number,
  pot: number,
  betFraction: number,
  bluffBoost = 1
): PolarMode {
  if (equity >= 0.7) return 'value';
  const share = Math.min(1, balancedBluffShare(pot * betFraction, pot) * bluffBoost);
  if (equity <= 0.35 && Math.random() < share) return 'bluff';
  return 'check';
}
