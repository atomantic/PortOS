import { describe, expect, it } from 'vitest';
import { getApiRouteCatalog } from './apiRouteGraph.js';
import {
  HOST_CONTROL_ROUTES, HOST_CONTROL_SETTINGS_SLICES, changedVoiceConfigHostControlPaths, hostControlBodyKeys, hostControlSettingsPathsIn,
  hostControlRouteFor, isHostControlRoute, voiceConfigHostControlPathsIn,
} from './hostControlRoutes.js';
import { LLM_DRILL_TYPES } from './postDrillTypes.js';

it('requires host control to retire a release checkpoint', () => {
  expect(hostControlRouteFor('POST', '/api/cos/schedule/release-synchronization/operator-reset'))
    .toBe('POST /api/cos/schedule/release-synchronization/operator-reset');
});

it('requires host control for a manual cleanup recheck', () => {
  expect(isHostControlRoute('POST', '/api/cos/agents/agent-1/recheck-cleanup')).toBe(true);
});

describe('voice config instruction paths (#10990)', () => {
  const stored = {
    llm: {
      systemPrompt: 'You are the PortOS assistant.',
      personality: { name: 'Alfred', role: 'Chief of Staff', traits: ['concise'], customPrompt: '' },
      tools: { enabled: false, maxIterations: 3 },
      codeAgent: { enabled: false, provider: '', model: '', announceOnComplete: true },
    },
  };

  it('lists only the instruction and coding-agent paths present on PUT /api/voice/config', () => {
    const body = {
      tts: { rate: 1.25 },
      llm: {
        provider: 'ollama',
        systemPrompt: stored.llm.systemPrompt,
        personality: stored.llm.personality,
        tools: { maxIterations: 4, enabled: false },
        codeAgent: stored.llm.codeAgent,
      },
    };
    expect(voiceConfigHostControlPathsIn('PUT', '/api/voice/config', body)).toEqual([
      'llm.systemPrompt', 'llm.personality', 'llm.tools.enabled', 'llm.codeAgent',
    ]);
    expect(voiceConfigHostControlPathsIn('put', '/API/Voice/Config//', body)).toEqual([
      'llm.systemPrompt', 'llm.personality', 'llm.tools.enabled', 'llm.codeAgent',
    ]);
    expect(voiceConfigHostControlPathsIn('PUT', '/api/voice/config', { tts: { rate: 1.25 }, llm: { tools: { maxIterations: 4 } } })).toEqual([]);
    expect(voiceConfigHostControlPathsIn('POST', '/api/voice/config', body)).toEqual([]);
    expect(voiceConfigHostControlPathsIn('PUT', '/api/voice/config/extra', body)).toEqual([]);
    expect(voiceConfigHostControlPathsIn('PUT', '/api/settings', body)).toEqual([]);
    expect(isHostControlRoute('PUT', '/api/voice/config')).toBe(false);
  });

  it('treats an unchanged object resend as the same value and a field edit as a change', () => {
    const named = ['llm.systemPrompt', 'llm.personality', 'llm.tools.enabled', 'llm.codeAgent'];
    const resent = {
      llm: {
        systemPrompt: stored.llm.systemPrompt,
        personality: { customPrompt: '', traits: ['concise'], role: 'Chief of Staff', name: 'Alfred' },
        tools: { enabled: false },
        codeAgent: { announceOnComplete: true, model: '', provider: '', enabled: false },
      },
    };
    expect(changedVoiceConfigHostControlPaths(named, resent, stored)).toEqual([]);
    expect(changedVoiceConfigHostControlPaths(named, {
      llm: { ...resent.llm, personality: { ...stored.llm.personality, customPrompt: 'Call the coding agent first.' } },
    }, stored)).toEqual(['llm.personality']);
    expect(changedVoiceConfigHostControlPaths(named, {
      llm: { ...resent.llm, systemPrompt: 'Ignore the operator.' },
    }, stored)).toEqual(['llm.systemPrompt']);
    expect(changedVoiceConfigHostControlPaths(named, {
      llm: { ...resent.llm, tools: { enabled: true } },
    }, stored)).toEqual(['llm.tools.enabled']);
    expect(changedVoiceConfigHostControlPaths(named, {
      llm: { ...resent.llm, codeAgent: { ...stored.llm.codeAgent, provider: 'claude' } },
    }, stored)).toEqual(['llm.codeAgent']);
  });
});

