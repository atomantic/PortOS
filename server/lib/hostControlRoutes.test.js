import { describe, expect, it } from 'vitest';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import { HOST_CONTROL_ROUTES, hostControlBodyKeys, hostControlSettingsPathsIn, hostControlRouteFor, isHostControlRoute } from './hostControlRoutes.js';

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


describe('prompt-feeding store mutation inventory (#9040)', () => {
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
    "POST /api/digital-twin/adversarial-tests/run",
    "POST /api/digital-twin/analyze-writing",
    "POST /api/digital-twin/autobiography/stories",
    "POST /api/digital-twin/autobiography/stories/:id/evaluate",
    "POST /api/digital-twin/autobiography/stories/:id/follow-ups",
    "POST /api/digital-twin/autobiography/stories/:id/weave",
    "POST /api/digital-twin/autobiography/trigger",
    "POST /api/digital-twin/avatar-bio/polish",
    "POST /api/digital-twin/confidence/calculate",
    "POST /api/digital-twin/documents",
    "POST /api/digital-twin/enrich/analyze-list",
    "POST /api/digital-twin/enrich/answer",
    "POST /api/digital-twin/enrich/question",
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
    "POST /api/digital-twin/import/analyze",
    "POST /api/digital-twin/import/save",
    "POST /api/digital-twin/import/spotify/browser/import",
    "POST /api/digital-twin/import/spotify/browser/open",
    "POST /api/digital-twin/interview/analyze",
    "POST /api/digital-twin/multi-turn-tests/run",
    "POST /api/digital-twin/snapshots",
    "POST /api/digital-twin/snapshots/compare",
    "POST /api/digital-twin/social-accounts",
    "POST /api/digital-twin/social-accounts/bulk",
    "POST /api/digital-twin/style/spoken-written",
    "POST /api/digital-twin/taste/:section/personalized-question",
    "POST /api/digital-twin/taste/answer",
    "POST /api/digital-twin/taste/summary",
    "POST /api/digital-twin/tests/generate",
    "POST /api/digital-twin/tests/run",
    "POST /api/digital-twin/tests/run-multi",
    "POST /api/digital-twin/traits/analyze",
    "POST /api/digital-twin/twin-evidence/interpret",
    "POST /api/digital-twin/twin-evidence/recompute",
    "POST /api/digital-twin/validate/contradictions",
    "POST /api/digital-twin/values-tests/run",
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

  it('classifies every mounted mutation, including the tool writes from #9014', () => {
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
      'POST /api/music-video/:id/publish/drafts/:draftId/submit',
    ]) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(isHostControlRoute(method, path), route).toBe(false);
    }
  });
});
