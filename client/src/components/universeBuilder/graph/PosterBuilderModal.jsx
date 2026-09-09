/**
 * Infographic poster builder. The preview canvas and the 2× PNG download go
 * through the same `renderPoster` call, so what the user downloads is exactly
 * what they picked.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Image } from 'lucide-react';
import Modal from '../../ui/Modal';
import toast from '../../ui/Toast';
import { downloadBlob } from '../../../lib/downloadBlob';
import {
  POSTER_LAYOUTS, POSTER_SIZES, POSTER_THEMES, posterDimensions, renderPoster,
} from '../../../lib/universeGraphPoster';

const Segmented = ({ label, options, value, onChange, idPrefix }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">{label}</div>
    <div className="flex gap-1 bg-port-bg border border-port-border rounded-lg p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          id={`${idPrefix}-${option.id}`}
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`flex-1 px-2 py-1 rounded-md text-xs border ${
            value === option.id
              ? 'bg-port-accent/20 text-port-accent border-port-accent/30'
              : 'bg-transparent text-gray-400 border-transparent hover:text-white'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

export default function PosterBuilderModal({
  index, open, initialLayout, initialSubjectId, timeIndex, onClose,
}) {
  const canvasRef = useRef(null);
  const [layout, setLayout] = useState(initialLayout || 'roster');
  const [subjectId, setSubjectId] = useState(initialSubjectId || null);
  const [size, setSize] = useState('portrait');
  const [theme, setTheme] = useState('midnight');
  const [respectTime, setRespectTime] = useState(true);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { if (open && initialLayout) setLayout(initialLayout); }, [open, initialLayout]);
  useEffect(() => { if (open && initialSubjectId) setSubjectId(initialSubjectId); }, [open, initialSubjectId]);

  const characters = index.nodes.filter((n) => n.kind === 'character');
  const subject = subjectId || characters[0]?.id || null;
  const asOfIssue = respectTime ? timeIndex : null;
  const [W, H] = posterDimensions(size);

  const options = useCallback(() => ({
    index, layout, subjectId: subject, size, theme, asOfIssue,
  }), [index, layout, subject, size, theme, asOfIssue]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas) return;
    renderPoster(canvas, { ...options(), scale: 1 });
    // Fit the preview to the pane without re-rendering at a fractional scale.
    const maxW = (canvas.parentElement?.clientWidth || W / 2) - 8;
    const maxH = Math.max(200, window.innerHeight - 320);
    const factor = Math.min(maxW / W, maxH / H, 1);
    canvas.style.width = `${Math.round(W * factor)}px`;
    canvas.style.height = `${Math.round(H * factor)}px`;
  }, [open, options, W, H]);

  const download = () => {
    setDownloading(true);
    const canvas = document.createElement('canvas');
    renderPoster(canvas, { ...options(), scale: 2 });
    canvas.toBlob((blob) => {
      setDownloading(false);
      if (!blob) {
        toast.error('Could not render the poster — try a smaller size.');
        return;
      }
      const slug = String(index.name || 'universe').replace(/\W+/g, '-').toLowerCase();
      downloadBlob(blob, `${slug}-${layout}.png`);
    }, 'image/png');
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="3xl"
      ariaLabelledBy="poster-builder-title"
      panelClassName="overflow-hidden flex flex-col bg-port-card border border-port-border rounded-lg"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
        <h2 id="poster-builder-title" className="m-0 text-base font-semibold text-white flex items-center gap-2">
          <Image size={18} className="text-port-accent" /> Infographic poster
        </h2>
        <button type="button" onClick={onClose} className="text-gray-500 hover:text-white text-sm px-2 py-1">Close</button>
      </div>
      <div className="flex flex-col md:flex-row min-h-0 flex-1">
        <div className="w-full md:w-[280px] shrink-0 md:border-r border-port-border p-4 flex flex-col gap-3.5 overflow-y-auto">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">Layout</div>
            <div className="flex flex-col gap-1">
              {POSTER_LAYOUTS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setLayout(option.id)}
                  aria-pressed={layout === option.id}
                  className={`text-left px-2.5 py-2 rounded border ${
                    layout === option.id
                      ? 'bg-port-accent/15 text-white border-port-accent/40'
                      : 'bg-port-bg/60 text-gray-300 border-port-border'
                  }`}
                >
                  <span className="block text-[13px] leading-4">{option.label}</span>
                  <span className="block text-[11px] text-gray-500">{option.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {layout === 'dossier' && (
            <div>
              <label htmlFor="poster-subject" className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">Subject</label>
              <select
                id="poster-subject"
                value={subject || ''}
                onChange={(e) => setSubjectId(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm"
              >
                {characters.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
              </select>
            </div>
          )}

          <Segmented label="Size" options={POSTER_SIZES} value={size} onChange={setSize} idPrefix="poster-size" />
          <Segmented label="Paper" options={POSTER_THEMES} value={theme} onChange={setTheme} idPrefix="poster-theme" />

          <label htmlFor="poster-as-of" className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
            <input
              id="poster-as-of"
              type="checkbox"
              checked={respectTime}
              onChange={(e) => setRespectTime(e.target.checked)}
              className="accent-port-accent"
            />
            Respect timeline position
            {timeIndex != null && <span className="text-gray-500">({index.issues[timeIndex]?.name})</span>}
          </label>

          <p className="m-0 text-[11px] leading-4 text-gray-500">
            Rendered at 2× for print. Entries without a render show initials.
          </p>

          <button
            type="button"
            onClick={download}
            disabled={downloading}
            className="px-3 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center justify-center gap-2 min-h-[40px] text-sm"
          >
            <Download size={16} /> Download PNG · {W * 2}×{H * 2}
          </button>
        </div>
        <div className="flex-1 min-w-0 bg-port-bg p-4 md:p-6 flex items-start justify-center overflow-auto">
          <canvas ref={canvasRef} className="block border border-port-border" />
        </div>
      </div>
    </Modal>
  );
}
