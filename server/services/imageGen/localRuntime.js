/**
 * Local image-gen runtime diagnosis — the ONE place that answers "can this
 * machine render with the selected local model, and if not, what single action
 * fixes it?".
 *
 * The answer used to be computed in three places that disagreed: the status
 * probe behind the Image Gen banner (which probed the shared torch venv), the
 * Settings › Image Gen › Local panel (which probed only the mflux interpreter's
 * pip packages, and so reported "All required packages installed" while the
 * selected FLUX.2 default was unrenderable), and the renderer (which checked
 * only that the venv's python BINARY existed, letting a broken venv fail as a
 * bare `Exit code 1` on the Decks page).
 *
 * Every unavailable verdict names a `remedy` the UI renders as a single button.
 */

import { getSettings } from '../settings.js';
import { getImageModels } from '../../lib/mediaModels.js';
import { getSetupCheck } from './setup.js';
import { isFlux2VenvHealthy, FLUX2_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { LOCAL_IMAGEGEN_DEFAULT_MODEL } from './modes.js';
import {
  IMAGE_RUNTIME_LABELS, IMAGE_RUNTIME_READINESS, IMAGE_RUNTIME_REMEDY, imageRuntimeFor, usesTorchVenv,
} from '../../lib/imageRuntimeRemedies.js';

const { READY, UNAVAILABLE, UNKNOWN } = IMAGE_RUNTIME_READINESS;

/**
 * Diagnose the local runtime for one model.
 *
 * `settings` is optional — pass the already-loaded object from a caller that
 * has one (the dispatcher does) so a status poll doesn't re-read settings.
 */
export async function diagnoseLocalRuntime({ modelId: requestedModelId, settings } = {}) {
  const s = settings || await getSettings();
  const local = s?.imageGen?.local || {};
  const modelId = requestedModelId || local.modelId || LOCAL_IMAGEGEN_DEFAULT_MODEL;
  const model = getImageModels().find((entry) => entry.id === modelId);

  if (!model) {
    return {
      modelId,
      model: null,
      runner: null,
      runtime: null,
      runtimeLabel: null,
      readiness: UNAVAILABLE,
      reason: `Selected local model "${modelId}" is unavailable on this machine`,
      remedy: { kind: IMAGE_RUNTIME_REMEDY.CHOOSE_MODEL, label: 'Choose a different model' },
    };
  }

  // Every branch below answers for one model, so the identity fields are bound
  // once here rather than re-passed at each of the nine return sites — where one
  // of them would eventually be forgotten.
  const runtime = imageRuntimeFor(model);
  const verdict = ({ readiness, reason = null, remedy = null }) => ({
    modelId,
    model: { id: model.id, name: model.name || model.id, runner: model.runner || 'mflux' },
    runner: model.runner || 'mflux',
    runtime,
    runtimeLabel: IMAGE_RUNTIME_LABELS[runtime],
    readiness,
    reason,
    remedy,
  });

  const compat = model.hardwareCompatibility;
  if (compat?.state === 'unavailable') {
    return verdict({
      readiness: UNAVAILABLE,
      reason: compat.reasons?.join(' · ') || 'Selected model is incompatible with this machine',
      remedy: { kind: IMAGE_RUNTIME_REMEDY.CHOOSE_MODEL, label: 'Choose a compatible model' },
    });
  }
  if (compat?.state === 'unknown') {
    return verdict({
      readiness: UNKNOWN,
      reason: compat.reasons?.join(' · ') || 'Could not verify this machine supports the selected model',
    });
  }

  if (usesTorchVenv(model)) {
    // Health, not mere presence: a killed-mid-install venv still has its python
    // binary, and treating that as ready is how a deck render ended up reporting
    // a bare `Exit code 1`. Memoized in pythonSetup so ordinary status polls do
    // not repeatedly import torch.
    const healthy = await isFlux2VenvHealthy(model.pipelineClass).then((value) => value).catch(() => null);
    if (healthy === true) return verdict({ readiness: READY });
    if (healthy === false) {
      // Distinguish "no runtime" from "runtime is there but too old for THIS
      // model's pipeline" — both need the same installer run, but the second
      // read as a contradiction ("install" → "already installed") while the
      // copy claimed nothing was installed.
      const baseHealthy = !!model.pipelineClass && await isFlux2VenvHealthy().catch(() => false);
      return verdict({
        readiness: UNAVAILABLE,
        reason: baseHealthy
          ? `The shared torch image runtime is installed but too old for ${model.pipelineClass} — it needs an update (${FLUX2_VENV_DEFAULT})`
          : `The shared torch image runtime is not installed or healthy (expected at ${FLUX2_VENV_DEFAULT})`,
        remedy: {
          kind: IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV,
          label: baseHealthy ? 'Update runtime' : 'Install runtime',
          venvPath: FLUX2_VENV_DEFAULT,
        },
      });
    }
    return verdict({ readiness: UNKNOWN, reason: 'Could not verify the shared torch image runtime' });
  }

  const pythonPath = local.pythonPath || null;
  if (!pythonPath) {
    return verdict({
      readiness: UNAVAILABLE,
      reason: 'Python path not configured',
      remedy: { kind: IMAGE_RUNTIME_REMEDY.SET_PYTHON_PATH, label: 'Detect Python' },
    });
  }
  const setup = await getSetupCheck(pythonPath).then((result) => result).catch(() => null);
  if (!setup) return verdict({ readiness: UNKNOWN, reason: 'Could not verify the configured Python runtime' });
  if (setup.archMismatch) {
    return verdict({
      readiness: UNAVAILABLE,
      reason: `Python architecture ${setup.interpreterArch || 'unknown'} is incompatible with this ${setup.hostArch || 'host'} runtime`,
      remedy: {
        kind: IMAGE_RUNTIME_REMEDY.SWITCH_PYTHON,
        label: setup.suggestedArm64Python ? `Switch to ${setup.suggestedArm64Python}` : 'Choose a matching Python',
        pythonPath: setup.suggestedArm64Python || null,
      },
    });
  }
  if (setup.missing?.length) {
    return verdict({
      readiness: UNAVAILABLE,
      reason: `Missing required packages: ${setup.missing.join(', ')}`,
      remedy: {
        kind: IMAGE_RUNTIME_REMEDY.INSTALL_PACKAGES,
        label: `Install ${setup.missing.length} missing package${setup.missing.length === 1 ? '' : 's'}`,
        pythonPath,
        packages: setup.missingPip || [],
      },
    });
  }
  return verdict({ readiness: READY });
}
