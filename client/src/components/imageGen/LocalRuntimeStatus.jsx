import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, HelpCircle, RefreshCw, Settings as SettingsIcon, Wand2 } from 'lucide-react';
import Banner from '../ui/Banner';
import Flux2InstallModal from './Flux2InstallModal';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import { IMAGE_RUNTIME_READINESS, IMAGE_RUNTIME_REMEDY } from '../../lib/imageGenBackends';

/**
 * The local image runtime, described the ONE way the server describes it, with
 * the single action that fixes it attached.
 *
 * The Image Gen page used to say "Unavailable: the FLUX.2 image runtime is not
 * installed or healthy" while Settings › Image Gen › Local — two clicks away,
 * probing a different interpreter — said "All required packages installed", and
 * a deck card that hit the same wall said only "Failed".
 *
 * Presentation only: `useLocalImageRuntime` owns the probe, so a host can gate
 * its own Render button on the same verdict this renders.
 */

// Where the remedies this component cannot perform itself are performed. Owned
// here rather than passed in, so a settings-route move is one edit and a new
// host cannot retype it wrong.
export const IMAGE_SETTINGS_HREF = '/media/image?settings=1&mediaTab=local';

const TONE = {
  [IMAGE_RUNTIME_READINESS.READY]: { tone: 'success', Icon: CheckCircle2 },
  [IMAGE_RUNTIME_READINESS.UNKNOWN]: { tone: 'warning', Icon: HelpCircle },
  [IMAGE_RUNTIME_READINESS.UNAVAILABLE]: { tone: 'error', Icon: AlertTriangle },
};

const REMEDY_ICON = {
  [IMAGE_RUNTIME_REMEDY.SET_PYTHON_PATH]: Wand2,
  [IMAGE_RUNTIME_REMEDY.SWITCH_PYTHON]: Wand2,
};

export default function LocalRuntimeStatus({
  runtime,
  loading = false,
  onRefresh = null,
  // Called after the runtime install finishes, so a host holding state that
  // depends on the verdict can re-read it.
  onRuntimeChanged = null,
  // The settings form itself passes false — a link back to the page you are
  // already on is worse than no affordance at all.
  settingsLink = true,
  // Render nothing while the runtime is ready. Surfaces whose subject IS the
  // runtime (the settings panel) want the green state; surfaces that merely
  // depend on it (a deck's render bar) want silence until there is something to
  // act on.
  hideWhenReady = false,
  className = '',
}) {
  const [installKind, setInstallKind] = useState(null);
  const closeInstall = useCallback(() => setInstallKind(null), []);
  const handleInstallComplete = useCallback(() => {
    onRefresh?.();
    onRuntimeChanged?.();
  }, [onRefresh, onRuntimeChanged]);

  if (!runtime) {
    return loading
      ? <p className={`text-xs text-gray-500 ${className}`}>Checking the local image runtime…</p>
      : null;
  }
  const ready = runtime.readiness === IMAGE_RUNTIME_READINESS.READY;
  if (hideWhenReady && ready) return null;

  const { tone, Icon } = TONE[runtime.readiness] || TONE[IMAGE_RUNTIME_READINESS.UNKNOWN];
  const remedy = runtime.remedy;
  // A remedy this component can perform itself, vs. one whose form lives in
  // Settings. Anything else renders as a reason with no button.
  const selfServe = [IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV, IMAGE_RUNTIME_REMEDY.INSTALL_FLUX3, IMAGE_RUNTIME_REMEDY.INSTALL_MOSS_SWIFT, IMAGE_RUNTIME_REMEDY.DOWNLOAD_MOSS_WEIGHTS].includes(remedy?.kind);
  const mossWeights = installKind === IMAGE_RUNTIME_REMEDY.DOWNLOAD_MOSS_WEIGHTS;
  const RemedyIcon = REMEDY_ICON[remedy?.kind] || SettingsIcon;

  return (
    <>
      <Banner
        tone={tone}
        icon={Icon}
        size="sm"
        className={className}
        actions={onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded p-1.5 text-gray-400 hover:bg-port-border/50 hover:text-white disabled:opacity-50"
            title="Re-check the local image runtime" aria-label="Re-check the local image runtime"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        ) : null}
      >
        <span className="font-medium">
          {ready
            ? `Ready — ${runtime.model || runtime.modelId}`
            : `${runtime.readiness === IMAGE_RUNTIME_READINESS.UNKNOWN ? 'Could not verify' : 'Unavailable'} — ${runtime.reason}`}
        </span>
        {runtime.runtimeLabel && <span className="mt-0.5 block text-[11px] text-gray-400">{runtime.runtimeLabel}</span>}

        {(selfServe || (remedy && settingsLink)) && (
          <span className="mt-2 flex flex-wrap items-center gap-2">
            {selfServe ? (
              <button
                type="button"
                onClick={() => setInstallKind(remedy.kind)}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-port-accent px-3 py-2 text-sm text-white hover:bg-port-accent/80"
              >
                <Download size={14} aria-hidden="true" /> {remedy.label}
              </button>
            ) : (
              // A plain anchor, not a router Link: hosts render this outside a
              // Router in their own suites, and the target is a different page
              // either way (same idiom as the Models → Media links in Settings).
              <a
                href={IMAGE_SETTINGS_HREF}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-gray-300 hover:bg-port-border/50 hover:text-white"
              >
                <RemedyIcon size={14} aria-hidden="true" /> {remedy.label}
              </a>
            )}
            {selfServe && remedy.venvPath && (
              <span className="text-[11px] text-gray-500">Installs to <code>{remedy.venvPath}</code></span>
            )}
          </span>
        )}
      </Banner>
      <RuntimeInstallModal
        open={installKind === IMAGE_RUNTIME_REMEDY.INSTALL_FLUX3}
        runtime="flux3" label="FLUX.3 Klein runtime"
        installUrlBase="/api/image-gen/setup/flux3-install"
        description="Installing isolated mflux 0.23.0 and its MLX dependencies. Requires uv and Apple Silicon macOS 14+. Model weights download separately (Q4 5.3 GB, Q6 7.6 GB, Q8 9.9 GB)."
        onClose={closeInstall} onComplete={handleInstallComplete}
      />
      <Flux2InstallModal open={installKind === IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV} onClose={closeInstall} onComplete={handleInstallComplete} modelId={runtime.modelId} />
      <RuntimeInstallModal
        open={installKind === IMAGE_RUNTIME_REMEDY.INSTALL_MOSS_SWIFT || mossWeights}
        runtime="moss-swift"
        label={mossWeights ? 'MOSS SFT weights (27.2 GB)' : 'MOSS Swift runtime'}
        installUrlBase={mossWeights ? '/api/image-gen/setup/moss-weights' : '/api/image-gen/setup/moss-install'}
        description={mossWeights ? 'Downloading and verifying 27.2 GB of Apache-2.0 SFT weights.' : 'Building the pinned MIT Swift port and dependencies. Requires Swift 6.3+, Metal compiler and 10 GB free build space; weights download separately.'}
        doneText={mossWeights ? 'MOSS SFT weights are verified.' : 'MOSS Swift is installed. Download the SFT weights separately.'}
        onClose={closeInstall}
        onComplete={handleInstallComplete}
      />
    </>
  );
}
