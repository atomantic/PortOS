import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Scissors, Play, Pause, ChevronLeft, ChevronRight, Save, CheckCheck, FlipHorizontal2,
} from 'lucide-react';
import toast from '../ui/Toast';
import { trimSpriteWalk } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { spriteAssetUrl, checkerboardStyle, PIXELATED } from './spriteAssets.js';
import SpritePreview from './SpritePreview.jsx';
import {
  buildTrimmerSources, allColumns, invertColumns, phaseLabelFor, sanitizeTrimSlug,
} from '../../lib/spriteTrimmer.js';

// Loop Trimmer workspace (#2933): the deep-linkable (`?spriteTab=trimmer&run=…`)
// replacement for WalkWorkflow's old inline 8-checkbox TrimPanel. It brings the
// source Sprite Manager's feature set to the browser — pick an animation source,
// scrub/play the loop on a checkerboarded canvas, toggle individual frames, tune
// fps, name the output, and save through the existing
// `POST /api/sprites/:id/walk/trim`. Every packed-strip run is trimmable (any
// layout); previously saved trims load read-only for review.

// CSS display width of the main playback preview. There is deliberately no
// thumbnail counterpart: thumbnails size themselves off the grid column
// (`w-full`), and since #2977 no frame's canvas is sized in display px at all.
const MAIN_PX = 192;

// One frame of a packed strip, painted at SOURCE resolution (#2977).
//
// The backing store is the cell's own pixel size (384² for a native walk),
// never the display size — `drawImage` copies the cell 1:1 so JS never
// resamples, and CSS alone scales it down to the thumbnail/preview box. The
// earlier version sized the canvas at THUMB_PX/MAIN_PX, which decimated 384→64
// nearest-neighbor and then let the browser smooth-upscale that back to the
// grid column: the "fuzzy / compressed" look this replaces.
//
// Following SpritePreview's rule, the checkerboard goes on the BOX (a CSS
// background at a constant on-screen cell size) rather than into the canvas —
// painted into a 384px backing store its squares would shrink with the scale
// factor — and the canvas carries the shared PIXELATED style so the browser's
// scale stays nearest-neighbor like every other sprite surface.
// `checkerCell` is the checkerboard square size in CSS px — larger for the main
// preview, smaller so the pattern stays legible in a thumbnail.
function FrameCanvas({ img, col, cellW, cellH, checkerCell = 5 }) {
  const ref = useRef(null);
  // Natural cell geometry, rounded to whole pixels for the backing store. Zero
  // until the strip <img> loads.
  const w = cellW > 0 ? Math.max(1, Math.round(cellW)) : 0;
  const h = cellH > 0 ? Math.max(1, Math.round(cellH)) : 0;
  const ready = w > 0 && h > 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !img || !ready) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / context-less canvas
    // The canvas is transparent now that the checkerboard moved to the box, so
    // a frame swap must clear before drawing or the previous cell shows
    // through this one's alpha.
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, col * cellW, 0, cellW, cellH, 0, 0, w, h);
  }, [img, col, cellW, cellH, w, h, ready]);

  // The box holds the frame's aspect whether or not the strip has loaded, so
  // the grid doesn't collapse to zero height and then reflow on load.
  return (
    <div
      className="w-full block overflow-hidden"
      style={{
        ...checkerboardStyle(checkerCell),
        aspectRatio: ready ? `${w} / ${h}` : '1 / 1',
      }}
    >
      {ready && (
        <canvas ref={ref} width={w} height={h} className="w-full h-auto block" style={PIXELATED} />
      )}
    </div>
  );
}

