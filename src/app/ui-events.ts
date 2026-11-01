/**
 * Small UI events between panels that do not share state:
 * `rename` (detail: item ID) focuses the name field in Properties,
 * `fit` fits the drawing to the canvas, `focus-library` focuses the library search.
 */
export const ui = new EventTarget();
