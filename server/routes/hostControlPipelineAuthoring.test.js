import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pipeline-authority-') }));
afterAll(cleanupTempDataRoots);

// Pipeline writes are gated by the default-deny policy (#16018); the principal
// matrix lives in services/authGate.test.js. Provider dispatch, run creation,
// record stores and the image queue are doubled so each call is attributable.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  titleLogo: vi.fn(async () => ({ logo: 'example' })),
  generateStage: vi.fn(async () => ({ runId: 'example-run' })),
  autoRun: vi.fn(async () => ({ runId: 'example-run', alreadyRunning: false })),
  enqueueVisual: vi.fn(async () => ({ jobId: 'example-job' })),
  renderPage: vi.fn(async () => ({ jobId: 'example-job' })),
  refineRender: vi.fn(async () => ({ jobId: 'example-job' })),
  shotFrame: vi.fn(async () => ({ jobId: 'example-job' })),
  refinePanel: vi.fn(async () => ({ prompt: 'Example prompt' })),
  panelCandidates: vi.fn(async () => ({ candidates: [] })),
  refineScene: vi.fn(async () => ({ prompt: 'Example prompt' })),
  sceneCandidates: vi.fn(async () => ({ candidates: [] })),
  updateSeries: vi.fn(async (id, patch) => ({ id, name: 'Example Series', ...patch })),
  updateIssue: vi.fn(async (id, patch) => ({ id, ...patch })),
  cancelAutoRun: vi.fn(() => true),
}));
// Remainder (#10907): one double per newly gated operation plus the store writes
// an authorized handler performs afterwards. Distinct fns, so a call count of 6
// (one per authorized caller) is attributable to exactly one route.
const remainder = vi.hoisted(() => {
  const returns = {
    pov: { status: 'ok' },
    completeness: { issues: [], runId: 'example-run' },
    comicCover: { stage: { cover: {} } },
    comicBackCover: { stage: { backCover: {} } },
    extractScenes: { extracted: { scenes: [] }, runId: 'example-run' },
    extractCanon: { universe: {}, results: [], failures: [] },
    describeCanon: { universe: {}, report: {} },
    audioCues: { cues: [], runId: 'example-run' },
    seedReview: { comments: [] },
    updateStage: { issue: {}, stage: { cues: [] } },
  };
  const names = [
    'concepts', 'mergeAi', 'voice', 'arcOverview', 'arcVerify', 'arcResolve', 'arcDerive', 'episodes',
    'volumeVerify', 'volumeBeats', 'volumeCoverConcepts', 'volumeCover', 'volumeBackCover', 'reverseOutline',
    'continuity', 'pov', 'completeness', 'completenessStream', 'manuscriptFix', 'reformat', 'issueAnalyze',
    'seriesAnalyze', 'judge', 'panel', 'rank', 'seriesReview', 'seriesFix', 'checksRun', 'checkPreview',
    'comicCoverConcepts', 'comicCover', 'comicBackCover', 'extractScenes', 'extractCanon', 'describeCanon',
    'audioCues', 'seedReview', 'trendSnapshot', 'updateStage',
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn(async () => returns[name] ?? {})]));
});
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/pipeline/seriesTitleLogo.js', () => ({ generateSeriesTitleLogo: effects.titleLogo }));
vi.mock('../services/pipeline/textStages.js', () => ({ generateStage: effects.generateStage }));
vi.mock('../services/pipeline/autoRunner.js', () => ({
  startAutoRunTextStages: effects.autoRun,
  cancelAutoRun: effects.cancelAutoRun,
  attachClient: vi.fn(() => false),
}));
vi.mock('../services/pipeline/visualStages.js', () => ({
  enqueueVisualImage: effects.enqueueVisual,
  renderComicPage: effects.renderPage,
  refineComicPageRender: effects.refineRender,
  enqueueStoryboardShotStartFrame: effects.shotFrame,
  enqueueStoryboardSceneVideo: vi.fn(),
  renderComicCover: remainder.comicCover,
  renderComicBackCover: remainder.comicBackCover,
  renderVolumeCover: remainder.volumeCover,
  renderVolumeBackCover: remainder.volumeBackCover,
  refineComicPanelPrompt: effects.refinePanel,
  generateComicPanelImagePrompts: effects.panelCandidates,
  refineStoryboardScenePrompt: effects.refineScene,
  generateStoryboardSceneImagePrompts: effects.sceneCandidates,
}));
vi.mock('../services/pipeline/series.js', async (importOriginal) => ({
  ...await importOriginal(),
  updateSeries: effects.updateSeries,
  getSeries: vi.fn(async (id) => ({ id, name: 'Example Series', universeId: 'example-universe' })),
}));
vi.mock('../services/pipeline/issues.js', async (importOriginal) => ({
  ...await importOriginal(),
  updateIssue: effects.updateIssue,
  updateStage: remainder.updateStage,
  updateStageWithLatest: remainder.updateStage,
  getIssue: vi.fn(async (id) => ({
    id,
    seriesId: 'example-series',
    stages: {
      comicPages: { pages: [{ panels: [{}] }] },
      storyboards: { scenes: [{ shots: [{}] }] },
      prose: { output: 'Example prose' },
      teleplay: { output: 'Example teleplay' },
    },
  })),
}));
vi.mock('../services/pipeline/seriesCanon.js', async (importOriginal) => ({
  ...await importOriginal(),
  getSeriesCanon: vi.fn(async () => ({ characters: [], places: [], objects: [] })),
}));
vi.mock('../services/pipeline/seriesGenerate.js', async (importOriginal) => ({
  ...await importOriginal(), generateSeriesConcepts: remainder.concepts,
}));
vi.mock('../services/recordMergeAI.js', async (importOriginal) => ({
  ...await importOriginal(), mergeFieldsWithAI: remainder.mergeAi,
}));
vi.mock('../services/pipeline/seriesVoiceDiscover.js', async (importOriginal) => ({
  ...await importOriginal(), discoverSeriesVoice: remainder.voice,
}));
vi.mock('../services/pipeline/arcPlanner.js', async (importOriginal) => ({
  ...await importOriginal(),
  generateArcOverview: remainder.arcOverview,
  verifyArc: remainder.arcVerify,
  resolveVerifyIssues: remainder.arcResolve,
  deriveFromManuscript: remainder.arcDerive,
  generateSeasonEpisodes: remainder.episodes,
  verifyVolume: remainder.volumeVerify,
  generateVolumeCoverConcepts: remainder.volumeCoverConcepts,
  generateComicCoverConcepts: remainder.comicCoverConcepts,
  analyzeManuscriptCompleteness: remainder.completeness,
}));
vi.mock('../services/pipeline/volumeBeatsRunner.js', async (importOriginal) => ({
  ...await importOriginal(), startVolumeBeatsRun: remainder.volumeBeats,
}));
vi.mock('../services/pipeline/reverseOutline.js', async (importOriginal) => ({
  ...await importOriginal(), startReverseOutlineRun: remainder.reverseOutline,
}));
vi.mock('../services/pipeline/continuityBible.js', async (importOriginal) => ({
  ...await importOriginal(), startContinuityBibleRun: remainder.continuity,
}));
vi.mock('../services/pipeline/perspectiveRewrite.js', async (importOriginal) => ({
  ...await importOriginal(), generatePerspectiveRewrite: remainder.pov,
}));
vi.mock('../services/pipeline/manuscriptReview.js', async (importOriginal) => ({
  ...await importOriginal(), seedReviewFromFindings: remainder.seedReview,
}));
vi.mock('../services/pipeline/manuscriptFix.js', async (importOriginal) => ({
  ...await importOriginal(),
  generateManuscriptFix: remainder.manuscriptFix,
  reformatManuscriptStageText: remainder.reformat,
}));
vi.mock('../services/pipeline/manuscriptCompletenessRunner.js', async (importOriginal) => ({
  ...await importOriginal(), startCompletenessReview: remainder.completenessStream,
}));
vi.mock('../services/pipeline/editorialScore.js', async (importOriginal) => ({
  ...await importOriginal(), recordTrendSnapshot: remainder.trendSnapshot,
}));
vi.mock('../services/pipeline/editorialAnalysis.js', async (importOriginal) => ({
  ...await importOriginal(), analyzeIssue: remainder.issueAnalyze,
}));
vi.mock('../services/pipeline/editorialAnalysisRunner.js', async (importOriginal) => ({
  ...await importOriginal(), startSeriesAnalysis: remainder.seriesAnalyze,
}));
vi.mock('../services/pipeline/pipelineJudge.js', async (importOriginal) => ({
  ...await importOriginal(), judgeIssue: remainder.judge,
}));
vi.mock('../services/pipeline/readerPanelRunner.js', async (importOriginal) => ({
  ...await importOriginal(), startReaderPanel: remainder.panel,
}));
vi.mock('../services/pipeline/editorial/comparativeRank.js', async (importOriginal) => ({
  ...await importOriginal(), runComparativeRank: remainder.rank,
}));
vi.mock('../services/pipeline/seriesReview.js', async (importOriginal) => ({
  ...await importOriginal(),
  startSeriesReviewRun: remainder.seriesReview,
  startSeriesFixRun: remainder.seriesFix,
}));
vi.mock('../services/pipeline/editorial/checkRunner.js', async (importOriginal) => ({
  ...await importOriginal(),
  startEditorialChecksRun: remainder.checksRun,
  previewCustomCheck: remainder.checkPreview,
}));
vi.mock('../services/sceneExtractor.js', async (importOriginal) => ({
  ...await importOriginal(), extractScenes: remainder.extractScenes,
}));
vi.mock('../services/universeCanon.js', async (importOriginal) => ({
  ...await importOriginal(),
  extractCanonFromProse: remainder.extractCanon,
  describeCanonFromProse: remainder.describeCanon,
}));
vi.mock('../services/pipeline/audioCues.js', async (importOriginal) => ({
  ...await importOriginal(), deriveAudioCues: remainder.audioCues,
}));

