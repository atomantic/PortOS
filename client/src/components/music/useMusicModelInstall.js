/**
 * Model/runtime install flows for MusicGenPanel: the setup banner action
 * (runtime first, then fixed weights) and the inline HuggingFace repo install.
 */

import { useState } from 'react';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';
import { engineSetupState, isEngineModelReady, resolveEngineModel, streamModelInstall } from './musicEngineModels.js';

export default function useMusicModelInstall({ engine, engineId, selectedModelId, setup, loadEngines, setModelId }) {
  const [installRepo, setInstallRepo] = useState('');
  const [installing, setInstalling] = useState(false);
  // Custom-repo progress and setup-banner progress are rendered in different places.
  const [installProgress, setInstallProgress] = useState(null);
  const [setupProgress, setSetupProgress] = useState(null);
  const [runtimeInstallEngine, setRuntimeInstallEngine] = useState(null);
  const mountedRef = useMounted();

  // `target` is the engine record to install for — passed explicitly by the
  // post-runtime chain, which holds a fresher record than component state does.
  const installFixedModel = async (target) => {
    const eng = target || engine;
    const model = resolveEngineModel(eng, eng?.id === engine?.id ? selectedModelId : '');
    if (!eng || !model?.repo) return;
    setInstalling(true);
    setSetupProgress({ message: `Starting ${model.name}…` });
    const ok = await streamModelInstall({ engineId: eng.id, repo: model.repo, onProgress: setSetupProgress, isMounted: () => mountedRef.current });
    if (!mountedRef.current) return;
    setInstalling(false);
    setSetupProgress(null);
    if (ok) { await loadEngines(); toast.success(`${model.name} installed`); }
  };

  // Runtime first when it's missing — weights are useless without an
  // interpreter to load them — otherwise straight to weights.
  const handleSetupInstall = async () => {
    if (!setup || setup.blocked) return;
    if (setup.needsRuntime) { setRuntimeInstallEngine(engine); return; }
    await installFixedModel(engine);
  };

  // Runtime installer closed: refresh, then continue into the weights — but only
  // once the refreshed record shows the venv actually landed, so a cancelled or
  // failed runtime install can't kick off a multi-GB pull with nothing to run it.
  const handleRuntimeInstallClose = async () => {
    setRuntimeInstallEngine(null);
    const list = await loadEngines();
    if (!mountedRef.current) return;
    const fresh = list.find((e) => e.id === engineId);
    const freshSetup = engineSetupState(fresh, isEngineModelReady(fresh, selectedModelId), fresh?.modelSizeGbById?.[selectedModelId] ?? null);
    if (freshSetup && !freshSetup.blocked && !freshSetup.needsRuntime && freshSetup.needsWeights) {
      await installFixedModel(fresh);
    }
  };

  const handleInstall = async () => {
    const repo = installRepo.trim();
    if (!repo || !engine) return;
    setInstalling(true);
    setInstallProgress({ message: `Starting ${repo}…` });
    const ok = await streamModelInstall({ engineId: engine.id, repo, onProgress: setInstallProgress, isMounted: () => mountedRef.current });
    if (!mountedRef.current) return;
    setInstalling(false);
    setInstallProgress(null);
    if (!ok) return; // leave the repo field intact so the user can retry/fix
    setInstallRepo('');
    await loadEngines(); // refresh model list (the new repo is now registered)
    setModelId(repo);
    toast.success(`Installed ${repo}`);
  };

  return {
    installRepo, setInstallRepo, installing, installProgress, setupProgress,
    runtimeInstallEngine, handleSetupInstall, handleRuntimeInstallClose, handleInstall,
  };
}
