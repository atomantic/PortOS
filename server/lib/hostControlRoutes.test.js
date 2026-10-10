import { describe, expect, it } from 'vitest';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { HOST_CONTROL_ROUTES, hostControlBodyKeys, hostControlSettingsPathsIn, hostControlRouteFor, isHostControlRoute } from './hostControlRoutes.js';

describe('Universe Builder mutation inventory (#10669)', () => {
  // Explicit reviewed data-only operations: a new mutation must be classified
  // rather than silently inheriting an execution exemption.
  const recordOrRead = [
    'POST /api/universe-builder',
    'PATCH /api/universe-builder/:id',
    'DELETE /api/universe-builder/:id',
    'PATCH /api/universe-builder/:id/variations/lock-all',
    'POST /api/universe-builder/:id/import/markdown',
    'POST /api/universe-builder/:id/style-references',
    'POST /api/universe-builder/:id/adopt-style',
    'DELETE /api/universe-builder/:id/style-references/:referenceId',
    'DELETE /api/universe-builder/:id/characters/:entryId/reference-sheet',
    'POST /api/universe-builder/merge/preview',
    'POST /api/universe-builder/merge',
    'POST /api/universe-builder/:id/canon/:kind/:entryId/apply-image-correction',
    'POST /api/universe-builder/:id/characters/:entryId/augment/apply',
    'POST /api/universe-builder/:id/canon/backfill-descriptions',
    'PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock',
    'DELETE /api/universe-builder/:id/canon/:kind/:entryId',
    'PATCH /api/universe-builder/:id/canon/:kind/lock-all',
  ];

  it('gates every agent-capable mutation and keeps reviewed deterministic operations open', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/universe-builder(\/|$)/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...recordOrRead].sort());
  });
});

describe('Story Builder mutation inventory (#10670)', () => {
  it('gates generation and explicitly preserves record-only operations', () => {
    const recordOnly = [
      'POST /api/story-builder',
      'PATCH /api/story-builder/:id',
      'DELETE /api/story-builder/:id',
      'POST /api/story-builder/:id/sync',
      'POST /api/story-builder/:id/reconcile',
      'POST /api/story-builder/:id/current-step/:stepId',
      'POST /api/story-builder/:id/steps/:stepId/lock',
      'POST /api/story-builder/:id/steps/:stepId/unlock',
      'POST /api/story-builder/:id/issues/:issueId/lock',
    ];
    const open = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method)
      && /^\/api\/story-builder(\/|$)/.test(path)
      && !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual(recordOnly.sort());
  });
});

