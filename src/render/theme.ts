/**
 * The colours and font of the drawings. There is one look: black on white, the same on screen and in exports
 * (since 2026-11 the beige "Slides" theme is gone). Files saved with a `theme` still open; the field is ignored.
 */
export interface Theme {
  background: string;
  ink: string;
  wire: string;
  fill: string;
  pinFill: string;
  muted: string;
  accent: string;
  accentFill: string;
  /** The connection points the editor shows on the symbol under the pointer. */
  port: string;
  font: string;
}

export const THEME: Theme = {
  background: '#ffffff',
  ink: '#111111',
  wire: '#111111',
  fill: '#ffffff',
  pinFill: '#ffffff',
  muted: '#555555',
  accent: '#d9480f',
  accentFill: 'rgba(217, 72, 15, 0.12)',
  port: '#2f9e44',
  font: "'Helvetica Neue', Helvetica, Arial, 'Noto Sans TC', sans-serif",
};
