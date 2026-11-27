// Registered suites run once in the browser job; Linux unit jobs exclude only
// this registry. Prerequisite guards fail closed when browser coverage is required.
// Two-shard owners (kept for 2-3 suite plans) use hosted per-file timings (uncached run 45038139135 and
// memo-miss runs including 45078932095). Balance serial capture time plus the
// parallel project's elapsed time. Keep owners stable when adding a suite.
const BROWSER_SUITE_OWNERS = {
  'server/lib/filmLook.browser.test.js': 1,
  'server/lib/filmLookGpu.browser.test.js': 1,
  'server/lib/musicVideo/musicVideoTitleCard.browser.test.js': 1,
  'server/routes/catalogGreyboxViewer.browser.test.js': 2,
  'server/routes/musicVideoProductionReview.browser.test.js': 2,
  'server/routes/musicVideoRichAuthoring.browser.test.js': 2,
  'server/routes/musicVideoSongRevision.browser.test.js': 1,
  'server/services/codeAnimation/export.realBrowser.test.js': 2,
  'server/services/fableLoom/static-player/player.browser.test.js': 1,
  'server/services/federatedMedia/sourceAudio.browser.test.js': 2,
  'server/services/browserVaultFill.browser.test.js': 1,
  'server/services/greyboxRender.browser.test.js': 2,
  'server/services/htmlComposition/index.test.js': 1,
  'server/services/musicVideo/animaticCapture.browser.test.js': 1,
  'server/services/musicVideo/animaticCaptureOverlays.browser.test.js': 2,
  'server/services/musicVideo/compositionRender.test.js': 1,
  'server/services/musicVideo/documentRender.browser.test.js': 2,
  'server/services/musicVideo/documentRenderTemplates.browser.test.js': 1,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 1,
  'server/services/musicVideo/documentRenderEffects.browser.test.js': 2,
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': 2,
  'server/services/musicVideo/documentTemplateParity.browser.test.js': 1,
  'server/services/musicVideo/documentFilmLook.browser.test.js': 2,
  'server/services/musicVideo/documentVignette.browser.test.js': 1,
  'server/services/musicVideo/filmLookFinish.browser.test.js': 2,
  'server/services/musicVideo/documentTemplates/layered/engine.controls.browser.test.js': 1,
  'server/services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js': 2,
  'server/services/musicVideo/documentTemplates/shared/lyricType.browser.test.js': 1,
  'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js': 2,
  'server/services/musicVideo/lyricPlaythrough.browser.test.js': 1,
  'server/services/musicVideo/publish/linkedin.browser.test.js': 2,
  'server/services/musicVideo/publish/x.browser.test.js': 1,
  'server/services/musicVideo/publish/sunoHook.browser.test.js': 2,
  'server/routes/manualUpdateRecovery.browser.test.js': 1,
  'server/routes/autofixerUi.browser.test.js': 1,
  'server/services/musicVideo/overlayTextService.browser.test.js': 2,
  'server/services/codeAnimation/poster.realBrowser.test.js': 1,
  'server/services/videoGen/realesrganUpscale.browser.test.js': 2,
};
export const BROWSER_SUITES = Object.keys(BROWSER_SUITE_OWNERS);
export const FULL_BROWSER_SHARD_COUNT = 7;

