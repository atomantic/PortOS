/**
 * Media settings — the install-wide routing sections: the Backend tile
 * picker and the Defaults tab (default video backend, display sleep, the
 * write-only fal.ai / reactor.inc keys, and the per-surface render-default
 * pins). Reads and writes the shared `useSettingsForm` the Media drawer owns.
 */

import { useState } from 'react';
import { Save, Image as ImageIcon, Cloud, Cpu, AlertTriangle, Sparkles, Terminal, Check, Trash2, SlidersHorizontal } from 'lucide-react';
import FormField from '../ui/FormField';
import BrailleSpinner from '../BrailleSpinner';
import FalModelSelect from '../imageGen/FalModelSelect';
import {
  IMAGE_GEN_MODE, RENDER_TARGET_BACKEND_AUTO, RENDER_TARGET_OPTIONS, VIDEO_RENDER_MODES, modeLabel,
  normalizeRenderPinValue, supportsCloudModelOverride,
} from '../../lib/imageGenBackends';

const SECTION_CLASS = 'bg-port-card border border-port-border rounded-xl p-6 space-y-4';
const SELECT_CLASS = 'bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

const BACKEND_TILES = [
  { mode: IMAGE_GEN_MODE.EXTERNAL, icon: Cloud, label: 'External SD API', blurb: 'Forward to a remote AUTOMATIC1111 / Forge server (e.g. another tailnet box).' },
  { mode: IMAGE_GEN_MODE.LOCAL, icon: Cpu, label: 'Local models', blurb: 'Run image and video models on this machine. Apple Silicon enables MLX models such as FastMetal.' },
  { mode: IMAGE_GEN_MODE.CODEX, icon: Terminal, label: 'Codex CLI', blurb: 'Route through the Codex CLI built-in image_gen tool. Counts against your Codex plan.', enabledKey: 'codexEnabled' },
  { mode: IMAGE_GEN_MODE.GROK, icon: Sparkles, label: 'Grok CLI', blurb: 'Route through the Grok Build CLI built-in image_gen tool. Counts against your Grok plan.', enabledKey: 'grokEnabled' },
  { mode: IMAGE_GEN_MODE.AGY, icon: Terminal, label: 'Agy CLI', blurb: "Text-to-image through Antigravity's generate_image tool and your selected model.", enabledKey: 'agyEnabled' },
  { mode: IMAGE_GEN_MODE.FAL, icon: Sparkles, label: 'fal.ai', blurb: "Hosted image and reference-edit models through fal.ai's API. Billed per image to your fal.ai account.", enabledKey: 'falEnabled' },
];

// fal.ai / reactor.inc video keys (#6213/#6214) — write-only since #8997:
// the raw key never appears in a settings GET. Presence + source come from
// the shared credential inventory; saves/clears go through the write-only
// credential setter, never through the Media save.
const VIDEO_KEY_ROWS = [
  {
    id: 'fal', label: 'fal.ai API key', placeholder: 'fal-key-...', envLabel: 'FAL_KEY',
    hint: 'Enables the fal.ai queue video backend on the Video Gen page and in FableLoom, and the fal.ai image backend (fal.ai tab). Get a key at fal.ai/dashboard/keys, or set the FAL_KEY environment variable instead.',
    missing: 'No fal.ai key configured — the fal.ai video and image backends will be unavailable.',
  },
  {
    id: 'reactor', label: 'reactor.inc API key', placeholder: 'reactor-key-...', envLabel: 'REACTOR_API_KEY',
    hint: 'Enables the reactor.inc fast-h3 video backend on the Video Gen page and in FableLoom, or set the REACTOR_API_KEY environment variable instead.',
    missing: 'No reactor.inc key configured — the reactor.inc video backend will be unavailable.',
  },
];