export default function LoopTrimmer({
  record, walk, assets, runId = null, onSelectRun = () => {}, onSaved = () => {},
}) {
  const recordId = record.id;
  const sources = useMemo(() => buildTrimmerSources(walk, assets), [walk, assets]);

  const [selectedId, setSelectedId] = useState(null);
  const source = sources.find((s) => s.id === selectedId) || null;

  // Sync the selection from the `?run=` deep link, and keep it valid as the
  // source list (re)loads: a deep-linked run wins, otherwise keep the current
  // pick if it still exists, else fall back to the first source.
  useEffect(() => {
    const fromRun = runId ? sources.find((s) => s.kind === 'run' && s.runId === runId) : null;
    if (fromRun) { setSelectedId(fromRun.id); return; }
    setSelectedId((prev) => (sources.some((s) => s.id === prev) ? prev : (sources[0]?.id ?? null)));
  }, [runId, sources]);

  const frameCount = source?.frameCount || 0;

  const [enabled, setEnabled] = useState(() => new Set());
  const [frameIndex, setFrameIndex] = useState(0);
  // Auto-play by default: the trimmer is conditionally mounted when its tab
  // becomes active (#2933), so "mounts" == "tab activated" — starting playback
  // here means the loop preview animates the moment the user opens the tab,
  // without a manual Play click. The playback effect below no-ops until the
  // enabled-frame set is seeded, so there's nothing to animate before then.
  const [playing, setPlaying] = useState(true);
  const [fps, setFps] = useState(12);
  const [outputName, setOutputName] = useState('');
  const [result, setResult] = useState(null);
  const [img, setImg] = useState(null);

  // Re-seed everything the moment the source changes — a stale enabled set from
  // a previous strip could hold out-of-range indices and 400 the endpoint.
  // Playback re-arms (true) rather than stopping so switching the animation
  // source keeps the preview live, consistent with the auto-play-on-open above.
  useEffect(() => {
    setEnabled(new Set(allColumns(frameCount)));
    setFrameIndex(0);
    setPlaying(true);
    setResult(null);
    setOutputName('');
    setFps(source?.fps || 12);
  }, [source?.id, frameCount, source?.fps]);

  // Load the strip PNG; cell geometry is derived from its natural size so a run
  // without cellWidth in its preview — and every saved-trim strip — still slices.
  useEffect(() => {
    setImg(null);
    if (!source) return undefined;
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = spriteAssetUrl(recordId, source.stripPath);
    return () => { image.onload = null; };
  }, [source?.id, source?.stripPath, recordId]);

  const cellW = img && frameCount > 0 ? img.naturalWidth / frameCount : 0;
  const cellH = img ? img.naturalHeight : 0;

  // Playback cycles the ENABLED frames in order (that IS the trimmed loop).
  useEffect(() => {
    if (!playing) return undefined;
    const cols = [...enabled].sort((a, b) => a - b);
    if (cols.length < 1) return undefined;
    const timer = setInterval(() => {
      setFrameIndex((prev) => {
        const at = cols.indexOf(prev);
        return at === -1 ? cols[0] : cols[(at + 1) % cols.length];
      });
    }, Math.max(1000 / (fps || 12), 40));
    return () => clearInterval(timer);
  }, [playing, enabled, fps]);

  const toggle = useCallback((i) => setEnabled((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  }), []);
  const enableAll = () => setEnabled(new Set(allColumns(frameCount)));
  const invert = () => setEnabled(new Set(invertColumns(frameCount, [...enabled])));
  const step = (delta) => {
    if (frameCount < 1) return;
    setPlaying(false);
    setFrameIndex((prev) => (prev + delta + frameCount) % frameCount);
  };

  const slug = sanitizeTrimSlug(outputName);
  const [save, saving] = useAsyncAction(async () => {
    const trim = await trimSpriteWalk(recordId, {
      runId: source.runId,
      enabledColumns: [...enabled].sort((a, b) => a - b),
      fps,
      ...(slug ? { slug } : {}),
    }, { silent: true });
    setResult(trim);
    toast.success(`Trim saved (${trim.frameCount} frames)`);
    onSaved();
  }, { errorMessage: 'Trim failed' });

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white';

  if (sources.length === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5 mb-2">
          <Scissors className="w-4 h-4" /> Loop Trimmer
        </h3>
        <p className="text-sm text-gray-500">
          No animation strips to trim yet. Generate a walk cycle first, then return here to trim its loop.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
        <Scissors className="w-4 h-4" /> Loop Trimmer
      </h3>

      {/* Source + fps + output name */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="trimmer-source" className="block text-xs text-gray-400 mb-1">Animation source</label>
          <select
            id="trimmer-source"
            value={selectedId || ''}
            onChange={(e) => {
              const next = sources.find((s) => s.id === e.target.value) || null;
              setSelectedId(e.target.value);
              onSelectRun(next?.kind === 'run' ? next.runId : null);
            }}
            className={inputCls}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}{s.trimmable ? '' : ' (read-only)'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="trimmer-output" className="block text-xs text-gray-400 mb-1">
            Output name <span className="text-gray-600">([a-z0-9-])</span>
          </label>
          <input
            id="trimmer-output"
            type="text"
            value={outputName}
            onChange={(e) => setOutputName(e.target.value)}
            pattern="[a-z0-9-]+"
            placeholder={source?.direction ? `${source.direction}-loop` : 'east-loop'}
            className={inputCls}
          />
          <p className="mt-1 text-[11px] text-gray-500">
            saves as <code className="text-gray-400">{slug || `${source?.direction || 'east'}-loop`}</code>
            <span className="text-gray-600">-vNNN</span>
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="trimmer-fps" className="flex items-center justify-between text-xs text-gray-400 mb-1">
          <span>Playback / output fps</span>
          <span className="text-gray-300 tabular-nums">{fps} fps</span>
        </label>
        <input
          id="trimmer-fps"
          type="range"
          min="1"
          max="24"
          value={fps}
          onChange={(e) => setFps(Number(e.target.value))}
          className="w-full accent-port-accent"
        />
      </div>

      {/* Canvas playback */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="shrink-0">
          <div
            className="border border-port-border rounded overflow-hidden mx-auto"
            style={{ width: MAIN_PX, maxWidth: '100%' }}
          >
            <FrameCanvas img={img} col={frameIndex} cellW={cellW} cellH={cellH} checkerCell={8} />
          </div>
          <div className="flex items-center justify-center gap-2 mt-2">
            <button
              onClick={() => step(-1)}
              aria-label="Previous frame"
              className="p-1.5 bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause' : 'Play'}
              className="p-1.5 bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              onClick={() => step(1)}
              aria-label="Next frame"
              className="p-1.5 bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <p className="text-center text-[11px] text-gray-500 mt-1">
            frame {frameIndex} · {phaseLabelFor(frameIndex, frameCount)}
            {!enabled.has(frameIndex) && <span className="text-port-warning"> · disabled</span>}
          </p>
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <label htmlFor="trimmer-scrub" className="block text-xs text-gray-400 mb-1">Scrub</label>
            <input
              id="trimmer-scrub"
              type="range"
              min="0"
              max={Math.max(0, frameCount - 1)}
              value={frameIndex}
              onChange={(e) => { setPlaying(false); setFrameIndex(Number(e.target.value)); }}
              className="w-full accent-port-accent"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={enableAll}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              <CheckCheck className="w-3.5 h-3.5" /> Enable all
            </button>
            <button
              onClick={invert}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent"
            >
              <FlipHorizontal2 className="w-3.5 h-3.5" /> Invert
            </button>
            <span className="text-xs text-gray-500">{enabled.size}/{frameCount} frames enabled</span>
          </div>

          {/* Per-frame toggles */}
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {allColumns(frameCount).map((i) => {
              const on = enabled.has(i);
              const active = i === frameIndex;
              return (
                <button
                  key={i}
                  onClick={() => toggle(i)}
                  aria-pressed={on}
                  title={`${phaseLabelFor(i, frameCount)} — ${on ? 'enabled' : 'disabled'}`}
                  className={`rounded overflow-hidden border transition-colors ${
                    active ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border hover:border-gray-500'
                  } ${on ? '' : 'opacity-40 grayscale'}`}
                >
                  <FrameCanvas img={img} col={i} cellW={cellW} cellH={cellH} />
                  <span className="block text-center text-[10px] text-gray-500 py-0.5">{i}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Save + result */}
      <div className="flex flex-wrap items-center gap-3 border-t border-port-border pt-3">
        <button
          onClick={save}
          disabled={saving || !source?.trimmable || enabled.size < 2}
          title={!source?.trimmable
            ? 'This source is read-only — pick a packaged walk run to save a new trim'
            : enabled.size < 2 ? 'Keep at least 2 frames' : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
        >
          <Save className="w-4 h-4" /> {saving ? 'Saving…' : `Save trim (${enabled.size}/${frameCount})`}
        </button>
        {!source?.trimmable && (
          <p className="text-xs text-gray-500">Read-only source — loaded for review; pick a packaged run to trim.</p>
        )}
      </div>

      {result && (
        <div className="flex items-start gap-3 bg-port-bg border border-port-border rounded p-3">
          <SpritePreview
            recordId={recordId}
            path={result.loop}
            alt="trimmed loop"
            className="w-24 h-24 shrink-0 border border-port-border rounded"
          />
          <div className="min-w-0 text-[11px] text-gray-400 space-y-1">
            <p className="text-port-success">Saved {result.frameCount} frames ({result.disabledFrameCount} dropped).</p>
            <p className="break-all"><span className="text-gray-600">strip </span>{result.strip}</p>
            <p className="break-all"><span className="text-gray-600">gif </span>{result.loop}</p>
            <p className="break-all"><span className="text-gray-600">manifest </span>{result.manifest}</p>
          </div>
        </div>
      )}
    </div>
  );
}
