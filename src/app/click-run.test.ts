import { describe, expect, it } from 'vitest';
import { ClickRun } from './click-run';

describe('ClickRun', () => {
  it('finds the double-clicks the browser sends no dblclick for', () => {
    const c = new ClickRun();
    // The browser's own double-click (dblclick for the 2nd) is not one again.
    expect(c.click('a', 1)).toBe(false);
    expect(c.click('a', 2)).toBe(false);
    // The window that opened took clicks 3 to 6; then 7 and 8 come to the element: a double-click.
    c.reset();
    expect(c.click('a', 7)).toBe(false);
    expect(c.click('a', 8)).toBe(true);
    // A run the element got all of is no double-click past its 2nd click (a triple-click is not two).
    const d = new ClickRun();
    expect([1, 2, 3, 4, 5].map((n) => d.click('a', n))).toEqual([false, false, false, false, false]);
    // After the window closes on a click it took, the next two are one.
    const e = new ClickRun();
    expect([1, 2].map((n) => e.click('a', n))).toEqual([false, false]);
    e.reset();
    expect([4, 5].map((n) => e.click('a', n))).toEqual([false, true]);
    // Two clicks on two things, or not one after the other, are none.
    const f = new ClickRun();
    expect(f.click('a', 3)).toBe(false);
    expect(f.click('b', 4)).toBe(false);
    expect(f.click('b', 6)).toBe(false);
    expect(f.click('b', 1)).toBe(false);
  });
});
