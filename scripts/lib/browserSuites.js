// Registered suites run once in the browser job; Linux unit jobs exclude only
// this registry. Prerequisite guards fail closed when browser coverage is required.
// Two-shard owners use hosted per-file timings (uncached run 45038139135 and
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
  'server/services/musicVideo/overlayTextService.browser.test.js': 2,
  'server/services/codeAnimation/poster.realBrowser.test.js': 1,
};
export const BROWSER_SUITES = Object.keys(BROWSER_SUITE_OWNERS);

/**
 * Assign from the complete registry so a scoped selection or a memo hit cannot
 * move a suite to another runner. A one-shard plan uses the whole selection.
 */
export function browserShardSlice(files, { index, count }) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error('Invalid browser shard');
  }
  const selected = new Set(files);
  const unknown = [...selected].filter(file => !BROWSER_SUITES.includes(file));
  if (unknown.length) throw new Error(`Unregistered browser shard inputs: ${unknown.join(', ')}`);
  return BROWSER_SUITES.filter((file, position) => {
    const owner = count === 2 ? BROWSER_SUITE_OWNERS[file] : (position % count) + 1;
    return owner === index && selected.has(file);
  });
}
