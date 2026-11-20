import { observeModelResource } from './modelObservation.js';

// Sockets can subscribe before either HTTP router loads. Register both probes at boot.
export const voiceObservation = observeModelResource('voice-readiness', async () => {
  const [{ getVoiceConfig }, { checkAll }, { verifyBinaries, verifyModels }] = await Promise.all([
    import('./voice/config.js'), import('./voice/health.js'), import('./voice/bootstrap.js'),
  ]);
  const cfg = await getVoiceConfig();
  const [services, bins] = await Promise.all([checkAll(cfg), verifyBinaries(cfg)]);
  const models = verifyModels(cfg);
  return {
    enabled: cfg.enabled,
    sttEngine: cfg.stt.engine,
    ttsEngine: cfg.tts.engine,
    services,
    binaries: bins,
    models,
  };
}, 5000);

export const loadedObservation = observeModelResource('loaded-models', async () => {
  const [{ getSettings }, ollamaManager, lmStudioManager] = await Promise.all([
    import('./settings.js'), import('./ollamaManager.js'), import('./lmStudioManager.js'),
  ]);
  const settings = await getSettings().catch(() => ({}));
  const [ollama, lmstudio] = await Promise.all([
    ollamaManager.getLoadedModels(),
    lmStudioManager.getLoadedModels(true),
  ]);
  const sourceErrors = [
    ...(ollamaManager.getLastLoadedModelsError() ? ['ollama'] : []),
    ...(lmStudioManager.getLastLoadedModelsError() ? ['lmstudio'] : []),
  ];
  const disabled = [
    ...(settings.localLlm?.ollama?.disabled ? ['ollama'] : []),
    ...(settings.localLlm?.lmstudio?.disabled ? ['lmstudio'] : []),
  ];
  return { ollama, lmstudio, sourceErrors, disabled };
}, 2000);