describe('HOST_CONTROL_ROUTES (#8716)', () => {
  it('names only mounted routes, so a rename cannot silently ungate one', () => {
    // A catalog path keeps its `:param` / `*wildcard` tokens, which the
    // compiled patterns accept as ordinary segment text.
    const reached = new Set(getApiRouteCatalog().routes
      .map(({ method, path }) => hostControlRouteFor(method, path))
      .filter(Boolean));
    expect(HOST_CONTROL_ROUTES.filter((route) => !reached.has(route))).toEqual([]);
  });

  it('covers Express spellings conservatively while preserving route boundaries', () => {
    expect(isHostControlRoute('post', '/API/Apps/example-app/START/')).toBe(true);
    expect(hostControlRouteFor('post', '/API/HTML-COMPOSITION/TOOLKIT/SKILLS/INSTALL/')).toBe('POST /api/html-composition/toolkit/skills/install');
    expect(isHostControlRoute('GET', '/api/html-composition/toolkit')).toBe(false);
    expect(isHostControlRoute('POST', '/api/html-composition/render')).toBe(false);
    expect(isHostControlRoute('POST', '/api/git/status')).toBe(true);
    for (const suffix of ['//', '////']) {
      expect(hostControlRouteFor('post', '/API/Runs' + suffix)).toBe('POST /api/runs');
      expect(hostControlBodyKeys('put', '/API/Settings' + suffix, { harnesses: {} })).toEqual(['harnesses']);
      expect(hostControlSettingsPathsIn('PUT', '/api/settings' + suffix, {
        imageGen: { codex: { codexPath: '/example/codex' } },
      })).toEqual(['imageGen.codex.codexPath']);
    }
    expect(isHostControlRoute('POST', '/api/runs-example//')).toBe(false);
    expect(isHostControlRoute('POST', '/api//runs')).toBe(false);

    expect(isHostControlRoute('PUT', '/api/apps/example-app/documents/docs/example.md')).toBe(true);
    // Read-only GETs and neighbouring paths stay open.
    expect(isHostControlRoute('GET', '/api/apps/example-app/start')).toBe(false);
    expect(isHostControlRoute('GET', '/api/git/submodules/status')).toBe(false);
    expect(isHostControlRoute('POST', '/api/apps/example-app/start-example')).toBe(false);
    expect(isHostControlRoute('POST', '/api/apps/example-app/archive')).toBe(false);
    // The policy-store body gate matches the same spellings (#8721).
    expect(hostControlBodyKeys('put', '/API/Settings/', { harnesses: {}, location: {} })).toEqual(['harnesses']);
    expect(hostControlBodyKeys('PUT', '/api/COS/config', { avatarStyle: 'svg', mcpServers: [] })).toEqual(['mcpServers']);
    expect(hostControlBodyKeys('PUT', '/api/settings/credentials/example', { harnesses: {} })).toEqual([]);
  });
});

// Every mutation in these audited routers must be gated or explicitly reviewed
// as a data/inference operation. A new route fails closed at review time instead
// of silently falling through the inventory's one-way "listed routes exist" check.
describe('browser/runtime/database mutation inventory (#8798, #8897)', () => {
  const dataOrInference = [
    'POST /api/browser/navigate',
    'DELETE /api/browser/downloads/:name',
    'POST /api/harnesses/models/refresh',
    ...[
      'laya-mlx/score',
      'security-guard/install/cancel',
      'jev/install/cancel', 'jev/score', 'jev/unload',
      'download-preflight', 'install', 'delete', 'switch', 'migrate', 'unload',
      'test', 'test/stream', 'compare',
      'assessments/run', 'assessments/sweep', 'assessments/sweep/cancel', 'assessments/delete',
      // /run is body-gated for sandbox-repair; ordinary inference stays open.
      'capability-tests/run', 'capability-tests/delete',
      'llama-server/download-model', 'llama-server/download-model/cancel', 'llama-server/download-model/remove',
      'mtplx/models/pull', 'mtplx/models/remove',
      'slotstream/models/download', 'slotstream/models/download/cancel',
    ].map(path => `POST /api/local-llm/${path}`),
    // Advisory and read-only: validates cutover preconditions, runs nothing (#8897).
    'POST /api/database/maintenance/preflight',
  ];

  it('classifies every mounted mutation and keeps reviewed data/inference operations open', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method)
      && /^\/api\/(browser|database|harnesses|local-llm)(\/|$)/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...dataOrInference].sort());
  });
});