function VideoKeyRow({ row, spec, busy, onSave, onClear }) {
  const [input, setInput] = useState('');
  const save = () => onSave(spec.id, input).then((ok) => { if (ok) setInput(''); });
  return (
    <div className="space-y-2 border border-port-border rounded-lg p-3">
      <div className="text-sm text-gray-300">
        {spec.label}
        <span className="block text-xs text-gray-500 mt-0.5">{spec.hint}</span>
      </div>
      {row == null ? (
        <div className="text-xs text-gray-500"><BrailleSpinner text="Checking key status" /></div>
      ) : row.configured ? (
        <div className="flex items-center gap-2 text-xs text-port-success">
          <Check size={14} />
          <span>
            Key configured
            {row.source === 'env' && ` (from ${spec.envLabel} environment variable)`}
            {row.source === 'settings' && ' (stored privately on this install)'}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-port-warning">
          <AlertTriangle size={14} />
          <span>{spec.missing}</span>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-2 items-end">
        <FormField label={row?.source === 'settings' ? 'Replace stored key' : 'Paste a key'} labelClassName="block text-xs font-medium text-gray-400 mb-1" className="flex-1 w-full">
          <input
            id={`${spec.id}-api-key`}
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            disabled={busy !== null}
            placeholder={spec.placeholder}
            autoComplete="off"
            className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          />
        </FormField>
        <button
          type="button"
          onClick={save}
          disabled={busy !== null || !input.trim()}
          className="whitespace-nowrap inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-port-accent text-white text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 min-h-[40px]"
        >
          {busy === `${spec.id}-saving` ? <BrailleSpinner /> : <Save size={14} />}
          Save key
        </button>
      </div>
      {row?.source === 'settings' && (
        <button
          type="button"
          onClick={() => onClear(spec.id)}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-border text-gray-300 text-xs font-medium hover:bg-port-error/20 hover:text-port-error disabled:opacity-50"
        >
          {busy === `${spec.id}-clearing` ? <BrailleSpinner /> : <Trash2 size={12} />}
          Clear stored key
        </button>
      )}
    </div>
  );
}

export default function ImageGenBackendSections({ mediaTab, form, credentials }) {
  const { values, set } = form;
  const { mode, renderDefaults, videoGenMode, videoGenDisplaySleep } = values;
  const tiles = BACKEND_TILES.filter((tile) => !tile.enabledKey || values[tile.enabledKey]);
  return (
    <>
      {mediaTab === 'backend' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <ImageIcon size={18} />
          <h2 className="text-lg font-semibold">Backend</h2>
        </div>
        <p className="text-xs text-gray-500">
          PortOS can either talk to a remote AUTOMATIC1111 / Forge server or run image
          generation with local Python runtimes, including mflux and diffusers. You can also
          expose this PortOS as an A1111-compatible endpoint for other tailnet boxes.
        </p>
        <div className={`grid grid-cols-1 sm:grid-cols-2 ${tiles.length > 2 ? 'lg:grid-cols-3' : ''} gap-3`}>
          {tiles.map(({ mode: tileMode, icon: Icon, label, blurb }) => (
            <button
              key={tileMode}
              type="button"
              onClick={() => set('mode', tileMode)}
              className={`text-left p-4 rounded-lg border transition-colors ${mode === tileMode ? 'border-port-accent bg-port-accent/10 text-white' : 'border-port-border text-gray-400 hover:bg-port-border/30 hover:text-white'}`}
            >
              <div className="flex items-center gap-2">
                <Icon className="w-4 h-4" />
                <span className="font-medium text-sm">{label}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">{blurb}</p>
            </button>
          ))}
        </div>
      </div>
      )}

      {/* Per-surface render defaults (#3231) — pin a backend (and, for the
          model-override-capable cloud CLIs, a model) per creative surface,
          without touching the install-wide default above. */}
      {mediaTab === 'defaults' && (
      <div className={SECTION_CLASS}>
        <div className="flex items-center gap-2 text-white">
          <SlidersHorizontal size={18} />
          <h2 className="text-lg font-semibold">Render defaults</h2>
        </div>
        <p className="text-xs text-gray-500">
          Each surface below follows the install default backend unless pinned here. A pinned
          backend that is disabled (or unconfigured) falls back to whatever that surface would
          have used anyway — enable the backend on its own tab to make a pin take effect. A
          model can be pinned for backends that accept one (Codex, Agy, fal.ai); Grok and Local pick
          their models elsewhere. Surfaces that also render video get a video backend pin.
          The default local video model is set on the Local tab, and a render's explicit model
          choice takes precedence.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 sm:items-center border border-port-border rounded-lg px-3 py-2 bg-port-bg/40">
          <FormField
            label={<>Default video backend<span className="block text-xs text-gray-500 mt-0.5">Used when a video render names no backend and its surface has no pin. Grok clips render at 6, 10 or 15 seconds on xAI&rsquo;s fixed video backend.</span></>}
            labelClassName="text-sm text-gray-300"
            className="contents"
          >
            <select
              id="video-default-mode"
              value={videoGenMode}
              onChange={(e) => set('videoGenMode', e.target.value)}
              className={`${SELECT_CLASS} sm:w-44`}
            >
              <option value="">Auto (Local)</option>
              {VIDEO_RENDER_MODES.map((m) => (
                <option key={m} value={m}>{modeLabel(m)}</option>
              ))}
            </select>
          </FormField>
        </div>
        <label className="flex items-start gap-3 border border-port-border rounded-lg px-3 py-3 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={videoGenDisplaySleep}
            onChange={(e) => set('videoGenDisplaySleep', e.target.checked)}
            className="mt-0.5 accent-port-accent"
          />
          <span>
            <span className="block font-medium text-white">Sleep display during local MLX video renders</span>
            <span className="block text-xs text-gray-500 mt-0.5">Off by default. Keeps the system awake while putting the screen to sleep, which reduces WindowServer GPU contention on affected Apple silicon. Turn on only if you hit the GPU-watchdog crash during a render — this is also settable per-render on the Video Gen page.</span>
          </span>
        </label>
        {VIDEO_KEY_ROWS.map((spec) => (
          <VideoKeyRow key={spec.id} spec={spec} row={credentials.rows[spec.id]} busy={credentials.busy} onSave={credentials.save} onClear={credentials.clear} />
        ))}
        <div className="space-y-3">
          {RENDER_TARGET_OPTIONS.map(({ id, label, video }) => {
            const entry = renderDefaults[id] || {};
            const pinnedMode = entry.imageMode && entry.imageMode !== RENDER_TARGET_BACKEND_AUTO ? entry.imageMode : '';
            const pinnedVideoMode = normalizeRenderPinValue(entry.videoMode) || '';
            const modeSelectId = `render-default-mode-${id}`;
            const modelInputId = `render-default-model-${id}`;
            const videoSelectId = `render-default-video-${id}`;
            const setPin = (key, value) => set('renderDefaults', (rd) => {
              const nextEntry = { ...(rd[id] || {}) };
              if (value) nextEntry[key] = value; else delete nextEntry[key];
              const next = { ...rd };
              if (Object.keys(nextEntry).length) next[id] = nextEntry; else delete next[id];
              return next;
            });
            return (
              <div key={id} className={`grid grid-cols-1 ${video ? 'sm:grid-cols-[1fr_auto_auto_auto]' : 'sm:grid-cols-[1fr_auto_auto]'} gap-2 sm:items-center border border-port-border rounded-lg px-3 py-2`}>
                <FormField label={label} labelClassName="text-sm text-gray-300" className="contents">
                  <select
                    id={modeSelectId}
                    value={pinnedMode}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPin('imageMode', v || null);
                      // ANY backend change invalidates the pinned model — model ids
                      // are namespaced per provider, and a codex→agy switch that
                      // kept the gpt-* id would save a pin agy errors on. The
                      // server's leak guard can't catch this case (mode and model
                      // are pinned together), so the clear must happen here.
                      setPin('imageModel', null);
                    }}
                    className={`${SELECT_CLASS} sm:w-44`}
                  >
                    <option value="">Auto (install default)</option>
                    {[IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY, IMAGE_GEN_MODE.FAL].map((m) => (
                      <option key={m} value={m}>{modeLabel(m)}</option>
                    ))}
                  </select>
                </FormField>
                {pinnedMode === IMAGE_GEN_MODE.FAL ? (
                  <FormField label={`${label} model`} labelClassName="sr-only" className="contents">
                    <FalModelSelect
                      id={modelInputId}
                      value={entry.imageModel || ''}
                      onChange={(v) => setPin('imageModel', v)}
                      defaultLabel="Model: fal.ai default"
                      className={`${SELECT_CLASS} sm:w-52`}
                    />
                  </FormField>
                ) : supportsCloudModelOverride(pinnedMode) ? (
                  <FormField label={`${label} model`} labelClassName="sr-only" className="contents">
                    <input
                      id={modelInputId}
                      type="text"
                      value={entry.imageModel || ''}
                      onChange={(e) => setPin('imageModel', e.target.value.trim() || null)}
                      placeholder="Model (optional)"
                      aria-label={`${label} model`}
                      className={`${SELECT_CLASS} sm:w-52`}
                    />
                  </FormField>
                ) : <span className="hidden sm:block sm:w-52" />}
                {video && (
                  <FormField label={`${label} video backend`} labelClassName="sr-only" className="contents">
                    <select
                      id={videoSelectId}
                      value={pinnedVideoMode}
                      onChange={(e) => setPin('videoMode', e.target.value || null)}
                      aria-label={`${label} video backend`}
                      title="Video backend for this surface — no model choice (Grok video has none; local video models are picked on the surface)"
                      className={`${SELECT_CLASS} sm:w-44`}
                    >
                      <option value="">Video: Auto</option>
                      {VIDEO_RENDER_MODES.map((m) => (
                        <option key={m} value={m}>Video: {modeLabel(m)}</option>
                      ))}
                    </select>
                  </FormField>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </>
  );
}
