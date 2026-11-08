/**
 * Small UI events between panels that do not share state:
 * `rename` (detail: item ID) focuses the name field in Properties,
 * `fit` fits the drawing to the canvas, `focus-library` focuses the library search,
 * `paste` pastes what Copy took where the user looks (the canvas knows its view: see paste in the store),
 * `edit-settings` (detail: SettingsRequest) opens the JSON window of a symbol or component (see settings).
 */
export const ui = new EventTarget();