describe('prompt-feeding store and Digital Twin mutation inventory (#9040, #10671)', () => {
  // Reviewed reference-data CRUD, fixed-provider inference, previews and stops.
  // Twin settings alone are body-gated in their handler; memories and twin
  // documents/traits are fenced at prompt assembly. Keep this list explicit:
  // adding a mutation requires a new authority/reference-data decision.
  const referenceDataOrRead = [
    "DELETE /api/cos/mind/attachments/:attachmentId",
    "DELETE /api/cos/mind/thinking-request",
    "DELETE /api/digital-twin/autobiography/stories/:id",
    "DELETE /api/digital-twin/documents/:id",
    "DELETE /api/digital-twin/identity/goals/:id",
    "DELETE /api/digital-twin/identity/goals/:id/activities/:activityName",
    "DELETE /api/digital-twin/identity/goals/:id/calendars/:subcalendarId",
    "DELETE /api/digital-twin/identity/goals/:id/progress/:entryId",
    "DELETE /api/digital-twin/identity/goals/:id/schedule",
    "DELETE /api/digital-twin/identity/goals/:id/todos/:todoId",
    "DELETE /api/digital-twin/personas/:id",
    "DELETE /api/digital-twin/snapshots/:id",
    "DELETE /api/digital-twin/social-accounts/:id",
    "DELETE /api/digital-twin/taste/:section",
    "DELETE /api/memory/:id",
    "DELETE /api/memory/expired",
    "DELETE /api/prompts/:stage",
    "DELETE /api/prompts/variables/:key",
    "DELETE /api/tools/:id",
    "POST /api/cos/mind/bundle/export",
    "POST /api/cos/mind/bundle/preview",
    "POST /api/cos/mind/cleanup",
    "POST /api/cos/mind/events/:eventId/acknowledge",
    "POST /api/cos/mind/events/:eventId/promote",
    "POST /api/cos/mind/memories",
    "POST /api/cos/mind/pause",
    "POST /api/cos/mind/recipes/:recipeId/archive",
    "POST /api/cos/mind/recipes/validate",
    "POST /api/cos/mind/stop",
    "POST /api/digital-twin/autobiography/stories",
    "POST /api/digital-twin/autobiography/stories/:id/evaluate",
    "POST /api/digital-twin/autobiography/stories/:id/follow-ups",
    "POST /api/digital-twin/autobiography/stories/:id/weave",
    "POST /api/digital-twin/autobiography/trigger",
    "POST /api/digital-twin/documents",
    "POST /api/digital-twin/enrich/save-list",
    "POST /api/digital-twin/export",
    "POST /api/digital-twin/feedback",
    "POST /api/digital-twin/feedback/recalculate",
    "POST /api/digital-twin/identity/chronotype/derive",
    "POST /api/digital-twin/identity/goals",
    "POST /api/digital-twin/identity/goals/:id/accept-decomposition",
    "POST /api/digital-twin/identity/goals/:id/accept-phases",
    "POST /api/digital-twin/identity/goals/:id/activities",
    "POST /api/digital-twin/identity/goals/:id/calendars",
    "POST /api/digital-twin/identity/goals/:id/check-in",
    "POST /api/digital-twin/identity/goals/:id/decompose",
    "POST /api/digital-twin/identity/goals/:id/generate-phases",
    "POST /api/digital-twin/identity/goals/:id/milestones",
    "POST /api/digital-twin/identity/goals/:id/progress",
    "POST /api/digital-twin/identity/goals/:id/reschedule",
    "POST /api/digital-twin/identity/goals/:id/schedule",
    "POST /api/digital-twin/identity/goals/:id/todos",
    "POST /api/digital-twin/identity/goals/organize",
    "POST /api/digital-twin/identity/goals/organize/apply",
    "POST /api/digital-twin/identity/image",
    "POST /api/digital-twin/identity/image/save",
    "POST /api/digital-twin/identity/longevity/derive",
    "POST /api/digital-twin/import/save",
    "POST /api/digital-twin/import/spotify/browser/open",
    "POST /api/digital-twin/snapshots",
    "POST /api/digital-twin/snapshots/compare",
    "POST /api/digital-twin/social-accounts",
    "POST /api/digital-twin/social-accounts/bulk",
    "POST /api/digital-twin/taste/:section/personalized-question",
    "POST /api/digital-twin/taste/answer",
    "POST /api/digital-twin/taste/summary",
    "POST /api/digital-twin/twin-evidence/recompute",
    "POST /api/memory",
    "POST /api/memory/:id/approve",
    "POST /api/memory/:id/reject",
    "POST /api/memory/consolidate",
    "POST /api/memory/decay",
    "POST /api/memory/link",
    "POST /api/memory/search",
    "POST /api/memory/sync",
    "POST /api/prompts/:stage/preview",
    "POST /api/prompts/reload",
    "PUT /api/cos/mind/memories/:memoryId",
    "PUT /api/digital-twin/autobiography/config",
    "PUT /api/digital-twin/autobiography/stories/:id",
    "PUT /api/digital-twin/documents/:id",
    "PUT /api/digital-twin/identity/chronotype",
    "PUT /api/digital-twin/identity/goals/:id",
    "PUT /api/digital-twin/identity/goals/:id/milestones/:milestoneId/complete",
    "PUT /api/digital-twin/identity/goals/:id/milestones/:milestoneId/tasks/:taskId/complete",
    "PUT /api/digital-twin/identity/goals/:id/progress",
    "PUT /api/digital-twin/identity/goals/:id/todos/:todoId",
    "PUT /api/digital-twin/identity/goals/birth-date",
    "PUT /api/digital-twin/settings",
    "PUT /api/digital-twin/social-accounts/:id",
    "PUT /api/digital-twin/traits",
    "PUT /api/memory/:id"
];

  it('classifies every mounted mutation, including tool writes and process-capable Digital Twin actions', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method)
      && /^\/api\/(?:(tools|prompts|memory|digital-twin)(\/|$)|cos\/(mind|goal-fidelity)(\/|$))/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => method + ' ' + path);
    expect([...new Set(open)].sort()).toEqual([...referenceDataOrRead].sort());
    expect(isHostControlRoute('POST', '/api/tools')).toBe(true);
    expect(isHostControlRoute('PUT', '/api/tools/:id')).toBe(true);
  });
});

