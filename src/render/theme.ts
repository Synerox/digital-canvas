export type ThemeName = 'report' | 'slides';

export interface Theme {
  name: ThemeName;
  label: string;
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

const FONT = "'Helvetica Neue', Helvetica, Arial, 'Noto Sans TC', sans-serif";

export const THEMES: Record<ThemeName, Theme> = {
  report: {
    name: 'report',
    label: 'Report (white)',
    background: '#ffffff',
    ink: '#111111',
    wire: '#111111',
    fill: '#ffffff',
    pinFill: '#ffffff',
    muted: '#555555',
    accent: '#d9480f',
    accentFill: 'rgba(217, 72, 15, 0.12)',
    port: '#2f9e44',
    font: FONT,
  },
  slides: {
    name: 'slides',
    label: 'Slides (beige)',
    background: '#f5efe0',
    ink: '#2f261c',
    wire: '#2f261c',
    fill: '#fbf7ec',
    pinFill: '#fbf7ec',
    muted: '#6b5d4c',
    accent: '#b4441b',
    accentFill: 'rgba(180, 68, 27, 0.14)',
    port: '#2b8a3e',
    font: FONT,
  },
};
