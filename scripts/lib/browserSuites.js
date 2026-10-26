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