describe('media generation and source publication policy (#9667)', () => {
  it('classifies agent-capable requests independently of backend and keeps contained operations open', () => {
    const protectedRoutes = [
      'POST /api/image-gen/generate',
      'POST /api/image-gen/avatar',
      'POST /api/video-gen',
      'POST /api/sprites/:id/reference/generate',
      'POST /api/sprites/:id/fork',
      'POST /api/sprites/:id/walk/generate',
      'POST /api/sprites/:id/tracks/:trackId/generate',
      'POST /api/threejs-models',
      'POST /api/threejs-models/:id/generate',
      'PUT /api/sprites/:id/publish-binding',
      'POST /api/sprites/:id/atlas/publish',
    ];
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
    for (const [method, path] of [
      ['GET', '/api/threejs-models'],
      ['GET', '/api/image-gen/status'],
      ['POST', '/api/image-gen/cancel'],
      ['POST', '/api/video-gen/cancel'],
      ['POST', '/api/sprites/:id/atlas/compile'],
      ['POST', '/api/html-composition/render'],
    ]) expect(isHostControlRoute(method, path), path).toBe(false);
  });
});

describe('auxiliary media mutation inventory (#9672)', () => {
  // Reviewed as record CRUD, cancellation/pruning or deterministic work that
  // never hands caller text to an agent. A new mutation needs a new decision.
  const recordOrContained = [
    'DELETE /api/lora-datasets/:id',
    'DELETE /api/lora-datasets/:id/images/:imageId',
    'DELETE /api/media-jobs/:id',
    'PATCH /api/lora-datasets/:id',
    'PATCH /api/lora-datasets/:id/images/:imageId',
    'POST /api/lora-datasets',
    'POST /api/lora-datasets/:id/caption-runs/:runId/cancel',
    'POST /api/lora-datasets/:id/import-gallery',
    'POST /api/lora-datasets/:id/images',
    'POST /api/lora-datasets/:id/strip-shared-fragments',
    'POST /api/media-jobs/:id/cancel',
    'POST /api/media-jobs/cancel-queued',
    'POST /api/media-jobs/holds/:holdId/resume',
  ];

  it('gates every agent-dispatching mutation and keeps reviewed record operations open', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/(media-jobs|lora-datasets)(\/|$)/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...recordOrContained].sort());
  });
});


