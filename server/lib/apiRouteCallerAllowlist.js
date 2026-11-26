/**
 * Mounted API routes that no client code reaches, each with the caller class that justifies keeping it.
 *
 * "Reaches" is what `clientApiPaths.js` sees: service wrappers plus every non-test client file's `api.<verb>(`,
 * `request(`, `fetch`, `EventSource` and URL-builder literals, so "the scanner cannot see the client call" is
 * never a class; only a segment built at run time is (`client-dynamic`).
 *
 * `apiRouteParity.test.js` checks every mounted method and rejects entries that become
 * unmounted or gain a client caller. Use a bare path when all its methods have the
 * same non-client caller class. Use `METHOD /path` for an individual method.
 * Cite the caller when adding an entry; delete a route nothing calls.
 */

export const ROUTE_CALLER_CLASSES = Object.freeze({
  peer: 'Called by another PortOS install over the federation or sync channel, never by this install\'s browser.',
  'companion-app': 'Documented in docs/COMPANION_APP_API.md for the native companion client.',
  'agent-facing': 'Named in an agent skill, prompt template or generated agent prompt that tells a spawned agent to call it.',
  'external-client': 'Third-party tools that speak an established API (the A1111-compatible /sdapi surface), not PortOS clients.',
  'oauth-callback': 'The redirect target of a third-party OAuth flow; the browser arrives here from the provider.',
  'operator-script': 'Called by a script under scripts/, or named in an operator-facing doc (a curl workflow or a feature route table) for a caller outside the browser.',
  'client-dynamic': 'Called from client code that builds a path segment at run time; the entry\'s comment names the call site.',
  'server-reference': 'Referenced by a server module (a loopback or provider-compatible request path); the reference was found by text search and not individually traced.',
  'legacy-client-compat': 'Kept for a client build that predates the current routes: a deployed client/dist can lag the server across an upgrade.',
});