// Spread the visual and audio/timeline renders, HTML composition, and
// animatic capture across the four runners. Pair template parity with
// audio/timeline and keep the split effects suite on another runner.
const FOUR_SHARD_OWNERS = {
  'server/lib/filmLook.browser.test.js': 2,
  'server/lib/filmLookGpu.browser.test.js': 3,
  'server/lib/musicVideo/musicVideoTitleCard.browser.test.js': 4,
  'server/routes/catalogGreyboxViewer.browser.test.js': 4,
  'server/routes/musicVideoProductionReview.browser.test.js': 4,
  'server/routes/musicVideoRichAuthoring.browser.test.js': 2,
  'server/routes/musicVideoSongRevision.browser.test.js': 4,
  'server/services/codeAnimation/export.realBrowser.test.js': 1,
  'server/services/fableLoom/static-player/player.browser.test.js': 3,
  'server/services/federatedMedia/sourceAudio.browser.test.js': 4,
  'server/services/browserVaultFill.browser.test.js': 1,
  'server/services/greyboxRender.browser.test.js': 1,
  'server/services/htmlComposition/index.test.js': 2,
  'server/services/musicVideo/animaticCapture.browser.test.js': 4,
  'server/services/musicVideo/animaticCaptureOverlays.browser.test.js': 2,
  'server/services/musicVideo/compositionRender.test.js': 3,
  'server/services/musicVideo/documentRender.browser.test.js': 1,
  'server/services/musicVideo/documentRenderTemplates.browser.test.js': 4,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 3,
  'server/services/musicVideo/documentRenderEffects.browser.test.js': 1,
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': 1,
  'server/services/musicVideo/documentTemplateParity.browser.test.js': 3,
  'server/services/musicVideo/documentFilmLook.browser.test.js': 4,
  'server/services/musicVideo/documentVignette.browser.test.js': 2,
  'server/services/musicVideo/filmLookFinish.browser.test.js': 3,
  'server/services/musicVideo/documentTemplates/layered/engine.controls.browser.test.js': 4,
  'server/services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js': 3,
  'server/services/musicVideo/documentTemplates/shared/lyricType.browser.test.js': 2,
  'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js': 4,
  'server/services/musicVideo/lyricPlaythrough.browser.test.js': 3,
  'server/services/musicVideo/publish/linkedin.browser.test.js': 4,
  'server/services/musicVideo/publish/x.browser.test.js': 3,
  'server/services/musicVideo/publish/sunoHook.browser.test.js': 1,
  'server/routes/manualUpdateRecovery.browser.test.js': 1,
  'server/routes/autofixerUi.browser.test.js': 1,
  'server/services/musicVideo/overlayTextService.browser.test.js': 4,
  'server/services/codeAnimation/poster.realBrowser.test.js': 2,
  'server/services/videoGen/realesrganUpscale.browser.test.js': 2,
};

// Cold full run 45949376269 put rich authoring and GPU capture on the
// critical path together. Put GPU capture beside the parallel parity suite and
// spread the audio/timeline shard's other captures onto quieter runners.
const FULL_SHARD_OWNERS = {
  'server/lib/filmLook.browser.test.js': 7,
  'server/lib/filmLookGpu.browser.test.js': 6,
  'server/lib/musicVideo/musicVideoTitleCard.browser.test.js': 2,
  'server/routes/catalogGreyboxViewer.browser.test.js': 2,
  'server/routes/musicVideoProductionReview.browser.test.js': 1,
  'server/routes/musicVideoRichAuthoring.browser.test.js': 5,
  'server/routes/musicVideoSongRevision.browser.test.js': 5,
  'server/services/codeAnimation/export.realBrowser.test.js': 5,
  'server/services/fableLoom/static-player/player.browser.test.js': 1,
  'server/services/federatedMedia/sourceAudio.browser.test.js': 1,
  'server/services/browserVaultFill.browser.test.js': 4,
  'server/services/greyboxRender.browser.test.js': 2,
  'server/services/htmlComposition/index.test.js': 7,
  'server/services/musicVideo/animaticCapture.browser.test.js': 3,
  'server/services/musicVideo/animaticCaptureOverlays.browser.test.js': 1,
  'server/services/musicVideo/compositionRender.test.js': 6,
  'server/services/musicVideo/documentRender.browser.test.js': 1,
  'server/services/musicVideo/documentRenderTemplates.browser.test.js': 5,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 4,
  'server/services/musicVideo/documentRenderEffects.browser.test.js': 2,
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': 3,
  'server/services/musicVideo/documentTemplateParity.browser.test.js': 6,
  'server/services/musicVideo/documentFilmLook.browser.test.js': 7,
  'server/services/musicVideo/documentVignette.browser.test.js': 3,
  'server/services/musicVideo/filmLookFinish.browser.test.js': 6,
  'server/services/musicVideo/documentTemplates/layered/engine.controls.browser.test.js': 2,
  'server/services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js': 4,
  'server/services/musicVideo/documentTemplates/shared/lyricType.browser.test.js': 4,
  'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js': 2,
  'server/services/musicVideo/lyricPlaythrough.browser.test.js': 3,
  'server/services/musicVideo/publish/linkedin.browser.test.js': 1,
  'server/services/musicVideo/publish/x.browser.test.js': 6,
  'server/services/musicVideo/publish/sunoHook.browser.test.js': 4,
  'server/routes/manualUpdateRecovery.browser.test.js': 7,
  'server/routes/autofixerUi.browser.test.js': 3,
  'server/services/musicVideo/overlayTextService.browser.test.js': 5,
  'server/services/codeAnimation/poster.realBrowser.test.js': 1,
  'server/services/videoGen/realesrganUpscale.browser.test.js': 7,
};

