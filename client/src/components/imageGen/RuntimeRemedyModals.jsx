import Flux2InstallModal from './Flux2InstallModal';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import { IMAGE_RUNTIME_REMEDY } from '../../lib/imageGenBackends';

/**
 * The install/repair modals for every local image-runtime remedy PortOS can
 * perform itself, keyed by remedy kind.
 *
 * Shared by the runtime banner (`LocalRuntimeStatus`) and the Image Gen page
 * header so both offer the same one-tap fix with streamed progress. The page
 * header used to perform only the torch-venv install and send every other
 * remedy to Settings, where the runtime panel probes the saved default model
 * rather than the model picked on the page, so the repair button never showed.
 */

// Remedies with an in-app installer. Anything else (a Python path, a model
// choice) needs a form and belongs in Settings.
export const SELF_SERVE_RUNTIME_REMEDIES = Object.freeze([
  IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV,
  IMAGE_RUNTIME_REMEDY.INSTALL_FLUX3,
  IMAGE_RUNTIME_REMEDY.INSTALL_MOSS_SWIFT,
  IMAGE_RUNTIME_REMEDY.DOWNLOAD_MOSS_WEIGHTS,
  IMAGE_RUNTIME_REMEDY.INSTALL_MINIMAX_H3,
]);

export const isSelfServeRuntimeRemedy = (kind) => SELF_SERVE_RUNTIME_REMEDIES.includes(kind);

export default function RuntimeRemedyModals({ kind, modelId = null, onClose, onComplete }) {
  const mossWeights = kind === IMAGE_RUNTIME_REMEDY.DOWNLOAD_MOSS_WEIGHTS;
  return (
    <>
      <RuntimeInstallModal
        open={kind === IMAGE_RUNTIME_REMEDY.INSTALL_FLUX3}
        runtime="flux3" label="FLUX.3 Klein runtime"
        installUrlBase="/api/image-gen/setup/flux3-install"
        description="Installing isolated mflux 0.23.0 and its MLX dependencies. Requires uv and Apple Silicon macOS 14+. Model weights download separately (Q4 5.3 GB, Q6 7.6 GB, Q8 9.9 GB)."
        onClose={onClose} onComplete={onComplete}
      />
      <Flux2InstallModal open={kind === IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV} onClose={onClose} onComplete={onComplete} modelId={modelId} />
      <RuntimeInstallModal
        open={kind === IMAGE_RUNTIME_REMEDY.INSTALL_MOSS_SWIFT || mossWeights}
        runtime="moss-swift"
        label={mossWeights ? 'MOSS SFT weights (27.2 GB)' : 'MOSS Swift runtime'}
        installUrlBase={mossWeights ? '/api/image-gen/setup/moss-weights' : '/api/image-gen/setup/moss-install'}
        description={mossWeights ? 'Downloading and verifying 27.2 GB of Apache-2.0 SFT weights.' : 'Building the pinned MIT Swift port and dependencies. Requires Swift 6.3+, Metal compiler and 10 GB free build space; weights download separately.'}
        doneText={mossWeights ? 'MOSS SFT weights are verified.' : 'MOSS Swift is installed. Download the SFT weights separately.'}
        onClose={onClose}
        onComplete={onComplete}
      />
      <RuntimeInstallModal
        open={kind === IMAGE_RUNTIME_REMEDY.INSTALL_MINIMAX_H3}
        runtime="minimax_h3" label="MiniMax H3 MLX runtime"
        description="Installing the pinned MLX runtime shared with H3 video. Requires Apple Silicon macOS 14+. Model weights download separately."
        onClose={onClose} onComplete={onComplete}
      />
    </>
  );
}
