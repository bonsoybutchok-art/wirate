import { describe, expect, it } from 'vitest';
import { balancedBluffShare, breakEvenEquity, evCall, polarizedPlan } from '@/poker/strategy';

describe('EV and pot odds', () => {
  it('calls need the pot odds to break even', () => {
    expect(breakEvenEquity(0, 100)).toBe(0);
    expect(breakEvenEquity(50, 100)).toBeCloseTo(1 / 3);
    expect(breakEvenEquity(100, 100)).toBe(0.5);
    // calling more than the pot can require more than 50% equity
    expect(breakEvenEquity(200, 100)).toBeCloseTo(2 / 3);
  });

  it('EV of a call is positive only when equity beats pot odds', () => {
    // pot 100, call 50: EV = equity*150 - 50
    expect(evCall(0.4, 100, 50)).toBeCloseTo(10);
    expect(evCall(0.2, 100, 50)).toBeLessThan(0);
    expect(evCall(1 / 3, 100, 50)).toBeCloseTo(0);
  });
});

describe('balanced ranges and polarization', () => {
  it('bluff share matches the bet size the caller is offered', () => {
    // pot-sized bet (100 into 100): caller needs 33% -> bluff share 33%
    expect(balancedBluffShare(100, 100)).toBeCloseTo(1 / 3);
    // half-pot bet (50 into 100): caller needs 25% -> bluff share 25%
    expect(balancedBluffShare(50, 100)).toBeCloseTo(0.25);
    expect(balancedBluffShare(0, 100)).toBe(0);
  });

  it('polarizes: the top bets, the right bottom bluffs, the middle checks', () => {
    const plan = (equity: number) => {
      let value = 0, bluff = 0, check = 0;
      for (let i = 0; i < 200; i++) {
        const mode = polarizedPlan(equity, 100, 0.66);
        if (mode === 'value') value++;
        else if (mode === 'bluff') bluff++;
        else check++;
      }
      return { value, bluff, check };
    };
    // The very top always wants a value bet.
    expect(plan(0.95).value).toBe(200);
    // The middle never bets: no exploitable middle of the range.
    const middle = plan(0.5);
    expect(middle.value).toBe(0);
    expect(middle.bluff).toBe(0);
    // The bottom bluffs at the balanced frequency (25% for a 0.66 fraction), never more.
    const bottom = plan(0.2);
    expect(bottom.value).toBe(0);
    expect(bottom.check).toBeGreaterThan(0);
    expect(bottom.bluff).toBeGreaterThan(0);
    expect(bottom.bluff).toBeLessThan(bottom.check);
  });
});