describe('Universe Builder mutation inventory (#10669)', () => {
  // Explicit reviewed data-only operations: a new mutation must be classified
  // rather than silently inheriting an execution exemption.
  const recordOrRead = [
    'POST /api/universe-builder',
    'PATCH /api/universe-builder/:id',
    'DELETE /api/universe-builder/:id',
    'PATCH /api/universe-builder/:id/variations/lock-all',
    'POST /api/universe-builder/:id/import/markdown',
    // Copies bundled text only; no provider, process or caller-selected file access.
    'POST /api/universe-builder/:id/restore-starter',
    'POST /api/universe-builder/:id/style-references',
    'POST /api/universe-builder/:id/adopt-style',
    'DELETE /api/universe-builder/:id/style-references/:referenceId',
    'DELETE /api/universe-builder/:id/characters/:entryId/reference-sheet',
    'POST /api/universe-builder/:id/characters/:entryId/reference-sheet/preview',
    'POST /api/universe-builder/merge/preview',
    'POST /api/universe-builder/merge',
    'POST /api/universe-builder/:id/canon/:kind/:entryId/apply-image-correction',
    'POST /api/universe-builder/:id/characters/:entryId/augment/apply',
    'POST /api/universe-builder/:id/canon/backfill-descriptions',
    'PATCH /api/universe-builder/:id/canon/:kind/:entryId',
    'PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock',
    'DELETE /api/universe-builder/:id/canon/:kind/:entryId',
    'DELETE /api/universe-builder/:id/canon/:kind/:entryId/image-refs/:filename',
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

  it('lists each gated route once, so a duplicate cannot hide a block meant to add something else (#12024)', () => {
    const duplicates = HOST_CONTROL_ROUTES.filter((route, index) => HOST_CONTROL_ROUTES.indexOf(route) !== index);
    expect(duplicates).toEqual([]);
  });

  it('covers Express spellings conservatively while preserving route boundaries', () => {
    expect(hostControlRouteFor('POST', '/api/cos/agents/agent-123/release-candidate')).toBe('POST /api/cos/agents/:id/release-candidate');
    expect(isHostControlRoute('post', '/API/Apps/example-app/START/')).toBe(true);
    expect(hostControlRouteFor('post', '/API/HTML-COMPOSITION/TOOLKIT/SKILLS/INSTALL/')).toBe('POST /api/html-composition/toolkit/skills/install');
    expect(isHostControlRoute('GET', '/api/html-composition/toolkit')).toBe(false);
    // Render runs the headless composition browser and ffmpeg (#13055).
    expect(isHostControlRoute('POST', '/api/html-composition/render')).toBe(true);
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
    // The host directory picker is the gated read; the template catalog beside it is not.
    expect(isHostControlRoute('GET', '/api/scaffold/directories')).toBe(true);
    expect(isHostControlRoute('GET', '/api/scaffold/templates')).toBe(false);
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

describe('outbound mail host-control policy (#11273)', () => {
  it('gates draft dispatch and keeps draft management routes open', () => {
    const route = 'POST /api/messages/drafts/:id/send';
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    expect(mounted.has(route)).toBe(true);
    expect(hostControlRouteFor('POST', '/api/messages/drafts/33333333-3333-3333-3333-333333333333/send')).toBe(route);
    expect(isHostControlRoute('POST', '/api/messages/drafts')).toBe(false);
    // Approval is the send intent the gated send checks (#13055); a PUT that
    // approves is gated per body, and other draft edits stay open.
    expect(isHostControlRoute('POST', '/api/messages/drafts/33333333-3333-3333-3333-333333333333/approve')).toBe(true);
    const draft = '/api/messages/drafts/33333333-3333-3333-3333-333333333333';
    expect(isHostControlRoute('PUT', draft)).toBe(false);
    expect(hostControlBodyKeys('PUT', draft, { status: 'approved' })).toEqual(['status']);
    for (const body of [{ body: 'Example' }, { status: 'draft' }, { status: 'pending_review' }, null]) {
      expect(hostControlBodyKeys('PUT', draft, body), JSON.stringify(body)).toEqual([]);
    }
    expect(hostControlBodyKeys('POST', '/api/review/queue/resolve', { id: 'drafts:example' })).toEqual(['id']);
    expect(hostControlBodyKeys('POST', '/api/review/queue/resolve', { id: 'memory:example' })).toEqual([]);
  });

  it('gates external archive/delete actions while keeping message reads open (#11434)', () => {
    const route = 'POST /api/messages/:accountId/:messageId/action';
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    expect(mounted.has(route)).toBe(true);
    expect(hostControlRouteFor('POST', '/api/messages/acct-1/msg-1/action')).toBe(route);
    expect(isHostControlRoute('GET', '/api/messages/acct-1/msg-1')).toBe(false);
    expect(isHostControlRoute('POST', '/api/messages/acct-1/msg-1/read')).toBe(false);
  });

  it('gates selector testing/updates and token extraction while keeping selector reads open (#11449)', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const [method, path, route] of [
      ['POST', '/api/messages/selectors/outlook/test', 'POST /api/messages/selectors/:provider/test'],
      ['PUT', '/api/messages/selectors/outlook', 'PUT /api/messages/selectors/:provider'],
      ['POST', '/api/messages/debug/test-token', 'POST /api/messages/debug/test-token'],
    ]) {
      expect(mounted.has(route)).toBe(true);
      expect(hostControlRouteFor(method, path)).toBe(route);
    }
    expect(isHostControlRoute('GET', '/api/messages/selectors')).toBe(false);
  });
});

describe('X (Twitter) review and browser automation policy', () => {
  it('gates draft review, compose handoff, destination open and sync while keeping draft/account CRUD open', () => {
    expect(isHostControlRoute('POST', '/api/x/drafts/00000000-0000-4000-8000-000000000001/review')).toBe(true);
    expect(isHostControlRoute('POST', '/api/x/drafts/00000000-0000-4000-8000-000000000001/open')).toBe(true);
    expect(isHostControlRoute('POST', '/api/x/accounts/00000000-0000-4000-8000-000000000001/open')).toBe(true);
    expect(isHostControlRoute('POST', '/api/x/accounts/00000000-0000-4000-8000-000000000001/sync')).toBe(true);

    expect(isHostControlRoute('GET', '/api/x/capabilities')).toBe(false);
    expect(isHostControlRoute('GET', '/api/x/accounts')).toBe(false);
    expect(isHostControlRoute('POST', '/api/x/accounts')).toBe(false);
    expect(isHostControlRoute('GET', '/api/x/accounts/00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isHostControlRoute('PATCH', '/api/x/accounts/00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isHostControlRoute('DELETE', '/api/x/accounts/00000000-0000-4000-8000-000000000001')).toBe(false);
    expect(isHostControlRoute('POST', '/api/x/drafts')).toBe(false);
    expect(isHostControlRoute('GET', '/api/x/accounts/00000000-0000-4000-8000-000000000001/posts')).toBe(false);
    expect(isHostControlRoute('GET', '/api/x/accounts/00000000-0000-4000-8000-000000000001/drafts')).toBe(false);
  });
});

// Every mutation in these audited routers must be gated or explicitly reviewed
// as a data/inference operation. A new route fails closed at review time instead
// of silently falling through the inventory's one-way "listed routes exist" check.
describe('browser/runtime/database mutation inventory (#8798, #8897)', () => {
  const dataOrInference = [
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
    "POST /api/digital-twin/identity/goals/:id/todos",
    "POST /api/digital-twin/identity/goals/organize",
    "POST /api/digital-twin/identity/goals/organize/apply",
    "POST /api/digital-twin/identity/image",
    "POST /api/digital-twin/identity/image/save",
    "POST /api/digital-twin/identity/longevity/derive",
    "POST /api/digital-twin/import/save",
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
    ]) expect(isHostControlRoute(method, path), path).toBe(false);
  });
});

describe('auxiliary media mutation inventory (#9672)', () => {
  // Reviewed as record CRUD, cancellation/pruning or deterministic work that
  // never hands caller text to an agent. A new mutation needs a new decision.
  const recordOrContained = [
    'DELETE /api/media-jobs/:id',
    'POST /api/lora-datasets/:id/caption-runs/:runId/cancel',
    'POST /api/media-jobs/:id/cancel',
    'POST /api/media-jobs/cancel-queued',
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
    'PATCH /api/pipeline/editorial/readiness-gate',
    'PATCH /api/pipeline/issues/:id',
    'PATCH /api/pipeline/issues/:id/stages/audio/lines/:lineIdx',
    'PATCH /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex',
    'PATCH /api/pipeline/series/:id',
    'PATCH /api/pipeline/series/:id/arc-fields/:field/lock',
    'PATCH /api/pipeline/series/:id/manuscript/review/comments/:commentId',
    'PATCH /api/pipeline/series/:id/seasons/:seasonId',
    'PATCH /api/pipeline/tts/narrate/segment',
    'POST /api/pipeline/issues/:id/auto-run-text/cancel',
    // Recovery only resets persisted state; generating again uses the gated route.
    'POST /api/pipeline/issues/:id/stages/:stageId/recover',
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

describe('Music Video cover font install policy (#12493)', () => {
  it('gates the host-wide font install and keeps cover font list, file and delete open', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    const upload = 'POST /api/music-video/publish/cover-fonts';
    expect(mounted.has(upload)).toBe(true);
    expect(isHostControlRoute('POST', '/api/music-video/publish/cover-fonts')).toBe(true);
    for (const [method, path] of [
      ['GET', '/api/music-video/publish/cover-fonts'],
      ['GET', '/api/music-video/publish/cover-fonts/:fontId/file'],
      ['DELETE', '/api/music-video/publish/cover-fonts/:fontId'],
    ]) {
      expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe('Music Video agent workflow policy (#9869)', () => {
  it('gates mounted agent workflows and keeps record and cancellation contracts open while gating ffmpeg renders (#12514)', () => {
    const protectedRoutes = [
      'POST /api/music-video/:id/plan',
      'POST /api/music-video/:id/treatment/compile',
      'POST /api/music-video/:id/publish-kit/copy',
      'POST /api/music-video/:id/cast-and-sets',
      'POST /api/music-video/:id/cast-and-sets/regenerate',
      'PATCH /api/music-video/:id/cast-and-sets/direction',
      'POST /api/music-video/:id/cast-and-sets/feedback',
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
      'POST /api/music-video/:id/composition/document/directory',
      'POST /api/music-video/:id/render',
      'POST /api/music-video/:id/shots/:sceneId/render',
      'POST /api/music-video/:id/shot-renders/preview',
      'POST /api/music-video/:id/cold-open/audio',
      'POST /api/music-video/:id/excerpt',
      'POST /api/music-video/:id/publish-kit/build',
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
      'GET /api/music-video/:id/composition/document',
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
    // Reads deterministic package gates; no process, provider or artifact creation.
    'POST /api/fableloom/:id/export/preflight',
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
    'POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions',
    'PATCH /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId',
    'DELETE /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId',
    'POST /api/fableloom/:id/episodes/:episodeId/shots/apply',
    'POST /api/fableloom/:id/episodes/:episodeId/shots/cancel',
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
    'POST /api/mood-boards/:id/generate',
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
      ['GET', '/api/system-resources/models/manifest'],
      ['PATCH', '/api/mood-boards/:id'],
      ['GET', '/api/mood-boards/:id/analyze'],
      ['GET', '/api/mood-boards/:id/generate'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('LoRA training run policy (#11073)', () => {
  const protectedRoutes = [
    'POST /api/lora-training/runs',
    'POST /api/lora-training/runs/:id/resume',
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
      ['GET', '/api/lora-training/runs'],
      ['GET', '/api/lora-training/runs/:id'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Music Video cover/promotion and POST LLM drill policy (#10989)', () => {
  const protectedRoutes = [
    'POST /api/music-video/:id/publish-kit/cover-art/design',
    'POST /api/music-video/:id/publish-kit/cover-art/generate',
    'POST /api/music-video/:id/publish/promotion-plan',
    'POST /api/meatspace/post/score-llm',
    'POST /api/meatspace/post/rhetoric/evaluate',
    'POST /api/meatspace/post/drill-cache/fill',
  ];

  it('gates each audited operation and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
      expect(hostControlRouteFor(method, path.toUpperCase() + '/'), route).toBe(route);
    }
  });

  it('gates an LLM drill type on the shared drill route and leaves other types open', () => {
    expect(isHostControlRoute('POST', '/api/meatspace/post/drill')).toBe(false);
    for (const type of LLM_DRILL_TYPES) {
      expect(hostControlBodyKeys('POST', '/api/meatspace/post/drill', { type }), type).toEqual(['type']);
      expect(hostControlBodyKeys('post', '/API/meatspace/post/drill/', { type }), type).toEqual(['type']);
    }
    for (const type of ['multiplication', 'memory-fill-blank', 'n-back', 'WORD-ASSOCIATION', '', null]) {
      expect(hostControlBodyKeys('POST', '/api/meatspace/post/drill', { type }), String(type)).toEqual([]);
    }
    expect(hostControlBodyKeys('POST', '/api/meatspace/post/drill', null)).toEqual([]);
    expect(hostControlBodyKeys('POST', '/api/meatspace/post/drill', ['word-association'])).toEqual([]);
  });

  it('keeps cover compose, lettering, promotion reads and deterministic drills open', () => {
    for (const [method, path] of [
      ['POST', '/api/music-video/:id/publish-kit/cover-art'],
      ['PUT', '/api/music-video/:id/publish-kit/cover-art/design'],
      ['PUT', '/api/music-video/:id/publish-kit/thumbnail'],
      ['GET', '/api/music-video/:id/publish/promotion-plan'],
      ['POST', '/api/meatspace/post/drill'],
      ['GET', '/api/meatspace/post/drill-cache/status'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Voice fine-tuning policy (#11074)', () => {
  const protectedRoutes = [
    'POST /api/voice/profiles/:id/fine-tune/start',
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
      ['GET', '/api/voice/profiles/:id/fine-tune'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('3D model rigging host-workers (#10922)', () => {
  const protectedRoutes = [
    'POST /api/rigging/models/:id',
    'POST /api/rigging/models/:id/retarget',
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
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('3D model generation policy (#11075)', () => {
  const protectedRoutes = [
    'POST /api/image-to-3d/models',
    'POST /api/image-to-3d/models/:id/generate',
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
      ['GET', '/api/image-to-3d/models'],
      ['GET', '/api/image-to-3d/models/:id'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

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
      ['GET', '/api/remote-desktop/status'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Video upscale and stitch policy (#11076)', () => {
  const protectedRoutes = [
    'POST /api/video-gen/upscale/:id',
    'POST /api/video-gen/stitch',
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
      ['GET', '/api/video-gen/upscale/:id/plan'],
      ['GET', '/api/video-gen/history'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Calendar MCP execution policy (#11051)', () => {
  it('gates mounted MCP actions while preserving non-agent Calendar operations', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => `${method} ${path}`));
    for (const action of ['google', 'discover']) {
      const path = `/api/calendar/sync/:accountId/${action}`;
      expect(mounted.has(`POST ${path}`)).toBe(true);
      expect(hostControlRouteFor('POST', path)).toBe(`POST ${path}`);
      expect(hostControlRouteFor('post', path.toUpperCase() + '/')).toBe(`POST ${path}`);
    }
    // Generic sync captures an Outlook bearer token through the signed-in
    // browser (#13055); the direct API sync and push ingestion do not.
    expect(hostControlRouteFor('POST', '/api/calendar/sync/:accountId')).toBe('POST /api/calendar/sync/:accountId');
    for (const route of [
      'POST /api/calendar/sync/:accountId/push',
      'POST /api/calendar/sync/:accountId/api',
      'POST /api/calendar/sync/:accountId/discover-api',
      'GET /api/calendar/accounts/:id/subcalendars',
      'PUT /api/calendar/accounts/:id/subcalendars',
      'GET /api/calendar/events',
      'POST /api/calendar/accounts',
      'PUT /api/calendar/accounts/:id',
      'DELETE /api/calendar/accounts/:id',
    ]) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(isHostControlRoute(method, path), route).toBe(false);
    }
  });
});

describe('Local music generation policy (#11077)', () => {
  const protectedRoutes = [
    'POST /api/music/generate',
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
      ['GET', '/api/music/models/:engine'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Importer, Brain and analytics AI policy (#11036)', () => {
  const protectedRoutes = [
    'POST /api/importer/classify',
    'POST /api/importer/analyze',
    'POST /api/importer/retry-issues',
    'POST /api/brain/capture',
    'POST /api/brain/inbox/:id/retry',
    'POST /api/brain/digest/run',
    'POST /api/brain/review/run',
    'POST /api/brain/daily-log/:date/draft',
    'PUT /api/brain/daily-log/digest-settings',
    'POST /api/model-personality/run',
    'POST /api/insights/goal-scorecard/narrative',
  ];

  it('gates each audited operation and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
      expect(hostControlRouteFor(method, path.toUpperCase() + '/'), route).toBe(route);
    }
  });

  it('gates Importer commit only when cleanupFormatting is true', () => {
    expect(isHostControlRoute('POST', '/api/importer/commit')).toBe(false);
    expect(hostControlBodyKeys('POST', '/api/importer/commit', { cleanupFormatting: true })).toEqual(['cleanupFormatting']);
    expect(hostControlBodyKeys('post', '/API/importer/commit/', { cleanupFormatting: true })).toEqual(['cleanupFormatting']);
    for (const body of [{}, { cleanupFormatting: false }, { cleanupFormatting: 'true' }, null, [true]]) {
      expect(hostControlBodyKeys('POST', '/api/importer/commit', body), JSON.stringify(body)).toEqual([]);
    }
  });

  it('gates SynthID regen unless light, and a code-animation prompt only with a reference video (#13055)', () => {
    const regen = '/api/image-gen/example.png/regenerate';
    expect(isHostControlRoute('POST', regen)).toBe(false);
    for (const body of [{}, null, [], { method: 'flux' }, { method: 'LIGHT' }]) {
      expect(hostControlBodyKeys('POST', regen, body), JSON.stringify(body)).toEqual(['method']);
    }
    expect(hostControlBodyKeys('POST', regen, { method: 'light' })).toEqual([]);
    expect(hostControlBodyKeys('post', '/API/image-gen/example.png/regenerate/', {})).toEqual(['method']);

    const prompt = '/api/code-animation/prompt';
    expect(hostControlBodyKeys('POST', prompt, { concept: 'Example', referenceVideo: { filename: 'example.mp4' } })).toEqual(['referenceVideo']);
    for (const body of [{ concept: 'Example' }, { referenceVideo: null }, null, []]) {
      expect(hostControlBodyKeys('POST', prompt, body), JSON.stringify(body)).toEqual([]);
    }
  });

  it('keeps record reads, CRUD and non-AI insights compute open', () => {
    for (const [method, path] of [
      ['GET', '/api/importer/config'],
      ['GET', '/api/brain/digest/latest'],
      ['POST', '/api/brain/daily-log/:date/append'],
      ['PUT', '/api/brain/daily-log/:date'],
      ['PUT', '/api/brain/daily-log/settings'],
      ['PUT', '/api/model-personality/settings'],
      ['GET', '/api/insights/goal-scorecard'],
      ['PUT', '/api/insights/goal-scorecard/rules'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Media process execution policy', () => {
  const protectedRoutes = [
    'POST /api/devtools/video-download',
    'POST /api/tracks/import/youtube',
    'POST /api/rounds/reference-audio/import',
    'POST /api/music-video/:id/transcribe-midi',
    'POST /api/rounds/reference-audio/transcribe-midi',
    'POST /api/music-video/:id/vocal-stem/separate',
    'POST /api/music-video/:id/lyrics/align',
    'POST /api/loras/:filename/effect',
  ];

  it('gates each route and maps every entry to a mounted route', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => method + ' ' + path));
    for (const route of protectedRoutes) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
      expect(hostControlRouteFor(method, path.toUpperCase() + '/'), route).toBe(route);
    }
  });

  it('keeps reads, progress SSE, and cancellations open', () => {
    for (const [method, path] of [
      ['GET', '/api/devtools/video-download/downloads'],
      ['GET', '/api/devtools/video-download/yt-dlp'],
      ['GET', '/api/devtools/video-download/:jobId/events'],
      ['POST', '/api/devtools/video-download/:jobId/cancel'],
      ['GET', '/api/tracks/import/:jobId/events'],
      ['POST', '/api/tracks/import/:jobId/cancel'],
      ['GET', '/api/rounds/reference-audio/import/:jobId/events'],
      ['POST', '/api/rounds/reference-audio/import/:jobId/cancel'],
      ['GET', '/api/rounds/reference-audio/transcribe-midi/:jobId/events'],
      ['POST', '/api/rounds/reference-audio/transcribe-midi/:jobId/cancel'],
      ['GET', '/api/music-video/:id/transcribe-midi/:jobId/events'],
      ['POST', '/api/music-video/transcribe-midi/:jobId/cancel'],
      ['GET', '/api/music-video/vocal-stem/separate/:jobId/events'],
      ['POST', '/api/music-video/vocal-stem/separate/:jobId/cancel'],
      ['GET', '/api/music-video/lyrics/align/:jobId/events'],
      ['POST', '/api/music-video/lyrics/align/:jobId/cancel'],
      ['GET', '/api/loras'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('Telegram bot and bridge authority policy (#11431)', () => {
  it('gates every mutating Telegram route while keeping status open', () => {
    const mutations = getApiRouteCatalog().routes.filter(({ method, path }) =>
      /^(POST|PUT|PATCH|DELETE)$/.test(method) && /^\/api\/telegram(\/|$)/.test(path));
    expect(mutations.length).toBe(6);
    for (const { method, path } of mutations) {
      expect(isHostControlRoute(method, path), `${method} ${path} should be gated`).toBe(true);
    }
    expect(isHostControlRoute('GET', '/api/telegram/status')).toBe(false);
  });

  it('includes telegram in HOST_CONTROL_SETTINGS_SLICES', () => {
    expect(HOST_CONTROL_SETTINGS_SLICES).toContain('telegram');
  });
});

describe('caller-named host paths', () => {
  it('gates the routes whose body names a host path PortOS reads, writes or runs against', () => {
    const mounted = new Set(getApiRouteCatalog().routes.map(({ method, path }) => `${method} ${path}`));
    for (const route of [
      'POST /api/apps/:appId/reference-repos',
      'POST /api/sharing/buckets',
      'POST /api/sprites/import',
      'POST /api/timeline/import/gmail',
    ]) {
      const [method, path] = route.split(' ');
      expect(mounted.has(route), route).toBe(true);
      expect(hostControlRouteFor(method, path), route).toBe(route);
    }
    // The record-only neighbours and the upload-based importers stay open.
    for (const [method, path] of [
      ['PATCH', '/api/apps/:appId/reference-repos/:refId'],
      ['POST', '/api/apps/:appId/reference-repos/:refId/reviewed'],
      ['PUT', '/api/sharing/buckets/:id'],
      ['DELETE', '/api/sharing/buckets/:id'],
      ['POST', '/api/sharing/buckets/:id/export'],
      ['POST', '/api/sprites'],
      ['POST', '/api/timeline/import/whatsapp'],
      ['POST', '/api/timeline/import/browser'],
    ]) expect(isHostControlRoute(method, path), `${method} ${path}`).toBe(false);
  });

  it('gates a reference-repo PATCH only when it re-points the repo or branch', () => {
    const path = '/api/apps/example-app/reference-repos/ref-1';
    expect(hostControlBodyKeys('PATCH', path, { repoUrl: '~/example/repo' })).toEqual(['repoUrl']);
    expect(hostControlBodyKeys('patch', `${path}/`, { branch: 'main', name: 'Example' })).toEqual(['branch']);
    expect(hostControlBodyKeys('PATCH', path, { name: 'Example', notes: 'n', lastReviewedSha: 'a'.repeat(40) })).toEqual([]);
    expect(hostControlBodyKeys('PATCH', path, undefined)).toEqual([]);
    expect(hostControlBodyKeys('PUT', path, { repoUrl: '~/example/repo' })).toEqual([]);
  });
});
