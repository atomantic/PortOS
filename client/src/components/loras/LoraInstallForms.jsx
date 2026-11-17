import { Link } from 'react-router';
import { Download } from 'lucide-react';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from '../../lib/runnerFamilies';
import { pctOf } from './loraDisplay';
import HfDownloadProgress from './HfDownloadProgress';
import { CivitaiKeyBadge } from './CivitaiAuthModal';

// Manual family choices when HF autodetection returns HF_UNKNOWN_FAMILY.
// Image families first — the previous LTX-only confirm silently mis-tagged
// Flux.2 Klein adapters (Alissonerdx/CharacterSheet) as video LoRAs.
const HF_FAMILY_OVERRIDES = [
  { family: RUNNER_FAMILIES.FLUX2, label: 'Flux 2' },
  { family: RUNNER_FAMILIES.MFLUX, label: 'Flux 1' },
  { family: RUNNER_FAMILIES.Z_IMAGE, label: 'Z-Image' },
  { family: RUNNER_FAMILIES.QWEN, label: 'Qwen' },
  { family: RUNNER_FAMILIES.ERNIE, label: 'ERNIE' },
  { family: RUNNER_FAMILIES.HIDREAM, label: 'HiDream' },
  { family: VIDEO_LORA_FAMILIES.LTX_VIDEO, label: 'LTX-Video' },
  { family: VIDEO_LORA_FAMILIES.MINIMAX_H3, label: 'MiniMax H3' },
];

// `installs` is the useLoraInstalls() state machine owned by the Loras page.
export function CivitaiInstallForm({ installs, auth, onManageKey }) {
  const { installUrl, setInstallUrl, installing, handleInstall } = installs;
  return (
    <form
      onSubmit={handleInstall}
      className="bg-port-card border border-port-border rounded-lg p-4 space-y-3"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Download size={16} />
          <span>Install from Civitai</span>
        </div>
        <CivitaiKeyBadge auth={auth} onManage={onManageKey} />
      </div>
      {/* No `autoFocus`: this form used to mount once with the page, so
          focusing it was a landing convenience. It now remounts on every
          switch into Discover, where it would steal focus from the tab
          the user just activated and swallow their next arrow key. */}
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <input
          type="text"
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          aria-label="Civitai model URL"
          placeholder="https://civitai.com/models/2600698/realstagram"
          className="min-h-11 min-w-0 flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
          disabled={installing}
        />
        <button
          type="submit"
          disabled={installing || !installUrl.trim()}
          className="min-h-11 bg-port-accent text-white px-4 rounded text-sm font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {installing ? 'Downloading…' : 'Install'}
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Paste any <code className="bg-port-bg px-1 rounded">civitai.com</code> /{' '}
        <code className="bg-port-bg px-1 rounded">civitai.red</code> model URL — or just the
        numeric model id. Restricted LoRAs need an API key — PortOS will prompt you for one if a download is rejected.
      </p>
    </form>
  );
}

export function HfInstallForm({ installs }) {
  const {
    hfUrl, setHfUrl, hfInstalling, hfProgress, hfFamilyPrompt, setHfFamilyPrompt,
    handleHfInstall, runHfInstall, installingVideoKey, requestLoraDownload,
  } = installs;
  // Download percent for the in-flight HF install (drives the button label
  // and progress bar), or null when the total is unknown.
  const hfPct = pctOf(hfProgress);
  return (
    <form
      onSubmit={handleHfInstall}
      className="bg-port-card border border-port-border rounded-lg p-4 space-y-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-gray-300">
        <Download size={16} />
        <span>Install LoRA from HuggingFace</span>
      </div>
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <input
          type="text"
          value={hfUrl}
          onChange={(e) => setHfUrl(e.target.value)}
          aria-label="HuggingFace LoRA URL"
          placeholder="https://huggingface.co/Alissonerdx/CharacterSheet"
          className="min-h-11 min-w-0 flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600"
          disabled={hfInstalling}
        />
        <button
          type="submit"
          disabled={hfInstalling || !!installingVideoKey || !hfUrl.trim()}
          className="min-h-11 bg-port-accent text-white px-4 rounded text-sm font-medium hover:bg-port-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {hfInstalling ? (hfPct != null ? `Downloading ${hfPct}%` : 'Downloading…') : 'Install'}
        </button>
      </div>
      {hfInstalling && <HfDownloadProgress progress={hfProgress} />}
      <p className="text-xs text-gray-500">
        Paste a <code className="bg-port-bg px-1 rounded">huggingface.co</code> repo URL — or an{' '}
        <code className="bg-port-bg px-1 rounded">org/name</code> id — for an image or video LoRA
        (e.g. <code className="bg-port-bg px-1 rounded">Alissonerdx/CharacterSheet</code> or{' '}
        <code className="bg-port-bg px-1 rounded">fal/ltx2.3-audio-reactive-lora</code>).
        Flux.2 Klein adapters apply in <Link to="/media/image" className="text-port-accent hover:underline">Image Gen</Link>;
        LTX-Video LoRAs apply in <Link to="/media/video" className="text-port-accent hover:underline">Video Gen</Link>.
        Gated repos use your HuggingFace token from Image Gen settings.
      </p>
      {hfFamilyPrompt && (
        <div className="rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 space-y-2">
          <span className="text-xs text-gray-300">
            Couldn&apos;t detect the model family for <code className="bg-port-bg px-1 rounded">{hfFamilyPrompt}</code>. Choose the runner this LoRA targets:
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {HF_FAMILY_OVERRIDES.map(({ family, label }) => (
              <button
                key={family}
                type="button"
                onClick={() => requestLoraDownload(
                  'Install HuggingFace LoRA',
                  hfFamilyPrompt,
                  'huggingface',
                  () => runHfInstall(hfFamilyPrompt, family),
                  { family },
                )}
                disabled={hfInstalling}
                className="min-h-11 bg-port-accent text-white px-3 rounded text-xs font-medium hover:bg-port-accent/90 disabled:opacity-50"
              >
                {hfInstalling ? (hfPct != null ? `Installing ${hfPct}%` : 'Installing…') : `Install as ${label}`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setHfFamilyPrompt(null)}
              disabled={hfInstalling}
              className="text-gray-400 hover:text-gray-200 px-2 py-1 rounded text-xs disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
