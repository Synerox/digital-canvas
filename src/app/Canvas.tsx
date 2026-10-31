import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutResult } from '../layout/elk-layout';
import { DiagramGraphic } from '../render/DiagramGraphic';
import type { Theme } from '../render/theme';

interface View {
  x: number;
  y: number;
  k: number;
}

interface Props {
  layout: LayoutResult;
  theme: Theme;
  selected?: string;
  highlighted: ReadonlySet<string>;
  onSelect(id: string | undefined): void;
  onOpen(id: string): void;
}

function nodeIdFrom(target: EventTarget | null): string | undefined {
  let el = target as Element | null;
  while (el && el instanceof Element) {
    const id = el.getAttribute('data-node-id');
    if (id) return id;
    el = el.parentElement;
  }
  return undefined;
}

export function Canvas({ layout, theme, selected, highlighted, onSelect, onOpen }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const { clientWidth: W, clientHeight: H } = el;
    const k = Math.min(2, Math.max(0.1, Math.min(W / (layout.width + 40), H / (layout.height + 40))));
    setView({ k, x: (W - layout.width * k) / 2, y: (H - layout.height * k) / 2 });
  }, [layout]);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
        const k = Math.min(8, Math.max(0.05, v.k * factor));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={wrap}
      className="canvas"
      style={{ background: theme.background }}
      onPointerDown={(ev) => {
        if (ev.button !== 0) return;
        drag.current = { sx: ev.clientX, sy: ev.clientY, vx: view.x, vy: view.y, moved: false };
        (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
      }}
      onPointerMove={(ev) => {
        const d = drag.current;
        if (!d) return;
        const dx = ev.clientX - d.sx;
        const dy = ev.clientY - d.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (d.moved) setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      }}
      onPointerUp={(ev) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          // Pointer capture retargets events; find what is under the pointer.
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          onSelect(nodeIdFrom(under));
        }
      }}
      onDoubleClick={(ev) => {
        // Pointer capture retargets the event to the canvas; look up what is under the pointer.
        const id = nodeIdFrom(document.elementFromPoint(ev.clientX, ev.clientY));
        if (id) onOpen(id);
      }}
    >
      <svg width="100%" height="100%">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <DiagramGraphic layout={layout} theme={theme} selected={selected} highlighted={highlighted} interactive />
        </g>
      </svg>
      <div className="zoom-controls" onPointerDown={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}>
        <button onClick={() => setView((v) => ({ ...v, k: v.k * 1.25 }))} title="Zoom in">
          +
        </button>
        <button onClick={() => setView((v) => ({ ...v, k: v.k / 1.25 }))} title="Zoom out">
          −
        </button>
        <button onClick={fit} title="Fit to view">
          ⤢
        </button>
      </div>
    </div>
  );
}