describe('Pipeline authoring policy (#10068)', () => {
  const protectedRoutes = [
    'POST /api/pipeline/series/:id/generate-title-logo',
    'POST /api/pipeline/issues/:id/stages/:stageId/generate',
    'POST /api/pipeline/issues/:id/auto-run-text',
    'POST /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/refine-prompt',
    'POST /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex/panels/:panelIndex/image-prompts',
    'POST /api/pipeline/issues/:id/stages/storyboards/scenes/:index/refine-prompt',
    'POST /api/pipeline/issues/:id/stages/storyboards/scenes/:index/image-prompts',
    'POST /api/pipeline/issues/:id/stages/:stageId/visual',
    'POST /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex/render',
    'POST /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex/refine-render',
    'POST /api/pipeline/issues/:id/stages/storyboards/scenes/:sceneIndex/shots/:shotIndex/render',
  ];

  it('gates each audited operation and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
  });

  it('keeps record CRUD, reads and cancellation open', () => {
    for (const [method, path] of [
      ['GET', '/api/pipeline/series/:id'],
      ['PATCH', '/api/pipeline/series/:id'],
      ['PATCH', '/api/pipeline/issues/:id'],
      ['DELETE', '/api/pipeline/issues/:id'],
      ['POST', '/api/pipeline/issues/:id/auto-run-text/cancel'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Pipeline authoring remainder policy (#10907)', () => {
  // Operations that reach runStagedLLM (or the cover render queue) with a
  // caller-chosen provider; the whole operation needs operator authority.
  const protectedRoutes = [
    'POST /api/pipeline/series/generate-concept',
    'POST /api/pipeline/series/merge/ai-resolve',
    'POST /api/pipeline/series/:id/discover-voice',
    'POST /api/pipeline/series/:id/arc/generate',
    'POST /api/pipeline/series/:id/arc/verify',
    'POST /api/pipeline/series/:id/arc/resolve-issues',
    'POST /api/pipeline/series/:id/arc/derive-from-manuscript',
    'POST /api/pipeline/series/:id/seasons/:seasonId/episodes/generate',
    'POST /api/pipeline/series/:id/seasons/:seasonId/verify',
    'POST /api/pipeline/series/:id/seasons/:seasonId/generate-beats',
    'POST /api/pipeline/series/:id/seasons/:seasonId/cover-concepts/generate',
    'POST /api/pipeline/series/:id/seasons/:seasonId/cover/render',
    'POST /api/pipeline/series/:id/seasons/:seasonId/back-cover/render',
    'POST /api/pipeline/series/:id/reverse-outline/generate',
    'POST /api/pipeline/series/:id/continuity-bible/generate',
    'POST /api/pipeline/issues/:id/pov-rewrites',
    'POST /api/pipeline/series/:id/manuscript/completeness',
    'POST /api/pipeline/series/:id/manuscript/completeness/stream',
    'POST /api/pipeline/series/:id/manuscript/review/comments/:commentId/fix',
    'POST /api/pipeline/series/:id/manuscript/reformat',
    'POST /api/pipeline/issues/:id/editorial/analyze',
    'POST /api/pipeline/series/:id/editorial/analyze',
    'POST /api/pipeline/issues/:id/judge',
    'POST /api/pipeline/series/:id/editorial/panel/run',
    'POST /api/pipeline/series/:id/editorial/rank',
    'POST /api/pipeline/series/:id/review',
    'POST /api/pipeline/series/:id/review/fix',
    'POST /api/pipeline/series/:id/editorial/checks/run',
    'POST /api/pipeline/series/:id/editorial/custom-checks/preview',
    'POST /api/pipeline/issues/:id/cover-concepts/generate',
    'POST /api/pipeline/issues/:id/stages/comicPages/cover/render',
    'POST /api/pipeline/issues/:id/stages/comicPages/back-cover/render',
    'POST /api/pipeline/issues/:id/stages/storyboards/extract-scenes',
    'POST /api/pipeline/issues/:id/stages/:stageId/extract-canon',
    'POST /api/pipeline/issues/:id/stages/:stageId/describe-canon',
    'POST /api/pipeline/issues/:id/stages/audio/cues/generate',
  ];
  // Reviewed Pipeline mutations that never reach the staged runner: record
  // CRUD, cancellation, deterministic transforms and local-sidecar media.
  const recordOrContained = [
    'DELETE /api/pipeline/audio/music-library/:filename',
    'DELETE /api/pipeline/issues/:id',
    'DELETE /api/pipeline/issues/:id/pov-rewrites/:rewriteId',
    'DELETE /api/pipeline/issues/:id/stages/audio/music',
    'DELETE /api/pipeline/series/:id',
    'DELETE /api/pipeline/series/:id/seasons/:seasonId',
    'DELETE /api/pipeline/editorial/custom-checks/:id',
    'PATCH /api/pipeline/editorial/checks/:id',
    'PATCH /api/pipeline/editorial/custom-checks/:id',
    'PATCH /api/pipeline/editorial/readiness-gate',
    'PATCH /api/pipeline/issues/:id',
    'PATCH /api/pipeline/issues/:id/stages/audio/lines/:lineIdx',
    'PATCH /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex',
    'PATCH /api/pipeline/series/:id',
    'PATCH /api/pipeline/series/:id/arc-fields/:field/lock',
    'PATCH /api/pipeline/series/:id/manuscript/review/comments/:commentId',
    'PATCH /api/pipeline/series/:id/seasons/:seasonId',
    'PATCH /api/pipeline/tts/narrate/segment',
    'POST /api/pipeline/editorial/custom-checks',
    'POST /api/pipeline/issues/:id/auto-run-text/cancel',
    'POST /api/pipeline/issues/:id/stages/:stageId/restore',
    'POST /api/pipeline/issues/:id/stages/audio/cues/:cueIdx/render',
    'POST /api/pipeline/issues/:id/stages/audio/extract-lines',
    'POST /api/pipeline/issues/:id/stages/audio/lines/:lineIdx/render',
    'POST /api/pipeline/issues/:id/stages/audio/music/attach',
    'POST /api/pipeline/issues/:id/stages/audio/music/generate',
    'POST /api/pipeline/issues/:id/stages/audio/music/upload',
    'POST /api/pipeline/issues/:id/stages/comicPages/extract-pages',
    'POST /api/pipeline/issues/:id/stages/storyboards/scenes/:index/video',
    'POST /api/pipeline/series',
    'POST /api/pipeline/series/:id/arc/derive-from-manuscript/commit',
    'POST /api/pipeline/series/:id/autopilot/cancel',
    'POST /api/pipeline/series/:id/autopilot/model-outcomes',
    'POST /api/pipeline/series/:id/autopilot/pause',
    'POST /api/pipeline/series/:id/continuity-bible/generate/cancel',
    'POST /api/pipeline/series/:id/editorial/analyze/cancel',
    'POST /api/pipeline/series/:id/editorial/checks/run/cancel',
    'POST /api/pipeline/series/:id/editorial/panel/run/cancel',
    'POST /api/pipeline/series/:id/issues',
    'POST /api/pipeline/series/:id/manuscript/completeness/cancel',
    'POST /api/pipeline/series/:id/manuscript/cuts/apply',
    'POST /api/pipeline/series/:id/manuscript/cuts/preview',
    'POST /api/pipeline/series/:id/manuscript/review/comments/:commentId/accept',
    'POST /api/pipeline/series/:id/manuscript/review/comments/:commentId/undo',
    'POST /api/pipeline/series/:id/reverse-outline/generate/cancel',
    'POST /api/pipeline/series/:id/review/cancel',
    'POST /api/pipeline/series/:id/review/fix/cancel',
    'POST /api/pipeline/series/:id/seasons',
    'POST /api/pipeline/series/:id/seasons/:seasonId/generate-beats/cancel',
    'POST /api/pipeline/series/merge',
    'POST /api/pipeline/series/merge/preview',
    'POST /api/pipeline/tts/narrate',
    'POST /api/pipeline/tts/narrate/segment',
    'POST /api/pipeline/tts/preview',
    'POST /api/pipeline/tts/synthesize',
    'PUT /api/pipeline/series/:id/manuscript/sections/:issueId',
  ];

  it('gates each audited operation and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
  });

  it('classifies every mounted Pipeline mutation: gated, or reviewed as non-agent', () => {
    const open = getApiRouteCatalog().routes
      .filter(({ method, path }) => /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/pipeline(\/|$)/.test(path))
      .filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...recordOrContained].sort());
  });
});

describe('Music Video agent workflow policy (#9869)', () => {
  it('gates mounted agent workflows and keeps record, cancellation and contained rendering contracts', () => {
    const protectedRoutes = [
      'POST /api/music-video/:id/plan',
      'POST /api/music-video/:id/treatment/compile',
      'POST /api/music-video/:id/publish-kit/copy',
      'POST /api/music-video/:id/cast-and-sets',
      'POST /api/music-video/:id/cast-and-sets/regenerate',
      'PATCH /api/music-video/:id/cast-and-sets/direction',
      'POST /api/music-video/:id/cast-and-sets/resume',
      'POST /api/music-video/:id/code/generate',
      'POST /api/music-video/:id/code/sections/:sectionId/regenerate',
      'POST /api/music-video/:id/composition/document/generate',
      'POST /api/music-video/:id/composition/document/events/revise',
      'POST /api/music-video/:id/composition/document/sections/:sectionId/regenerate',
      'POST /api/music-video/:id/production-runs',
      'POST /api/music-video/:id/production-runs/:runId/resume',
      'POST /api/music-video/:id/auto-reviews',
      'POST /api/music-video/:id/auto-reviews/:runId/resume',
    ];
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
    for (const route of [
      'GET /api/music-video/:id',
      'PATCH /api/music-video/:id',
      'POST /api/music-video/:id/production-runs/:runId/stop',
      'POST /api/music-video/:id/production-runs/:runId/cancel',
      'POST /api/music-video/:id/auto-reviews/:runId/stop',
      'POST /api/music-video/:id/auto-reviews/:runId/cancel',
      'POST /api/music-video/:id/composition/document/directory',
      'GET /api/music-video/:id/composition/document',
      'POST /api/music-video/:id/render',
      'POST /api/music-video/:id/publish-kit/build',
      'POST /api/music-video/:id/publish/:target/prepare',
    ]) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(isHostControlRoute(method, path), route).toBe(false);
    }
  });
});


describe('FableLoom mutation inventory (#10668)', () => {
  // Reviewed record mutations, deterministic checks/planning, cancellation,
  // session bookkeeping and fixed browser automation. New routes need review.
  const recordOrContained = [
    'POST /api/fableloom',
    'PATCH /api/fableloom/:id',
    'DELETE /api/fableloom/:id',
    'POST /api/fableloom/:id/editorial/autopilot/:runId/cancel',
    'POST /api/fableloom/:id/episodes',
    'PATCH /api/fableloom/:id/episodes/:episodeId',
    'DELETE /api/fableloom/:id/episodes/:episodeId',
    'POST /api/fableloom/:id/episodes/:episodeId/nodes',
    'PATCH /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId',
    'DELETE /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId',
    'POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/fal-video',
    'POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions',
    'PATCH /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId',
    'DELETE /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId',
    'POST /api/fableloom/:id/episodes/:episodeId/shots/apply',
    'POST /api/fableloom/:id/episodes/:episodeId/outline/validate',
    'POST /api/fableloom/:id/episodes/:episodeId/sessions/preflight',
    'POST /api/fableloom/:id/episodes/:episodeId/sessions/host',
    'PATCH /api/fableloom/sessions/:sessionId',
    'DELETE /api/fableloom/sessions/:sessionId',
    'POST /api/fableloom/:id/episodes/:episodeId/production/plan',
    'POST /api/fableloom/:id/episodes/:episodeId/production/batch/:runId/cancel',
    'POST /api/fableloom/:id/episodes/:episodeId/continuity/review',
  ];

  it('gates every agent-capable mutation and preserves reviewed contained operations', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/fableloom(\/|$)/.test(path));
    const open = mutations.filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...recordOrContained].sort());
  });
});