import pipelineRoutes from './pipeline/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const picker = { providerId: 'example-cli', model: 'example-model' };
const issue = `/api/pipeline/issues/${id}`;
const imageBody = { description: 'Example scene', width: 512, height: 512 };
const series = `/api/pipeline/series/${id}`;
const season = `${series}/seasons/example-season`;
const pickOverride = { providerOverride: 'example-cli', modelOverride: 'example-model' };
const squarePx = { width: 512, height: 512 };
const customCheck = { label: 'Example check', prompt: 'Flag example problems' };
// [path, body, effect observed on success, picker key the effect receives (default: derived from the body)]
const operations = [
  [`/api/pipeline/series/${id}/generate-title-logo`, picker, effects.titleLogo],
  [`${issue}/stages/prose/generate`, { seedInput: 'Example seed', ...picker }, effects.generateStage],
  [`${issue}/auto-run-text`, picker, effects.autoRun],
  [`${issue}/stages/comicPages/pages/0/panels/0/refine-prompt`, picker, effects.refinePanel],
  [`${issue}/stages/comicPages/pages/0/panels/0/image-prompts`, { count: 2, ...picker }, effects.panelCandidates],
  [`${issue}/stages/storyboards/scenes/0/refine-prompt`, picker, effects.refineScene],
  [`${issue}/stages/storyboards/scenes/0/image-prompts`, { count: 2, ...picker }, effects.sceneCandidates],
  [`${issue}/stages/comicPages/visual`, imageBody, effects.enqueueVisual],
  [`${issue}/stages/comicPages/pages/0/render`, { width: 512, height: 512 }, effects.renderPage],
  [`${issue}/stages/comicPages/pages/0/refine-render`,
    { instruction: 'Example correction', width: 512, height: 512, ...picker }, effects.refineRender],
  [`${issue}/stages/storyboards/scenes/0/shots/0/render`, { width: 512, height: 512 }, effects.shotFrame],
  // Remainder (#10907)
  ['/api/pipeline/series/generate-concept', { universeId: 'example-universe', ...picker }, remainder.concepts],
  ['/api/pipeline/series/merge/ai-resolve', {
    survivorId: 'ser-00000000-0000-4000-8000-000000000002', loserId: 'ser-00000000-0000-4000-8000-000000000003',
    fields: ['name'], ...picker,
  }, remainder.mergeAi],
  [`${series}/discover-voice`, picker, remainder.voice],
  [`${series}/arc/generate`, pickOverride, remainder.arcOverview],
  [`${series}/arc/verify`, pickOverride, remainder.arcVerify],
  [`${series}/arc/resolve-issues`, pickOverride, remainder.arcResolve],
  [`${series}/arc/derive-from-manuscript`, pickOverride, remainder.arcDerive],
  [`${season}/episodes/generate`, pickOverride, remainder.episodes],
  [`${season}/verify`, pickOverride, remainder.volumeVerify],
  [`${season}/generate-beats`, pickOverride, remainder.volumeBeats, 'providerId'],
  [`${season}/cover-concepts/generate`, pickOverride, remainder.volumeCoverConcepts],
  [`${season}/cover/render`, squarePx, remainder.volumeCover, null],
  [`${season}/back-cover/render`, squarePx, remainder.volumeBackCover, null],
  [`${series}/reverse-outline/generate`, picker, remainder.reverseOutline],
  [`${series}/continuity-bible/generate`, picker, remainder.continuity],
  [`${issue}/pov-rewrites`, { povCharacterId: 'example-character', ...picker }, remainder.pov],
  [`${series}/manuscript/completeness`, pickOverride, remainder.completeness],
  [`${series}/manuscript/completeness/stream`, pickOverride, remainder.completenessStream],
  [`${series}/manuscript/review/comments/example-comment/fix`, pickOverride, remainder.manuscriptFix],
  [`${series}/manuscript/reformat`, { stageId: 'prose', content: 'Example text', ...pickOverride }, remainder.reformat],
  [`${issue}/editorial/analyze`, picker, remainder.issueAnalyze],
  [`${series}/editorial/analyze`, picker, remainder.seriesAnalyze],
  [`${issue}/judge`, picker, remainder.judge],
  [`${series}/editorial/panel/run`, picker, remainder.panel],
  [`${series}/editorial/rank`, picker, remainder.rank],
  [`${series}/review`, picker, remainder.seriesReview, 'providerOverride'],
  [`${series}/review/fix`, picker, remainder.seriesFix, 'providerOverride'],
  [`${series}/editorial/checks/run`, picker, remainder.checksRun, 'providerOverride'],
  [`${series}/editorial/custom-checks/preview`, { ...customCheck, ...picker }, remainder.checkPreview, 'providerOverride'],
  [`${issue}/cover-concepts/generate`, pickOverride, remainder.comicCoverConcepts],
  [`${issue}/stages/comicPages/cover/render`, squarePx, remainder.comicCover, null],
  [`${issue}/stages/comicPages/back-cover/render`, squarePx, remainder.comicBackCover, null],
  [`${issue}/stages/storyboards/extract-scenes`, { force: true, ...pickOverride }, remainder.extractScenes],
  [`${issue}/stages/prose/extract-canon`, { providerOverride: 'example-cli', model: 'example-model' }, remainder.extractCanon],
  [`${issue}/stages/prose/describe-canon`, {
    providerOverride: 'example-cli', model: 'example-model', targets: [{ id: 'example-noun', kind: 'character' }],
  }, remainder.describeCanon],
  [`${issue}/stages/audio/cues/generate`, pickOverride, remainder.audioCues],
];
const mounts = [['/api/pipeline', pipelineRoutes]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Pipeline agent-backed generation behind the default-deny gate (#10068, #10907, #16114)', () => {
  it('still dispatches every authoring operation for a local operator and a delegated agent session, keeping provider choices', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: operations.map(([path, body, effect]) => ['post', path, body, effect, 200]) });
    for (const [path, body, effect, key = ['providerId', 'providerOverride'].find((name) => body[name])] of operations) {
      if (!key) continue;
      const options = effect.mock.lastCall.find((value) => value && typeof value === 'object' && value[key]);
      expect(options?.[key], path).toBe('example-cli');
    }
  });

  it('refuses a remote caller before authoring and before record CRUD or cancellation, then runs them locally', async () => {
    await expectRemoteRefusal(mounts, ['post', operations[1][0], operations[1][1], effects.generateStage]);
    await expectRemoteRefusal(mounts, ['patch', `/api/pipeline/series/${id}`, { styleNotes: 'Example notes' }, effects.updateSeries]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['patch', `/api/pipeline/series/${id}`, { styleNotes: 'Example notes' }, effects.updateSeries, 200],
      ['patch', issue, { title: 'Example issue' }, effects.updateIssue, 200],
      ['post', `${issue}/auto-run-text/cancel`, {}, effects.cancelAutoRun, 200],
    ] });
  });
});