// Moving the serial GPU suite (82s on smoke run 45081031945) splits it from
// the 106s animatic capture. Four-shard smoke already
// separates GPU film look from animatic capture and shares the full owners.
const TWO_SHARD_SMOKE_OVERRIDES = {
  'server/lib/filmLookGpu.browser.test.js': 2,
};

// Cold smoke run 45947826202 had no rich authoring, and serial templates
// extended the parallel parity shard. Keep this override small so only
// moved suites need a second full-run memo partition.
const SEVEN_SHARD_SMOKE_OVERRIDES = {
  'server/lib/filmLookGpu.browser.test.js': 5,
  'server/lib/musicVideo/musicVideoTitleCard.browser.test.js': 1,
  'server/routes/musicVideoProductionReview.browser.test.js': 3,
  'server/services/codeAnimation/poster.realBrowser.test.js': 6,
  'server/services/musicVideo/documentRenderTemplates.browser.test.js': 4,
  'server/services/musicVideo/publish/sunoHook.browser.test.js': 6,
};

/**
 * Assign from the complete registry so a scoped selection or a memo hit cannot
 * move a suite to another runner. A one-shard plan uses the whole selection.
 */
export function browserShardSlice(files, { index, count }, profile) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error('Invalid browser shard');
  }
  const selected = new Set(files);
  const unknown = [...selected].filter(file => !BROWSER_SUITES.includes(file));
  if (unknown.length) throw new Error(`Unregistered browser shard inputs: ${unknown.join(', ')}`);
  const smoke = profile === 'smoke';
  const owners = count === 2 ? BROWSER_SUITE_OWNERS
    : count === 4 ? FOUR_SHARD_OWNERS
      : count === FULL_BROWSER_SHARD_COUNT ? FULL_SHARD_OWNERS : null;
  const overrides = smoke && count === 2 ? TWO_SHARD_SMOKE_OVERRIDES
    : smoke && count === FULL_BROWSER_SHARD_COUNT ? SEVEN_SHARD_SMOKE_OVERRIDES : {};
  return BROWSER_SUITES.filter((file, position) => (
    selected.has(file) && (overrides[file] ?? (owners ? owners[file] : (position % count) + 1)) === index
  ));
}

/** Full-run memo partitions needed by the selected suites owned by a seven-shard smoke runner. */
export function browserSmokeMemoDonors(files, index) {
  const owned = browserShardSlice(files, { index, count: FULL_BROWSER_SHARD_COUNT }, 'smoke');
  return [...new Set(owned.map(file => FULL_SHARD_OWNERS[file]).filter(owner => owner !== index))].sort((a, b) => a - b);
}
