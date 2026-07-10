import { useState, useCallback } from 'react';
import Modal from '../ui/Modal.jsx';
import { PHOTO_PRESETS, getPreset, cyclePreset, buildPostcardStats, screenshotFilename } from '../../utils/cityPhotoMode';

// Photo-mode HUD overlay (roadmap 3.3). When photo mode is active it dims the rest of the HUD,
// draws cinematic letterbox bars, and offers preset framing controls + a capture button. Capture
// composites the live WebGL frame (grabbed via the page's `captureFn`) onto a postcard with a
// stats caption baked in, then offers it as a PNG download and an in-overlay preview. All the
// non-visual logic (presets, caption lines, filename) lives in the pure cityPhotoMode helper.

// Composite the raw screenshot data URL onto a postcard: the city image with a subtle vignette,
// a CYBERCITY title, and the stats caption along the bottom. Returns a PNG data URL. Runs on a
// 2D canvas so it's independent of the WebGL renderer. Resolves null if the image fails to load.
function composePostcard(dataUrl, statLines) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(img, 0, 0);

      // Bottom gradient scrim so the caption stays readable over a bright skyline.
      const scrimH = Math.max(110, img.height * 0.18);
      const grad = ctx.createLinearGradient(0, img.height - scrimH, 0, img.height);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.82)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, img.height - scrimH, img.width, scrimH);

      const pad = Math.round(img.width * 0.03);
      ctx.textBaseline = 'alphabetic';

      // Title
      ctx.fillStyle = '#06b6d4';
      ctx.font = `bold ${Math.round(img.height * 0.045)}px monospace`;
      ctx.fillText('CYBERCITY', pad, img.height - pad - Math.round(img.height * 0.04));

      // Stats caption — one line, separated by middots, right under the title.
      ctx.fillStyle = '#cbd5e1';
      ctx.font = `${Math.round(img.height * 0.026)}px monospace`;
      ctx.fillText(statLines.join('   ·   '), pad, img.height - pad);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function PresetControls({ presetId, onCycle }) {
  const preset = getPreset(presetId);
  return (
    <div className="flex items-center gap-3 pointer-events-auto">
      <button
        type="button"
        onClick={() => onCycle(-1)}
        className="font-pixel text-cyan-400 text-lg px-2 hover:text-cyan-300 transition-colors"
        title="Previous shot (←)"
      >‹</button>
      <div className="font-pixel text-[11px] text-cyan-300 tracking-widest w-32 text-center" style={{ textShadow: '0 0 8px rgba(6,182,212,0.5)' }}>
        {preset.label}
      </div>
      <button
        type="button"
        onClick={() => onCycle(1)}
        className="font-pixel text-cyan-400 text-lg px-2 hover:text-cyan-300 transition-colors"
        title="Next shot (→)"
      >›</button>
    </div>
  );
}

export default function CityPhotoOverlay({ active, presetId, onPresetChange, onExit, captureFnRef, statsSnapshot, dofEnabled = true, onToggleDof }) {
  const [postcard, setPostcard] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleCycle = useCallback((dir) => {
    onPresetChange(cyclePreset(presetId, dir));
  }, [presetId, onPresetChange]);

  const handleCapture = useCallback(async () => {
    // Read the capture fn from the ref at click time — the in-canvas camera populates it after
    // mount, so reading it now (not at render) guarantees the latest registered grabber.
    const captureFn = captureFnRef?.current;
    if (!captureFn || busy) return;
    setBusy(true);
    // Grab the raw frame, then composite the postcard off the WebGL thread.
    const raw = captureFn();
    const lines = buildPostcardStats(statsSnapshot);
    const card = raw ? await composePostcard(raw, lines) : null;
    setPostcard(card || raw);
    setBusy(false);
  }, [captureFnRef, busy, statsSnapshot]);

  const handleDownload = useCallback(() => {
    if (!postcard) return;
    // A detached anchor click is enough to trigger a data-URL download — no need to mount it.
    const a = document.createElement('a');
    a.href = postcard;
    a.download = screenshotFilename(new Date());
    a.click();
  }, [postcard]);

  if (!active) return null;

  return (
    <>
      {/* Cinematic letterbox bars */}
      <div className="absolute top-0 left-0 right-0 h-[10vh] bg-black pointer-events-none z-20 transition-all" />
      <div className="absolute bottom-0 left-0 right-0 h-[10vh] bg-black pointer-events-none z-20 transition-all" />

      {/* Top bar: title + exit */}
      <div className="absolute top-0 left-0 right-0 h-[10vh] flex items-center justify-between px-6 z-30">
        <div className="font-pixel text-[11px] text-cyan-500/70 tracking-widest pointer-events-none">
          PHOTO MODE
        </div>
        <button
          type="button"
          onClick={onExit}
          className="font-pixel text-[10px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-3 py-1.5 hover:bg-cyan-500/10 transition-all pointer-events-auto"
          title="Exit photo mode (Esc)"
        >
          [ EXIT ]
        </button>
      </div>

      {/* Bottom bar: preset cycle + DoF toggle + capture */}
      <div className="absolute bottom-0 left-0 right-0 h-[10vh] flex items-center justify-between px-6 z-30">
        <div className="flex items-center gap-4">
          <PresetControls presetId={presetId} onCycle={handleCycle} />
          {onToggleDof && (
            <button
              type="button"
              onClick={onToggleDof}
              aria-pressed={dofEnabled}
              className={`font-pixel text-[10px] tracking-wider rounded px-3 py-1.5 border transition-all pointer-events-auto ${
                dofEnabled
                  ? 'text-black bg-cyan-400 border-cyan-400 hover:bg-cyan-300'
                  : 'text-cyan-400 border-cyan-500/40 hover:bg-cyan-500/10'
              }`}
              title="Toggle depth of field (D)"
            >
              ◐ DEPTH {dofEnabled ? 'ON' : 'OFF'}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleCapture}
          disabled={busy}
          className="font-pixel text-[11px] text-black bg-cyan-400 tracking-wider rounded px-4 py-2 hover:bg-cyan-300 transition-all pointer-events-auto disabled:opacity-50"
          title="Capture a city postcard"
        >
          {busy ? 'CAPTURING…' : '◉ CAPTURE'}
        </button>
      </div>

      {/* Postcard preview modal — portaled so it escapes the pointer-events-none
          / z-indexed WebGL HUD stacking context and gets focus-trap + Esc from
          the shared Modal. */}
      <Modal
        open={!!postcard}
        onClose={() => setPostcard(null)}
        size="none"
        usePortal
        ariaLabel="City postcard preview"
        panelClassName="max-w-[80vw] max-h-[80vh] flex flex-col items-center gap-3"
      >
        <img src={postcard} alt="City postcard" className="max-w-full max-h-[68vh] rounded-lg border border-cyan-500/40 shadow-[0_0_30px_rgba(6,182,212,0.3)]" />
        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleDownload}
            className="font-pixel text-[11px] text-black bg-cyan-400 tracking-wider rounded px-4 py-2 hover:bg-cyan-300 transition-all"
          >
            ↓ SAVE POSTCARD
          </button>
          <button
            type="button"
            onClick={() => setPostcard(null)}
            className="font-pixel text-[11px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-4 py-2 hover:bg-cyan-500/10 transition-all"
          >
            CLOSE
          </button>
        </div>
      </Modal>
    </>
  );
}

export { PHOTO_PRESETS };
