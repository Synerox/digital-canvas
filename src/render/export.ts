import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LayoutResult, MeasureText } from '../layout/elk-layout';
import { approxMeasure } from '../layout/elk-layout';
import { DiagramGraphic } from './DiagramGraphic';
import type { Theme } from './theme';

/** Standalone SVG document for a laid-out diagram. */
export function exportSvg(layout: LayoutResult, theme: Theme): string {
  const inner = renderToStaticMarkup(createElement(DiagramGraphic, { layout, theme }));
  const w = Math.ceil(layout.width);
  const h = Math.ceil(layout.height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="${theme.background}"/>` +
    inner +
    `</svg>`
  );
}

/** Rasterize an SVG string to a PNG blob at the given scale. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not render SVG'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Text measurement with a real canvas when available. */
export function canvasMeasure(fontFamily: string): MeasureText {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return approxMeasure;
  const cache = new Map<string, number>();
  return (text, size, bold) => {
    const key = `${size}|${bold ? 1 : 0}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      ctx!.font = `${bold ? 'bold ' : ''}${size}px ${fontFamily}`;
      w = ctx!.measureText(text).width;
      cache.set(key, w);
    }
    return w;
  };
}
