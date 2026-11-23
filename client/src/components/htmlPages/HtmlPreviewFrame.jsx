import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import Modal from '../ui/Modal';
import { previewDocument } from '../../lib/htmlPreviewDoc.js';

// Pages are laid out at a desktop viewport and scaled down to the frame, so a
// thumbnail shows the whole composition rather than the top-left corner of it.
const VIEWPORT_W = 1280;
const VIEWPORT_H = 800;

/**
 * One generated page in an opaque-origin sandbox with a policy restricting resource loads.
 */
export default function HtmlPreviewFrame({ html, title }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const srcDoc = useMemo(() => (html ? previewDocument(html) : ''), [html]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!html) {
    return (
      <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-port-border bg-port-bg text-xs text-gray-500">
        No HTML came back for this page
      </div>
    );
  }

  const scale = width > 0 ? width / VIEWPORT_W : 0;
  return (
    <>
      <div ref={wrapRef} className="relative w-full overflow-hidden rounded-lg border border-port-border bg-white" style={{ height: scale ? VIEWPORT_H * scale : undefined, aspectRatio: scale ? undefined : '16 / 10' }}>
        {scale > 0 && (
          <iframe
            title={title}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            srcDoc={srcDoc}
            className="absolute left-0 top-0 origin-top-left border-0"
            style={{ width: VIEWPORT_W, height: VIEWPORT_H, transform: `scale(${scale})` }}
          />
        )}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Open ${title} full size`}
          className="absolute right-2 top-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border bg-port-card/90 text-gray-200 hover:border-port-accent hover:text-white"
        >
          <Maximize2 size={14} />
        </button>
      </div>
      {expanded && (
        <Modal open onClose={() => setExpanded(false)} size="3xl" usePortal ariaLabel={`${title} full size`}>
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-sm font-medium text-white">{title}</h3>
              <button type="button" onClick={() => setExpanded(false)} className="min-h-[44px] rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-accent">Close</button>
            </div>
            <iframe title={`${title} (full size)`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} className="h-[70vh] w-full rounded-lg border border-port-border bg-white" />
          </div>
        </Modal>
      )}
    </>
  );
}
