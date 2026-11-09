import { useEffect, useRef, useState } from 'react';
import type { LayoutResult } from '../layout/elk-layout';
import { downloadBlob, exportSvg, svgToPng } from '../render/export';
import { THEME } from '../render/theme';
import { useEscape } from './Dialogs';

interface Props {
  layout: LayoutResult;
  name: string;
  onClose(): void;
}

export function ExportDialog({ layout, name, onClose }: Props) {
  const [pngUrl, setPngUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const svg = exportSvg(layout, THEME);
  const box = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  // Focus moves into the dialog, off the button that opened it (Enter there would open it again).
  useEffect(() => box.current?.focus(), []);

  useEffect(() => {
    let url: string | undefined;
    let cancelled = false;
    svgToPng(svg, layout.width, layout.height, 2)
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setPngUrl(url);
      })
      .catch((e) => setMessage(String(e)));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [svg, layout.width, layout.height]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(svg);
      setMessage('SVG markup copied to the clipboard.');
    } catch {
      setMessage('The browser blocked clipboard access. Select the code below and copy it manually.');
    }
  };

  const copyPng = async () => {
    try {
      const blob = await svgToPng(svg, layout.width, layout.height, 2);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMessage('PNG image copied. Paste it into Word, PowerPoint or Google Slides.');
    } catch {
      setMessage('The browser blocked copying images. Right-click the preview and choose "Copy image" or "Save image as".');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Export ${name}`} tabIndex={-1} ref={box} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>Export {name}</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="preview" style={{ background: THEME.background }}>
          {pngUrl ? <img src={pngUrl} alt={`${name} diagram`} /> : <span className="muted">Rendering…</span>}
        </div>
        <div className="row">
          <button onClick={copyPng}>Copy PNG</button>
          <button onClick={copy}>Copy SVG</button>
          <button onClick={() => downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`)}>Download SVG</button>
          <button
            onClick={async () => downloadBlob(await svgToPng(svg, layout.width, layout.height, 3), `${name}.png`)}
          >
            Download PNG
          </button>
        </div>
        <p className="muted small">
          Inside the claude.ai preview, downloads may be blocked; use Copy, or right-click the preview image to save it.
          PDF export comes in a later phase.
        </p>
        {message && <p className="small">{message}</p>}
        <details>
          <summary className="small">SVG code</summary>
          <textarea readOnly value={svg} rows={6} />
        </details>
      </div>
    </div>
  );
}
