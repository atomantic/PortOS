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
  'server/services/musicVideo/compositionRender.test.js': 1,
  'server/services/musicVideo/documentRender.browser.test.js': 2,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 1,
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
};
export const BROWSER_SUITES = Object.keys(BROWSER_SUITE_OWNERS);
export const FULL_BROWSER_SHARD_COUNT = 7;

// Spread the two document-render capture suites, HTML composition, and
// animatic capture across the four runners. Template parity ran for 40–53s
// on hosted runs 45782641727 and 45781773182. Pair it with the audio/timeline suite, whose
// smoke workload omits two fidelity cases, and away from HTML composition and
// animatic capture so common render changes do not stack those long jobs.
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
  'server/services/musicVideo/compositionRender.test.js': 3,
  'server/services/musicVideo/documentRender.browser.test.js': 1,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 3,
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
};

// Cold hosted smoke/full runs 45795873594 and 45795861168 measured each
// file in the serial capture or parallel project. Keep the longest visual
// suite on its own and overlap the large parallel suites on a runner with
// few captures. The two projects execute in sequence on each runner.
const FULL_SHARD_OWNERS = {
  'server/lib/filmLook.browser.test.js': 4,
  'server/lib/filmLookGpu.browser.test.js': 5,
  'server/lib/musicVideo/musicVideoTitleCard.browser.test.js': 5,
  'server/routes/catalogGreyboxViewer.browser.test.js': 6,
  'server/routes/musicVideoProductionReview.browser.test.js': 5,
  'server/routes/musicVideoRichAuthoring.browser.test.js': 7,
  'server/routes/musicVideoSongRevision.browser.test.js': 6,
  'server/services/codeAnimation/export.realBrowser.test.js': 6,
  'server/services/fableLoom/static-player/player.browser.test.js': 6,
  'server/services/federatedMedia/sourceAudio.browser.test.js': 5,
  'server/services/browserVaultFill.browser.test.js': 6,
  'server/services/greyboxRender.browser.test.js': 7,
  'server/services/htmlComposition/index.test.js': 2,
  'server/services/musicVideo/animaticCapture.browser.test.js': 3,
  'server/services/musicVideo/compositionRender.test.js': 6,
  'server/services/musicVideo/documentRender.browser.test.js': 1,
  'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js': 4,
  'server/services/musicVideo/documentRenderGeneration.browser.test.js': 3,
  'server/services/musicVideo/documentTemplateParity.browser.test.js': 6,
  'server/services/musicVideo/documentFilmLook.browser.test.js': 6,
  'server/services/musicVideo/documentVignette.browser.test.js': 7,
  'server/services/musicVideo/filmLookFinish.browser.test.js': 6,
  'server/services/musicVideo/documentTemplates/layered/engine.controls.browser.test.js': 5,
  'server/services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js': 4,
  'server/services/musicVideo/documentTemplates/shared/lyricType.browser.test.js': 5,
  'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js': 5,
  'server/services/musicVideo/lyricPlaythrough.browser.test.js': 7,
  'server/services/musicVideo/publish/linkedin.browser.test.js': 6,
  'server/services/musicVideo/publish/x.browser.test.js': 6,
  'server/services/musicVideo/publish/sunoHook.browser.test.js': 7,
  'server/routes/manualUpdateRecovery.browser.test.js': 7,
  'server/routes/autofixerUi.browser.test.js': 7,
  'server/services/musicVideo/overlayTextService.browser.test.js': 2,
  'server/services/codeAnimation/poster.realBrowser.test.js': 2,
};

// Full runs spend ~71s on rich authoring. Smoke omits that suite, so move
// catalog capture there and use production review to fill the vacated slot.
const FULL_SHARD_SMOKE_OVERRIDES = {
  'server/routes/catalogGreyboxViewer.browser.test.js': 7,
  'server/routes/musicVideoProductionReview.browser.test.js': 6,
};

// Moving the serial GPU suite (82s on smoke run 45081031945) splits it from
// the 106s animatic capture. Four-shard smoke already
// separates GPU film look from animatic capture and shares the full owners.
const TWO_SHARD_SMOKE_OVERRIDES = {
  'server/lib/filmLookGpu.browser.test.js': 2,
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
    : smoke && count === FULL_BROWSER_SHARD_COUNT ? FULL_SHARD_SMOKE_OVERRIDES : {};
  return BROWSER_SUITES.filter((file, position) => (
    selected.has(file) && (overrides[file] ?? (owners ? owners[file] : (position % count) + 1)) === index
  ));
}
