/**
 * Double-clicks the browser does not report. It counts the clicks of a run (close in time and place) on and on,
 * also those a window took (the JSON window keeps clicks on its own symbol), and sends a dblclick only for the
 * 2nd: after the window closes, the 4th and 5th click of the run are a double-click to the user, but no dblclick.
 * ClickRun sees the clicks an element itself gets: two in a row, past the 2nd of the browser's run, are one.
 */
export class ClickRun {
  private last?: { key: string; detail: number; run: number };

  /**
   * Count a click on `key` (what was clicked), `detail` being the browser's count (MouseEvent.detail). True when it
   * ends a double-click that has no dblclick (the browser sends one for the 2nd click of its run).
   */
  click(key: string, detail: number): boolean {
    const prev = this.last;
    const run = prev && prev.key === key && detail > 1 && prev.detail === detail - 1 ? prev.run + 1 : 1;
    this.last = { key, detail, run };
    return run === 2 && detail > 2;
  }

  /** Start over: the next two clicks are a double-click (after one opened a window, which takes the clicks after it). */
  reset(): void {
    this.last = undefined;
  }
}
