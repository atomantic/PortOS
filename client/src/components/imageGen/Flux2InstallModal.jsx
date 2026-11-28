/** Configure the shared runtime installer for FLUX.2's model-scoped Python setup. */

import { queryString } from '../../services/apiCore';
import RuntimeInstallModal from '../install/RuntimeInstallModal';

// IDs match the stages emitted by installFlux2Venv in pythonSetup.js.
const STAGES = [
  { id: 'detect', label: 'Detect Python' },
  { id: 'venv', label: 'Create venv' },
  { id: 'upgrade-pip', label: 'Upgrade pip' },
  { id: 'install', label: 'Install packages' },
  { id: 'verify', label: 'Verify' },
];

/**
 * `modelId` scopes the server's "already installed?" gate to the model the user
 * is trying to render with. Omitting it gates on the base FLUX.2 pipeline only,
 * which reports "nothing to do" for a venv whose diffusers predates a newer
 * model's pipeline class — the install button that did nothing.
 */
export default function Flux2InstallModal({ open, onClose, onComplete, modelId = null }) {
  return (
    <RuntimeInstallModal
      open={open}
      onClose={onClose}
      onComplete={onComplete}
      installUrl={`/api/image-gen/setup/flux2-install${queryString({ modelId })}`}
      title="Installing FLUX.2 Runtime"
      label="FLUX.2 Runtime"
      stages={STAGES}
      description="Downloading torch + diffusers from PyPI/git. ~3-10 minutes on first run."
      doneText="✅ FLUX.2 is ready."
      errorMessage="⚠️ Installer hit an error — see logs above."
      surface="client/src/components/imageGen/Flux2InstallModal.jsx"
    />
  );
}
