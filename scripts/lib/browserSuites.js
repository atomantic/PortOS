// Registered suites run once in the browser job; Linux unit jobs exclude only
// this registry. Prerequisite guards fail closed when browser coverage is required.
export const BROWSER_SUITES = [
  'server/lib/filmLook.browser.test.js',
  'server/lib/filmLookGpu.browser.test.js',
  'server/lib/musicVideoTitleCard.browser.test.js',
  'server/routes/catalogGreyboxViewer.browser.test.js',
  'server/routes/musicVideoProductionReview.browser.test.js',
  'server/routes/musicVideoRichAuthoring.browser.test.js',
  'server/routes/musicVideoSongRevision.browser.test.js',
  'server/services/codeAnimation/export.realBrowser.test.js',
  'server/services/fableLoom/static-player/player.browser.test.js',
  'server/services/federatedMedia/sourceAudio.browser.test.js',
  'server/services/greyboxRender.browser.test.js',
  'server/services/htmlComposition/index.test.js',
  'server/services/musicVideo/animaticCapture.browser.test.js',
  'server/services/musicVideo/compositionRender.test.js',
  'server/services/musicVideo/documentRender.browser.test.js',
  'server/services/musicVideo/documentTemplates/layered/engine.overlay.browser.test.js',
  'server/services/musicVideo/documentTemplates/shared/lyricType.browser.test.js',
  'server/services/musicVideo/documentTemplates/shared/toonWorld.browser.test.js',
  'server/services/musicVideo/publish/linkedin.browser.test.js',
  'server/services/musicVideo/publish/sunoHook.browser.test.js',
];

/**
 * Interleave the canonical registry before filtering a scoped selection. The
 * generic Vitest hash split clustered all long capture suites on one runner;
 * alternating these owners separates document rendering from HTML composition.
 * Membership never depends on the selected subset or a worker's memo state.
 */
export function browserShardSlice(files, { index, count }) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error('Invalid browser shard');
  }
  const selected = new Set(files);
  const unknown = [...selected].filter(file => !BROWSER_SUITES.includes(file));
  if (unknown.length) throw new Error(`Unregistered browser shard inputs: ${unknown.join(', ')}`);
  return BROWSER_SUITES.filter((file, position) => position % count === index - 1 && selected.has(file));
}
