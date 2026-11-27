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
  'external-client': 'Third-party clients of an externally callable API.',
  'oauth-callback': 'The redirect target of a third-party OAuth flow; the browser arrives here from the provider.',
  'operator-script': 'Invoked by first-party operator tooling with a call site checked by API route parity.',
  'operator-workflow': 'Required by a specific supported manual setup, recovery, or data-management workflow. Cite the workflow and why the operation is needed.',
  'client-dynamic': 'Called from client code that builds a path segment at run time; the entry\'s comment names the call site.',
  'server-reference': 'Referenced by a server module (a loopback or provider-compatible request path); the reference was found by text search and not individually traced.',
  'legacy-client-compat': 'Kept for a client build that predates the current routes: a deployed client/dist can lag the server across an upgrade.',
});

// These sources are parsed by route parity and select that check when edited.
export const OPERATOR_SCRIPT_CALLER_FILES = Object.freeze([
  'scripts/contained-run.js',
  'scripts/ops/reconcile-maintenance-reservations.mjs',
  'scripts/portos-acp.js',
  'server/scripts/moltworld-explore.mjs',
]);

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
  ]),
  'agent-facing': Object.freeze([
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
    '/api/creative-director/:id/plan',
    '/api/creative-director/:id/treatment',
    '/api/datadog/instances/:id',
    '/api/human-actions',
    '/api/human-actions/plans',
    '/api/jira/instances/:id',
    '/api/jira/instances/:id/tickets',
    // server/services/eidoverseControllerDefinitions/riddleLedger.controller.js advertises this action.
    'POST /api/eidoverse/world/controllers/:id/riddle',
    '/api/jira/instances/:instanceId/epics/:epicKey/children',
    '/api/jira/instances/:instanceId/sprints/:sprintId/issues',
    '/api/jira/instances/:instanceId/tickets/:ticketId',
    '/api/jira/instances/:instanceId/tickets/:ticketId/comments',
    '/api/jira/instances/:instanceId/tickets/:ticketId/labels',
    '/api/providers/comparison/import',
    // server/services/taskPromptDefaults/catalog/{claimJira,maintenance}.js: Jira triage records operator follow-ups.
    'POST /api/review/todo',
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
    // server/scripts/moltworld-explore.mjs settles claimed queue items.
    'POST /api/agents/tools/moltworld/queue/:id/complete',
    'POST /api/agents/tools/moltworld/queue/:id/fail',
    // scripts/portos-acp.js subscribes to the Persistent Mind SSE feed.
    'GET /api/cos/mind/stream',
    // scripts/contained-run.js submits a contained command.
    'POST /api/docker-containment/run',
    // scripts/ops/reconcile-maintenance-reservations.mjs confirms terminal runner ownership.
    'GET /api/system/maintenance/runner-owner/:agentId',
  ]),
  'operator-workflow': Object.freeze([
    // Dedicated Apple Health day and contacts cache erasure operations.
    'DELETE /api/apple-health/days/:date',
    'DELETE /api/contacts/cache',
    // docs/CODE_ANIMATION_PACKAGES.md: stage owner-supplied audio into a package revision.
    'POST /api/code-animation/projects/:id/sound-assets',
    // docs/VERSIONING.md: release ownership and verification commands used by delegated release runs.
    'POST /api/cos/agents/:id/release-candidate',
    'POST /api/cos/schedule/release-synchronization/verify-delivery',
    // docs/VERSIONING.md: recover an operation after the operator reconciles its target.
    'POST /api/cos/schedule/release-synchronization/operator-reset',
    // docs/features/development-watchdog.md: run a dry scan and inspect its receipt.
    'GET /api/cos/mind/maintainer/watchdog',
    'POST /api/cos/mind/maintainer/watchdog',
    // docs/QUOTA-BURN.md: CLI-only maintenance resume and pending-step re-pinning.
    'POST /api/cos/schedule/maintenance-runs/:id/resume',
    'PATCH /api/cos/schedule/maintenance-runs/:id/steps/:stepId',
    // docs/STORAGE.md: advisory backend migration check.
    'POST /api/database/maintenance/preflight',
    // docs/features/eidoverse.md: remove an owned foundation after withdrawing its publication.
    'DELETE /api/eidoverse/world/foundations/:id',
    // docs/features/managed-visitors.md: list, provision, and revoke app visitor credentials.
    'GET /api/managed-visitor-admin',
    'DELETE /api/managed-visitor-admin/:appId/credential',
    'POST /api/managed-visitor-admin/:appId/credential',
    // docs/features/media-operation-control.md: identify and stop a specific active deck prompt run.
    'GET /api/decks/:id/generate-prompts/status',
    'POST /api/decks/:id/generate-prompts/cancel',
    // docs/features/media-operation-control.md: stop consolidation at the next file boundary.
    'POST /api/media/collections/:id/primary/cancel',
    // docs/features/media-operation-control.md: identify and stop a specific active photo research run.
    'GET /api/music-video/:id/research',
    'POST /api/music-video/:id/research/cancel',
    // docs/features/privacy-center.md: erase historical Twin and imported Signal records.
    'POST /api/privacy/twin-history/cleanup',
    'POST /api/signal/blocklist/handles',
    // docs/features/app-wizard.md: raw scaffold request for explicit ports and forge provisioning.
    'POST /api/scaffold',
    // docs/features/agent-skills.md: manage external skill directories and curator thresholds.
    'GET /api/skills/config',
    'PUT /api/skills/config',
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
    // docs/features/post.md documents item editing over the API.
    'PUT /api/meatspace/post/memory-items/:id',
    '/api/music-video/:id/composition/document/file',
    '/api/music/supercollider/renders/:jobId/audio',
    // docs/features/openclaw-operator-chat.md documents the non-streaming API.
    'POST /api/openclaw/sessions/:id/messages',
  ]),
  'legacy-client-compat': Object.freeze([
    // Universe pickers in older client builds request full records (before #17115).
    'GET /api/universe-builder',
  ]),
});