describe('Creative Director and Creative Commissions mutation inventory (#10867)', () => {
  // Reviewed operations that only reduce execution or remove records. Every
  // other mutation steers, enqueues or arms writable agents and needs host
  // control; a new route must be classified here or in HOST_CONTROL_ROUTES.
  const reduceOrRemove = [
    'POST /api/creative-director/:id/pause',
    'POST /api/creative-director/:id/stop',
    'DELETE /api/creative-director/:id',
    'POST /api/creative-director/auto-cast/suggest',
    'DELETE /api/creative-commission/:id',
  ];

  const mutations = () => getApiRouteCatalog().routes.filter(({ method, path }) =>
    /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/creative-(director|commission)(\/|$)/.test(path));

  it('gates every execution or steering mutation and explicitly preserves the harmless five', () => {
    const open = mutations().filter(({ method, path }) => !isHostControlRoute(method, path))
      .map(({ method, path }) => `${method} ${path}`);
    expect([...new Set(open)].sort()).toEqual([...reduceOrRemove].sort());
    expect(new Set(mutations().map(({ method, path }) => `${method} ${path}`)).size).toBe(22);
  });
});

describe('Caller-prompted AI outside Pipeline policy (#10908)', () => {
  // Free caller text and/or a caller-chosen provider reach the prompt runner
  // with no tool-free restriction, so a CLI/TUI provider runs as an agent.
  const protectedRoutes = [
    'POST /api/games/:id/feedback',
    'POST /api/rounds/generate',
    'POST /api/rounds/:id/generate',
    'POST /api/rounds/:id/evaluate',
    'POST /api/rounds/:id/derive-parts',
    'POST /api/agents/personalities/generate',
    'POST /api/system-resources/triage',
    'POST /api/mood-boards/:id/synthesize-style',
    'POST /api/mood-boards/:id/compose-prompt',
    'POST /api/mood-boards/:id/analyze',
    'POST /api/cos/tasks/enhance',
  ];

  it('gates each audited operation and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
  });

  it('keeps record CRUD and reads in those families open', () => {
    for (const [method, path] of [
      ['POST', '/api/games'],
      ['PATCH', '/api/games/:id'],
      ['POST', '/api/rounds'],
      ['PATCH', '/api/rounds/:id'],
      ['PUT', '/api/agents/personalities/:id'],
      ['GET', '/api/system-resources/models/manifest'],
      ['PATCH', '/api/mood-boards/:id'],
      ['GET', '/api/mood-boards/:id/analyze'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('3D model rigging host-workers (#10922)', () => {
  const protectedRoutes = [
    'POST /api/rigging/models/:id',
    'POST /api/rigging/models/:id/retarget',

describe('Remote desktop session policy (#10923)', () => {
  const protectedRoutes = [
    'POST /api/remote-desktop/sessions',
  ];

  it('gates each route and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
  });

  it('keeps reads open', () => {
    for (const [method, path] of [
      ['GET', '/api/rigging/models/:id'],

      ['GET', '/api/remote-desktop/status'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});