export const UNCALLED_ROUTE_ALLOWLIST = Object.freeze({
  peer: Object.freeze([
    // server/services/appQualityFederation.js requests it from peers.
    '/api/apps/quality-federation',
    '/api/brain/reconcile/checksum',
    '/api/brain/reconcile/manifest',
    '/api/brain/reconcile/snapshot',
    '/api/brain/sync',
    '/api/catalog/identity/peer/snapshot',
    '/api/catalog/identity/peer/status',
    '/api/catalog/sync',
    '/api/eidoverse/travel/federation/capabilities',
    '/api/eidoverse/travel/federation/chat',
    '/api/eidoverse/travel/federation/leave',
    '/api/eidoverse/travel/federation/visit',
    '/api/federation/admin/v1/execute',
    '/api/federation/admin/v1/execution/dispatch',
    '/api/federation/admin/v1/execution/preflight',
    '/api/federation/admin/v1/execution/status',
    '/api/federation/admin/v1/plans',
    '/api/federation/admin/v1/preflight',
    '/api/federation/admin/v1/receipt',
    '/api/federation/media/v1/assets',
    '/api/federation/media/v1/assets/:id',
    '/api/federation/media/v1/jobs',
    '/api/federation/media/v1/jobs/:id',
    '/api/federation/media/v1/jobs/:id/cancel',
    '/api/federation/media/v1/jobs/:id/result',
    '/api/federation/media/v1/status',
    '/api/instances/peers/:id/query',
    // server/services/instances.js requests it from peers.
    '/api/instances/peers/announce',
    // server/services/instances.js requests it from peers.
    '/api/instances/peers/pair-secret',
    // server/services/instances.js requests it from peers.
    '/api/instances/peers/sync-categories',
    '/api/instances/sync-status',
    '/api/managed-visitors/v1/admissions',
    '/api/managed-visitors/v1/admissions/cancel',
    '/api/managed-visitors/v1/capabilities',
    '/api/managed-visitors/v1/sessions/:id/actions',
    '/api/managed-visitors/v1/sessions/:id/leave',
    '/api/managed-visitors/v1/sessions/:id/observations',
    // server/services/syncOrchestrator.js requests it from peers.
    '/api/memory/sync',
    '/api/peer-media/copy',
    '/api/peer-media/delete',
    '/api/peer-media/release',
    '/api/peer-sync/cos-agent-archive',
    '/api/peer-sync/cos-history-manifest',
    '/api/peer-sync/cos-tasks',
    '/api/peer-sync/eidoverse-foundations',
    '/api/peer-sync/library-manifest',
    '/api/peer-sync/manifest',
    '/api/peer-sync/push',
    '/api/peer-sync/record',
    '/api/peer-sync/sync-now',
    '/api/sync',
    '/api/sync/:category/apply',
    '/api/sync/:category/checksum',
    '/api/sync/:category/manifest',
    '/api/sync/:category/snapshot',
    '/api/sync/:category/video-inventory',
    '/api/sync/mediaCollections/image-inventory',
    '/api/sync/mediaCollections/image-library-inventory',
  ]),
  'companion-app': Object.freeze([
    '/api/auth/whoami',
    '/api/remote-desktop/sessions',
    '/api/remote-desktop/status',
  ]),
  'external-client': Object.freeze([
    '/api/voice/public/engines',
    '/api/voice/public/voices',
    '/sdapi/v1/options',
    '/sdapi/v1/portos/video-models',
    '/sdapi/v1/progress',
    '/sdapi/v1/samplers',
    '/sdapi/v1/sd-models',
    '/sdapi/v1/txt2img',
  ]),
  'agent-facing': Object.freeze([
    '/api/alerts',
    // server/lib/apiOperationContracts.js: a public OpenAPI operation exposed to agents through the API tool resource.
    '/api/apps/:id/logs',
    '/api/auth/logout',
    '/api/browser/health',
    '/api/code-review/cli-outcome',
    '/api/code-review/local',
    '/api/cos/agents/:id/release-publication',
    '/api/cos/agents/:id/security-scan',
    '/api/cos/claim-ownership',
    '/api/cos/claim-selection',
    '/api/cos/claude-changelog',
    '/api/cos/goal-fidelity/false-positive',
    '/api/cos/learning/insights',
    '/api/cos/merge-handoff',
    '/api/cos/tasks/:id/challenge',
    // server/services/autonomousJobs/defaults.js: the generated job prompts tell the agent to call it.
    '/api/cos/tasks/internal',
    // server/services/autonomousJobs/defaults.js: the generated job prompts tell the agent to call it.
    '/api/cos/tasks/user',
    '/api/cos/tools/call',
    '/api/cos/tools/calls/:requestId',
    '/api/creative-director/:id/plan',
    '/api/creative-director/:id/treatment',
    '/api/datadog/instances/:id',
    '/api/human-actions',
    '/api/human-actions/plans',
    '/api/jira/instances/:id',
    '/api/jira/instances/:id/tickets',
    '/api/jira/instances/:instanceId/epics/:epicKey/children',
    '/api/jira/instances/:instanceId/sprints/:sprintId/issues',
    '/api/jira/instances/:instanceId/tickets/:ticketId',
    '/api/jira/instances/:instanceId/tickets/:ticketId/comments',
    '/api/jira/instances/:instanceId/tickets/:ticketId/labels',
    '/api/providers/comparison/import',
    '/api/review/todo',
    '/api/user-actions',
    // docs/API_TOOL_CONTRACT.md and docs/features/agent-context.md document the MCP endpoint local agents call.
    '/api/agent-context/mcp',
  ]),
  'oauth-callback': Object.freeze([
    '/api/beeper/oauth/callback',
    '/api/calendar/google/oauth/callback',
    '/api/spotify/oauth/callback',
  ]),
  'operator-script': Object.freeze([
    // docs/API.md names the activity feed mount for API callers; the browser reads its sub-routes.
    '/api/agents/activity',
    '/api/agents/tools/moltworld/queue/:id/complete',
    '/api/agents/tools/moltworld/queue/:id/fail',
    '/api/apple-health/days/:date',
    '/api/brain/youtube/ingests/:videoId/transcript',
    '/api/browser/pages',
    '/api/browser/process',
    '/api/browser/vault/fill',
    '/api/browser/vault/logins',
    '/api/browser/version',
    '/api/code-animation/packages/validate',
    '/api/code-animation/projects/:id/sound-assets',
    // Operator/API erasure path for data/contacts-cache.json + sync state (#18130).
    '/api/contacts/cache',
    '/api/cos/agents/:id/release-candidate',
    // docs/features/chief-of-staff.md route table.
    '/api/cos/jobs/incidents',
    '/api/cos/mind/maintainer/watchdog',
    // scripts/portos-acp.js (docs/ACP.md): the ACP stdio adapter's live Persistent Mind feed; the browser uses Socket.IO.
    '/api/cos/mind/stream',
    '/api/cos/schedule/deep-audits/:id',
    '/api/cos/schedule/maintenance-runs/:id/resume',
    '/api/cos/schedule/maintenance-runs/:id/steps/:stepId',
    '/api/cos/schedule/release-synchronization/operator-reset',
    '/api/cos/schedule/release-synchronization/verify-delivery',
    '/api/dashboard/daily-actions',
    '/api/database/maintenance/preflight',
    '/api/database/switch',
    '/api/digital-twin/enrich/categories',
    '/api/docker-containment/run',
    '/api/eidoverse/world/controllers/:id/riddle',
    '/api/eidoverse/world/foundations/:id/adopt',
    '/api/film-styles/:id/prompt',
    '/api/git/commits',
    '/api/lora-training/runs/:id/cancel',
    '/api/lora-training/runs/:id/promote-checkpoint',
    '/api/managed-visitor-admin',
    '/api/managed-visitor-admin/:appId/credential',
    '/api/meatspace/post/memory-drill',
    // docs/features/post.md route table (spaced-repetition due list).
    '/api/meatspace/post/memory-items/due',
    // docs/features/memory-system.md route table (memory maintenance endpoints, #18655).
    '/api/memory/categories',
    '/api/memory/consolidate',
    '/api/memory/expired',
    '/api/memory/link',
    '/api/memory/tags',
    '/api/memory/timeline',
    // docs/features/product-surfaces.md: the read of a server-owned production run started over this API.
    '/api/music-video/:id/production-runs/:runId',
    // docs/features/product-surfaces.md: a music video's spend by lane, for API callers; the page reads it off the project.
    '/api/music-video/:id/spend',
    // docs/API.md: the full character style, for API callers; the client reads the list.
    '/api/music-video/character-styles/:id',
    '/api/ports/allocate',
    '/api/ports/scan',
    // docs/features/privacy-center.md uses portos-api.js to clean historical Digital Twin artifacts.
    'POST /api/privacy/twin-history/cleanup',
    // docs/features/agent-skills.md (P5 surfaces): the Skill Registry routes, for agents and API callers.
    '/api/skills/config',
    '/api/skills/manage',
    // scripts/ops/reconcile-maintenance-reservations.mjs confirms terminal runner ownership.
    '/api/system/maintenance/runner-owner/:agentId',
    '/api/universe-builder/:id/canon/backfill-descriptions',
    // docs/features/eidoverse-guest-travel.md documents GET and DELETE.
    '/api/eidoverse/world/foundations/:id',
    // docs/features/music-video-autonomous.md route table.
    '/api/music-video/:id/autonomous',
    // docs/features/app-wizard.md route table.
    '/api/scaffold',
  ]),
  'client-dynamic': Object.freeze([
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/damage',
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/event',
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/rest',
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/sync/jira',
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/sync/tasks',
    // client/src/pages/CharacterSheet.jsx: charPost builds `/character${path}`.
    '/api/character/xp',
    // client/src/components/integrations/IntegrationInstancesPage.jsx: builds `${apiBase}/instances/${instanceId}/test`.
    '/api/datadog/instances/:id/test',
    // client/src/components/integrations/IntegrationInstancesPage.jsx: builds `${apiBase}/instances/${instanceId}/test`.
    '/api/jira/instances/:id/test',
    // client/src/hooks/useMediaJobSse.js: builds `/api/${kind}-gen/${jobId}/events`.
    '/api/image-gen/:jobId/events',
    // client/src/hooks/useModelDownloadStatus.js: builds `/api/${kind}-gen/models/${modelId}/download`.
    '/api/image-gen/models/:modelId/download',
  ]),
  'server-reference': Object.freeze([
    '/api/api-docs/tools.min.json',
    '/api/catalog/ingredients/:id/photoreal/blend',
    '/api/git/status',
    // docs/features/tailcat-peers.md documents the operator read without the full capability.
    'GET /api/instances/peers/tailcat/devices',
    '/api/html-composition/render',
    '/api/lora-training/runs/:id/samples/:filename',
    // docs/features/post.md documents item editing over the API.
    'PUT /api/meatspace/post/memory-items/:id',
    '/api/music-video/:id/composition/document/file',
    '/api/music/supercollider/renders/:jobId/audio',
    // docs/features/openclaw-operator-chat.md documents the non-streaming API.
    'POST /api/openclaw/sessions/:id/messages',
    '/api/usage/messages',
    '/api/voice/speak',
  ]),
  'legacy-client-compat': Object.freeze([
    '/api/lora-training/runs',
    // Universe pickers in older client builds request full records (before #17115).
    'GET /api/universe-builder',
    '/api/voice/tts/status',
    '/api/voice/tts/unload',
  ]),
});
