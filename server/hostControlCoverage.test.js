/**
 * Every mounted mutating route is classified for host control (#12952).
 *
 * `HOST_CONTROL_ROUTES` in lib/hostControlRoutes.js is hand-kept, so a new
 * route family used to be gated only if its author remembered, and the gap was
 * found by audit after it shipped (more than 40 "Require operator authority
 * for …" issues). This guard reads the live mounted route graph
 * (`scanRouteGraph`, sub-routers included) and requires each `POST`/`PUT`/
 * `PATCH`/`DELETE` to be gated by `HOST_CONTROL_ROUTES`, gated per body
 * (`hostControlBodyRouteFor`), or listed below as reviewed-open with a reason.
 * It fails on a mounted mutation in no list, on a stale entry, and on an entry
 * that is also gated.
 *
 * Classifying a new route: read the family notes in the header of
 * lib/hostControlRoutes.js. A route that runs a process, git/npm/gh, a CoS
 * agent, or hands caller text or a caller-chosen provider to a runner that is
 * not tool-free belongs in HOST_CONTROL_ROUTES. Otherwise add it here with the
 * reason constant that matches, or a new one. Every entry names what the
 * route actually does; there is no catch-all "not yet reviewed" reason (#13055).
 *
 * GETs are covered by a static trace (#13097, test/processReachScan.js): a
 * mounted GET whose handler can reach child_process, node-pty, a browser
 * driver, ws, keytar, a DevTools endpoint, a computed import or an injected
 * router dependency must be gated, or listed in REVIEWED_PROCESS_GETS with a
 * reason. A fixed probe shared by many GETs is reviewed once, in
 * REVIEWED_PROCESS_SITES, and ends the trace there. The trace follows a
 * reached binding whole, so a GET that only reads a table of executors is
 * still listed; its reason says so.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRouteGraph } from './lib/apiRouteGraph.js';
import { hostControlBodyRouteFor, hostControlRouteFor } from './lib/hostControlRoutes.js';
import { createProcessReachTracer } from './test/processReachScan.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Reasons, from the family notes in the lib/hostControlRoutes.js header.
const RECORDS = 'Stores, edits or moves PortOS records; runs nothing on the host.';
const REMOVES_RECORD = 'Removes a record or stored data; never starts host work.';
const REDUCES_EXECUTION = 'Cancels, stops, pauses or unloads work; reducing execution stays open.';
const HANDLER_GATED = 'Checks host control in its handler or router for the requests that need it.';
const PEER_SURFACE = 'Peer endpoint in PEER_API_SURFACE (lib/apiAccessPolicy.js), admitted by scoped peer credentials and its own grant checks.';
const AUTH_SESSION = 'Authentication session lifecycle; auth.js and authGate.js own its policy.';
const READ_ONLY_EXTERNAL = 'Runs a read-only query (a gh GET or repo analysis) and caches the result; changes no external state.';
const CONFIGURED_INFERENCE = 'Runs an already-configured provider or local runtime on a fixed prompt (providers #8721, local-llm #8798).';
const MODEL_DATA = 'Downloads, verifies or removes model weights, or selects a built-in backend; installs no executable (local-llm #8798).';
const MANAGED_INSTALL = 'Installs a fixed, allowlisted package set into a PortOS-managed venv with an interpreter PortOS picks; no caller-chosen executable (#9015).';
const PIPELINE_DETERMINISTIC = 'Deterministic Pipeline route that never reaches the staged runner (#10068).';
const TOOL_FREE_INFERENCE = 'Sends caller or stored text only through a tool-free transport (an HTTP chat completion or the sandboxed Codex text turn), with no CLI/TUI runner or agent fallback (#9008).';
const IN_PROCESS_MEDIA = 'Transforms a stored gallery image in-process (sharp or pure JS) into a new variant; spawns no process and calls no provider.';
const READ_OVER_POST = 'Reads or previews stored records over POST; writes nothing and runs nothing.';
const DERIVED_REPORT = 'Recomputes a report from stored records without a provider; runs nothing on the host.';
// From the route-by-route audit of the routes that were open when this guard landed (#13055).
const IN_PROCESS_COMPUTE = 'Runs a deterministic in-process computation over stored records and saves the derived result; spawns no process and calls no provider.';
const CLIENT_TELEMETRY = 'Records a caller-reported error, event or usage count as a PortOS record; runs nothing on the host.';
const CONFIGURED_SELECTION = 'Chooses which already-configured provider or model a feature uses and arms nothing; names no executable, endpoint or host path (#8721).';
const CONNECTOR_CREDENTIAL = 'Starts, validates or stores the credential an already-configured service uses with its fixed or operator-set endpoint; names no endpoint, host path or executable.';
const EXTERNAL_SYNC = 'Pulls from an already-configured external service with its stored credential into PortOS records; changes no external state and runs nothing on the host.';
const LOCAL_SOURCE_SYNC = 'Reads a fixed local source (the Messages or Contacts database at its built-in path) into PortOS records; the caller names no path and nothing external changes.';
const PEER_SYNC = 'Pushes or pulls records over the established peer-sync channel, only with peers the operator registered for sync, within their direction and categories.';
const PUBLIC_FETCH = 'Fetches a public http(s) URL through an SSRF-guarded fetcher with no stored credential, and returns or stores the result; runs nothing on the host.';
const REFERENCE_DATASET = 'Downloads a fixed public reference dataset from a hardcoded URL and indexes it in-process; no caller-chosen URL, executable or provider.';
const READ_ONLY_PROBE = 'Runs only a fixed read-only host probe (a process, port or disk-usage listing) with no caller-chosen command or path; changes no host state.';
const LOCAL_TTS = 'Synthesizes caller text on an already-installed TTS runtime, which runs no tools; names no executable or path (like local-llm test, #8798).';
const FIXED_ENCODE = 'Encodes audio PortOS synthesized itself with a fixed ffmpeg invocation; no caller-supplied media, path or argument reaches the process (#10893).';
const FEATURE_TOGGLE = 'Shows or hides an optional integration; the toggles that launch or tear down host executables are gated by path in COMPILED_BODY_ROUTES.';
const LOCAL_BRIDGE = 'Opens the fixed-target bridge to an already-installed local integration; spawns no process and lets the caller choose no target.';
const EXPOSED_API = 'Opt-in external API (lib/apiRegistry.js): open while the operator exposes it, otherwise the router requires host control (#11138).';
const CONFIGURED_WORLD_SYNC = 'Reconciles the local Eidoverse world with the operator-saved identities and projection recipe; takes no caller content, calls no provider and starts nothing.';
const MANAGED_VISITOR_BROKER = 'Managed-app visitor broker: its credentials work only for a local same-origin app (services/managedVisitors.js), so no remote or peer caller gains world or host authority.';

// 'METHOD /path' as scanRouteGraph spells it (the declaring module's :param names).
const REVIEWED_OPEN_MUTATIONS = [
  // /api/agent-context
  ['DELETE /api/agent-context/mcp', REMOVES_RECORD],
  // /api/agents/accounts
  ['DELETE /api/agents/accounts/:id', REMOVES_RECORD],
  // /api/agents/activity
  ['POST /api/agents/activity/cleanup', REMOVES_RECORD],
  ['POST /api/agents/activity/run-events/reconcile', RECORDS],
  // /api/agents/personalities
  ['DELETE /api/agents/personalities/:id', REMOVES_RECORD],
  ['POST /api/agents/personalities/:id/toggle', HANDLER_GATED],
  // /api/agents/schedules
  ['DELETE /api/agents/schedules/:id', REMOVES_RECORD],
  ['POST /api/agents/schedules/:id/toggle', HANDLER_GATED],
  // /api/agents/tools
  ['POST /api/agents/tools/drafts', RECORDS],
  ['DELETE /api/agents/tools/drafts/:draftId', REMOVES_RECORD],
  ['PUT /api/agents/tools/drafts/:draftId', RECORDS],
  ['POST /api/agents/tools/generate-comment', TOOL_FREE_INFERENCE],
  ['POST /api/agents/tools/generate-post', TOOL_FREE_INFERENCE],
  // /api/agents/tools/moltworld
  ['DELETE /api/agents/tools/moltworld/queue/:id', REMOVES_RECORD],
  ['POST /api/agents/tools/moltworld/queue/:id/complete', RECORDS],
  ['POST /api/agents/tools/moltworld/queue/:id/fail', RECORDS],
  // /api/agents/tools/moltworld/ws
  ['POST /api/agents/tools/moltworld/ws/disconnect', REDUCES_EXECUTION],
  // /api/albums
  ['POST /api/albums', RECORDS],
  ['DELETE /api/albums/:id', REMOVES_RECORD],
  ['PATCH /api/albums/:id', RECORDS],
  // /api/apple-health
  ['DELETE /api/apple-health/days/:date', REMOVES_RECORD],
  // /api/apps
  ['DELETE /api/apps/:id', REMOVES_RECORD],
  ['POST /api/apps/:id/archive', RECORDS],
  ['POST /api/apps/:id/detect-icon', RECORDS],
  ['POST /api/apps/:id/quality-schedule/preview', READ_ONLY_EXTERNAL],
  ['POST /api/apps/:id/scope-adherence', RECORDS],
  ['POST /api/apps/:id/unarchive', RECORDS],
  // /api/apps/:appId/reference-repos
  ['DELETE /api/apps/:appId/reference-repos/:refId', REMOVES_RECORD],
  ['POST /api/apps/:appId/reference-repos/:refId/reviewed', RECORDS],
  // /api/artists
  ['POST /api/artists', RECORDS],
  ['DELETE /api/artists/:id', REMOVES_RECORD],
  ['PATCH /api/artists/:id', RECORDS],
  // /api/ask
  ['POST /api/ask', HANDLER_GATED],
  ['DELETE /api/ask/:id', REMOVES_RECORD],
  ['POST /api/ask/:id/promote', HANDLER_GATED],
  // /api/attachments
  ['POST /api/attachments', RECORDS],
  ['DELETE /api/attachments/:filename', REMOVES_RECORD],
  // /api/auth
  ['POST /api/auth/login', AUTH_SESSION],
  ['POST /api/auth/logout', AUTH_SESSION],
  ['DELETE /api/auth/password', AUTH_SESSION],
  ['DELETE /api/auth/sessions', AUTH_SESSION],
  ['DELETE /api/auth/sessions/:id', AUTH_SESSION],
  // /api/authors
  ['POST /api/authors', RECORDS],
  ['DELETE /api/authors/:id', REMOVES_RECORD],
  ['PATCH /api/authors/:id', RECORDS],
  // /api/beeper
  ['PATCH /api/beeper/attachments/:messageId/:idx', RECORDS],
  ['POST /api/beeper/attachments/:messageId/:idx/fetch', EXTERNAL_SYNC],
  ['POST /api/beeper/attachments/backfill', EXTERNAL_SYNC],
  ['DELETE /api/beeper/conversations/:id', REMOVES_RECORD],
  ['POST /api/beeper/conversations/:id/seen', RECORDS],
  ['POST /api/beeper/oauth/start', CONNECTOR_CREDENTIAL],
  ['DELETE /api/beeper/outbox/:id', REMOVES_RECORD],
  ['POST /api/beeper/outbox/:id/reconcile', READ_ONLY_EXTERNAL],
  ['POST /api/beeper/scopes', RECORDS],
  ['DELETE /api/beeper/scopes/:id', REMOVES_RECORD],
  ['PATCH /api/beeper/scopes/:id', RECORDS],
  ['POST /api/beeper/status/check', READ_ONLY_EXTERNAL],
  ['POST /api/beeper/sync', EXTERNAL_SYNC],
  ['DELETE /api/beeper/token', REMOVES_RECORD],
  ['POST /api/beeper/token', CONNECTOR_CREDENTIAL],
  // /api/brain
  ['POST /api/brain/admin', RECORDS],
  ['DELETE /api/brain/admin/:id', REMOVES_RECORD],
  ['PUT /api/brain/admin/:id', RECORDS],
  ['POST /api/brain/bridge-sync', TOOL_FREE_INFERENCE],
  ['POST /api/brain/buckets', RECORDS],
  ['DELETE /api/brain/buckets/:id', REMOVES_RECORD],
  ['PUT /api/brain/buckets/:id', RECORDS],
  ['POST /api/brain/buckets/reorder', RECORDS],
  ['DELETE /api/brain/daily-log/:date', REMOVES_RECORD],
  ['PUT /api/brain/daily-log/:date', RECORDS],
  ['POST /api/brain/daily-log/:date/append', RECORDS],
  ['PUT /api/brain/daily-log/settings', RECORDS],
  ['POST /api/brain/daily-log/sync-obsidian', RECORDS],
  ['POST /api/brain/fix', RECORDS],
  ['POST /api/brain/ideas', RECORDS],
  ['DELETE /api/brain/ideas/:id', REMOVES_RECORD],
  ['PUT /api/brain/ideas/:id', RECORDS],
  ['POST /api/brain/ideas/idealoom/import', RECORDS],
  ['POST /api/brain/ideas/idealoom/lists', RECORDS],
  ['DELETE /api/brain/ideas/idealoom/lists/:id', REMOVES_RECORD],
  ['PUT /api/brain/ideas/idealoom/lists/:id', RECORDS],
  ['PUT /api/brain/ideas/idealoom/settings', RECORDS],
  ['POST /api/brain/ideas/idealoom/sync', RECORDS],
  ['DELETE /api/brain/inbox/:id', REMOVES_RECORD],
  ['PUT /api/brain/inbox/:id', RECORDS],
  ['POST /api/brain/inbox/:id/done', RECORDS],
  ['POST /api/brain/inbox/sent-to-catalog', RECORDS],
  ['POST /api/brain/links', HANDLER_GATED],
  ['DELETE /api/brain/links/:id', REMOVES_RECORD],
  ['PUT /api/brain/links/:id', RECORDS],
  ['POST /api/brain/links/reorder', RECORDS],
  ['POST /api/brain/memories', RECORDS],
  ['DELETE /api/brain/memories/:id', REMOVES_RECORD],
  ['PUT /api/brain/memories/:id', RECORDS],
  ['POST /api/brain/people', RECORDS],
  ['DELETE /api/brain/people/:id', REMOVES_RECORD],
  ['PUT /api/brain/people/:id', RECORDS],
  ['POST /api/brain/projects', RECORDS],
  ['DELETE /api/brain/projects/:id', REMOVES_RECORD],
  ['PUT /api/brain/projects/:id', RECORDS],
  ['POST /api/brain/reconcile/parity', READ_ONLY_EXTERNAL],
  ['POST /api/brain/review/resolve', RECORDS],
  ['PUT /api/brain/settings', HANDLER_GATED],
  ['POST /api/brain/songbook', RECORDS],
  ['DELETE /api/brain/songbook/:id', REMOVES_RECORD],
  ['PATCH /api/brain/songbook/:id', RECORDS],
  ['POST /api/brain/songbook/:id/attachments', RECORDS],
  ['DELETE /api/brain/songbook/:id/attachments/:filename', REMOVES_RECORD],
  ['POST /api/brain/songbook/:id/practice', RECORDS],
  ['POST /api/brain/songbook/import/url', PUBLIC_FETCH],
  ['POST /api/brain/threads', RECORDS],
  ['DELETE /api/brain/threads/:id', REMOVES_RECORD],
  ['PUT /api/brain/threads/:id', RECORDS],
  ['POST /api/brain/threads/:id/refs', RECORDS],
  ['DELETE /api/brain/threads/:id/refs/:kind/:refId', REMOVES_RECORD],
  ['POST /api/brain/threads/attach', RECORDS],
  ['POST /api/brain/threads/sync', READ_ONLY_EXTERNAL],
  ['POST /api/brain/youtube/ingest/:jobId/cancel', REDUCES_EXECUTION],
  ['DELETE /api/brain/youtube/ingests/:videoId', REMOVES_RECORD],
  ['PUT /api/brain/youtube/settings', RECORDS],
  // /api/brain/import
  ['POST /api/brain/import/chatgpt', RECORDS],
  ['POST /api/brain/import/chatgpt/preview', READ_OVER_POST],
  ['POST /api/brain/import/chatgpt/zip', RECORDS],
  // /api/browser
  ['DELETE /api/browser/downloads/:name', REMOVES_RECORD],
  // /api/calendar
  ['POST /api/calendar/accounts', RECORDS],
  ['DELETE /api/calendar/accounts/:id', REMOVES_RECORD],
  ['PUT /api/calendar/accounts/:id', RECORDS],
  ['PUT /api/calendar/accounts/:id/subcalendars', RECORDS],
  ['POST /api/calendar/debug/clear-token', REMOVES_RECORD],
  ['POST /api/calendar/google/auth/clear', REMOVES_RECORD],
  ['POST /api/calendar/google/auth/credentials', CONNECTOR_CREDENTIAL],
  ['POST /api/calendar/review/:date/confirm', RECORDS],
  ['POST /api/calendar/sync/:accountId/api', EXTERNAL_SYNC],
  ['POST /api/calendar/sync/:accountId/discover-api', EXTERNAL_SYNC],
  ['POST /api/calendar/sync/:accountId/push', RECORDS],
  // /api/catalog
  ['POST /api/catalog/bulk-import', RECORDS],
  ['POST /api/catalog/embeddings/backfill', TOOL_FREE_INFERENCE],
  ['POST /api/catalog/identity/:id/abort', HANDLER_GATED],
  ['POST /api/catalog/identity/:id/accept', HANDLER_GATED],
  ['POST /api/catalog/identity/:id/advance', HANDLER_GATED],
  ['POST /api/catalog/identity/:id/recover', HANDLER_GATED],
  ['POST /api/catalog/identity/create', HANDLER_GATED],
  ['POST /api/catalog/identity/import', HANDLER_GATED],
  ['POST /api/catalog/identity/preview', HANDLER_GATED],
  ['POST /api/catalog/import/music-videos', RECORDS],
  ['POST /api/catalog/ingredient-merges/:id/recover', RECORDS],
  ['POST /api/catalog/ingredients', RECORDS],
  ['POST /api/catalog/ingredients/:id/fork', RECORDS],
  ['POST /api/catalog/ingredients/:id/refine/compose', READ_OVER_POST],
  ['POST /api/catalog/ingredients/:id/media/refine/compose', READ_OVER_POST],
  ['POST /api/catalog/ingredients/:id/design/spread/compose', READ_OVER_POST],
  ['POST /api/catalog/ingredients/:id/design/render/compose', READ_OVER_POST],
  ['PUT /api/catalog/ingredients/:id/owner', RECORDS],
  ['DELETE /api/catalog/ingredients/:id', REMOVES_RECORD],
  ['PATCH /api/catalog/ingredients/:id', RECORDS],
  ['PATCH /api/catalog/ingredients/:id/lock', RECORDS],
  ['DELETE /api/catalog/ingredients/:id/link', REMOVES_RECORD],
  ['POST /api/catalog/ingredients/:id/link', RECORDS],
  ['DELETE /api/catalog/ingredients/:id/media', REMOVES_RECORD],
  ['POST /api/catalog/ingredients/:id/media', RECORDS],
  ['POST /api/catalog/ingredients/:id/media/from-mood-board', RECORDS],
  ['POST /api/catalog/ingredients/:id/media/generated', RECORDS],
  ['PATCH /api/catalog/ingredients/:id/media/library', RECORDS],
  ['POST /api/catalog/ingredients/:id/media/portrait', RECORDS],
  ['POST /api/catalog/ingredients/:id/media/upload', RECORDS],
  ['POST /api/catalog/ingredients/:id/greybox/prompt', READ_OVER_POST],
  ['PUT /api/catalog/ingredients/:id/greybox', RECORDS],
  ['POST /api/catalog/ingredients/:id/greybox/shots/:shotId/capture', RECORDS],
  ['POST /api/catalog/ingredients/:id/greybox/shots/:shotId/render', RECORDS],
  ['POST /api/catalog/ingredients/:id/media/voice', TOOL_FREE_INFERENCE],
  ['DELETE /api/catalog/ingredients/:id/relations', REMOVES_RECORD],
  ['POST /api/catalog/ingredients/:id/relations', RECORDS],
  ['POST /api/catalog/ingredients/:id/revisions/:revisionId/restore', RECORDS],
  ['DELETE /api/catalog/ingredients/:id/sheets/pointer', REMOVES_RECORD],
  ['POST /api/catalog/ingredients/:id/sheets/preview', READ_OVER_POST],
  ['POST /api/catalog/ingredients/merge', RECORDS],
  ['POST /api/catalog/migration/rerun', RECORDS],
  ['POST /api/catalog/universe-filing', RECORDS],
  ['POST /api/catalog/scraps', RECORDS],
  ['DELETE /api/catalog/scraps/:id', REMOVES_RECORD],
  ['PATCH /api/catalog/scraps/:id', RECORDS],
  ['POST /api/catalog/scraps/:id/commit', RECORDS],
  ['POST /api/catalog/stories/:kind/:id/members', RECORDS],
  ['POST /api/catalog/stories/music-video/:id/subjects/link', RECORDS],
  ['POST /api/catalog/types', RECORDS],
  ['DELETE /api/catalog/types/:id', REMOVES_RECORD],
  ['PATCH /api/catalog/types/:id', RECORDS],
  // /api/character
  ['PUT /api/character', RECORDS],
  ['POST /api/character/damage', RECORDS],
  ['POST /api/character/event', RECORDS],
  ['POST /api/character/reset', REMOVES_RECORD],
  ['POST /api/character/rest', RECORDS],
  ['POST /api/character/sync/jira', EXTERNAL_SYNC],
  ['POST /api/character/sync/tasks', RECORDS],
  ['POST /api/character/xp', RECORDS],
  // /api/client-errors
  ['POST /api/client-errors', CLIENT_TELEMETRY],
  // /api/code-animation
  ['POST /api/code-animation/:id/soundtrack/track', RECORDS],
  ['DELETE /api/code-animation/jobs/:id', REMOVES_RECORD],
  ['POST /api/code-animation/packages/validate', READ_OVER_POST],
  ['POST /api/code-animation/projects', RECORDS],
  ['PATCH /api/code-animation/projects/:id', RECORDS],
  ['POST /api/code-animation/projects/:id/accept', RECORDS],
  ['POST /api/code-animation/projects/:id/accepted-output', RECORDS],
  ['POST /api/code-animation/projects/:id/import', RECORDS],
  ['POST /api/code-animation/projects/:id/sound-assets', RECORDS],
  ['POST /api/code-animation/projects/:id/stage-runs/:runId/cancel', REDUCES_EXECUTION],
  // /api/code-review
  ['POST /api/code-review/cli-outcome', RECORDS],
  ['POST /api/code-review/report-failure', RECORDS],
  // /api/commands
  ['POST /api/commands/:id/stop', HANDLER_GATED],
  ['POST /api/commands/execute', HANDLER_GATED],
  ['POST /api/commands/processes/:name/action', HANDLER_GATED],
  // /api/conflict-journal
  ['DELETE /api/conflict-journal/:id', REMOVES_RECORD],
  // /api/contacts
  ['POST /api/contacts/enrich-tribe', RECORDS],
  ['POST /api/contacts/import-to-tribe', RECORDS],
  ['POST /api/contacts/sync', LOCAL_SOURCE_SYNC],
  // /api/continuous-video
  ['POST /api/continuous-video/lint', READ_OVER_POST],
  // /api/cos
  ['DELETE /api/cos/agents/:id', REMOVES_RECORD],
  ['POST /api/cos/agents/:id/feedback', RECORDS],
  ['POST /api/cos/agents/:id/kill', REDUCES_EXECUTION],
  ['POST /api/cos/agents/:id/pause', REDUCES_EXECUTION],
  ['POST /api/cos/agents/:id/terminate', REDUCES_EXECUTION],
  ['DELETE /api/cos/agents/completed', REMOVES_RECORD],
  ['POST /api/cos/digest/generate', DERIVED_REPORT],
  ['DELETE /api/cos/jobs/:id', REMOVES_RECORD],
  ['POST /api/cos/jobs/:id/gate-check', READ_OVER_POST],
  ['POST /api/cos/learning/insights', RECORDS],
  ['POST /api/cos/learning/recalculate-durations', IN_PROCESS_COMPUTE],
  ['POST /api/cos/learning/recommendations/clear-dismissed', RECORDS],
  ['POST /api/cos/learning/recommendations/dismiss', RECORDS],
  ['POST /api/cos/learning/recommendations/restore', RECORDS],
  ['DELETE /api/cos/mind/attachments/:attachmentId', REMOVES_RECORD],
  ['POST /api/cos/mind/bundle/export', READ_OVER_POST],
  ['POST /api/cos/mind/bundle/preview', READ_OVER_POST],
  ['POST /api/cos/mind/cleanup', REMOVES_RECORD],
  ['POST /api/cos/mind/events/:eventId/acknowledge', RECORDS],
  ['POST /api/cos/mind/events/:eventId/promote', RECORDS],
  ['POST /api/cos/mind/memories', RECORDS],
  ['PUT /api/cos/mind/memories/:memoryId', RECORDS],
  ['POST /api/cos/mind/pause', REDUCES_EXECUTION],
  ['POST /api/cos/mind/recipes/:recipeId/archive', REMOVES_RECORD],
  ['POST /api/cos/mind/recipes/validate', READ_OVER_POST],
  ['POST /api/cos/mind/stop', REDUCES_EXECUTION],
  ['DELETE /api/cos/mind/thinking-request', REMOVES_RECORD],
  ['POST /api/cos/pause', REDUCES_EXECUTION],
  ['POST /api/cos/reports/generate', DERIVED_REPORT],
  ['PATCH /api/cos/schedule/maintenance-runs/:id/archive', RECORDS],
  ['POST /api/cos/schedule/maintenance-runs/:id/stop', REDUCES_EXECUTION],
  ['DELETE /api/cos/schedule/on-demand/:requestId', REMOVES_RECORD],
  ['POST /api/cos/schedule/templates', RECORDS],
  ['DELETE /api/cos/schedule/templates/:templateId', REMOVES_RECORD],
  ['POST /api/cos/stop', REDUCES_EXECUTION],
  ['DELETE /api/cos/tasks/:id', REMOVES_RECORD],
  ['POST /api/cos/tasks/:id/challenge', RECORDS],
  ['POST /api/cos/tasks/:id/challenge/resolve', RECORDS],
  ['POST /api/cos/tasks/reorder', RECORDS],
  ['POST /api/cos/templates', RECORDS],
  ['DELETE /api/cos/templates/:id', REMOVES_RECORD],
  ['PUT /api/cos/templates/:id', RECORDS],
  ['POST /api/cos/templates/:id/use', RECORDS],
  ['POST /api/cos/templates/from-task', RECORDS],
  // /api/creative-commission
  ['DELETE /api/creative-commission/:id', REMOVES_RECORD],
  // /api/creative-director
  ['DELETE /api/creative-director/:id', REMOVES_RECORD],
  ['POST /api/creative-director/:id/pause', REDUCES_EXECUTION],
  ['POST /api/creative-director/:id/stop', REDUCES_EXECUTION],
  ['POST /api/creative-director/auto-cast/suggest', RECORDS],
  // /api/daily-driver
  ['POST /api/daily-driver/handled', RECORDS],
  // /api/dashboard/layouts
  ['DELETE /api/dashboard/layouts/:id', REMOVES_RECORD],
  ['PUT /api/dashboard/layouts/:id', RECORDS],
  ['PUT /api/dashboard/layouts/active', RECORDS],
  // /api/data
  ['DELETE /api/data/:category', REMOVES_RECORD],
  ['DELETE /api/data/backups/:filename', REMOVES_RECORD],
  ['POST /api/data/cos/storage/cancel', REDUCES_EXECUTION],
  ['PUT /api/data/cos/storage/pin', RECORDS],
  ['PUT /api/data/cos/storage/policy', RECORDS],
  ['POST /api/data/cos/storage/preview', READ_OVER_POST],
  ['POST /api/data/cos/storage/run', REMOVES_RECORD],
  // /api/database
  ['POST /api/database/maintenance/preflight', READ_ONLY_PROBE],
  // /api/datadog
  ['DELETE /api/datadog/instances/:id', REMOVES_RECORD],
  ['POST /api/datadog/instances/:id/search-errors', READ_ONLY_EXTERNAL],
  ['POST /api/datadog/instances/:id/test', READ_ONLY_EXTERNAL],
  // /api/decks
  ['POST /api/decks', RECORDS],
  ['DELETE /api/decks/:id', REMOVES_RECORD],
  ['PATCH /api/decks/:id', RECORDS],
  ['PATCH /api/decks/:id/cards/:cardId', RECORDS],
  ['POST /api/decks/:id/samples', RECORDS],
  ['DELETE /api/decks/:id/samples/:sampleId', REMOVES_RECORD],
  // /api/detect
  ['POST /api/detect/ai', HANDLER_GATED],
  ['POST /api/detect/pm2', READ_ONLY_PROBE],
  ['POST /api/detect/port', READ_ONLY_PROBE],
  // /api/devtools/video-download
  ['POST /api/devtools/video-download/:jobId/cancel', REDUCES_EXECUTION],
  ['DELETE /api/devtools/video-download/downloads/:id', REMOVES_RECORD],
  // /api/digital-twin
  ['POST /api/digital-twin/documents', RECORDS],
  ['DELETE /api/digital-twin/documents/:id', REMOVES_RECORD],
  ['PUT /api/digital-twin/documents/:id', RECORDS],
  ['POST /api/digital-twin/enrich/save-list', RECORDS],
  ['POST /api/digital-twin/export', READ_OVER_POST],
  ['POST /api/digital-twin/feedback', RECORDS],
  ['POST /api/digital-twin/feedback/recalculate', DERIVED_REPORT],
  ['POST /api/digital-twin/identity/image', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/identity/image/save', RECORDS],
  ['POST /api/digital-twin/import/save', RECORDS],
  ['DELETE /api/digital-twin/personas/:id', REMOVES_RECORD],
  ['PUT /api/digital-twin/settings', HANDLER_GATED],
  ['POST /api/digital-twin/snapshots', RECORDS],
  ['DELETE /api/digital-twin/snapshots/:id', REMOVES_RECORD],
  ['POST /api/digital-twin/snapshots/compare', READ_OVER_POST],
  ['DELETE /api/digital-twin/taste/:section', REMOVES_RECORD],
  ['POST /api/digital-twin/taste/:section/personalized-question', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/taste/answer', RECORDS],
  ['POST /api/digital-twin/taste/summary', TOOL_FREE_INFERENCE],
  ['PUT /api/digital-twin/traits', RECORDS],
  ['POST /api/digital-twin/twin-evidence/recompute', DERIVED_REPORT],
  // /api/digital-twin/autobiography
  ['PUT /api/digital-twin/autobiography/config', RECORDS],
  ['POST /api/digital-twin/autobiography/stories', RECORDS],
  ['DELETE /api/digital-twin/autobiography/stories/:id', REMOVES_RECORD],
  ['PUT /api/digital-twin/autobiography/stories/:id', RECORDS],
  ['POST /api/digital-twin/autobiography/stories/:id/evaluate', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/autobiography/stories/:id/follow-ups', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/autobiography/stories/:id/weave', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/autobiography/trigger', RECORDS],
  // /api/digital-twin/identity
  ['PUT /api/digital-twin/identity/chronotype', RECORDS],
  ['POST /api/digital-twin/identity/chronotype/derive', DERIVED_REPORT],
  ['POST /api/digital-twin/identity/goals', RECORDS],
  ['DELETE /api/digital-twin/identity/goals/:id', REMOVES_RECORD],
  ['PUT /api/digital-twin/identity/goals/:id', RECORDS],
  ['POST /api/digital-twin/identity/goals/:id/accept-decomposition', RECORDS],
  ['POST /api/digital-twin/identity/goals/:id/accept-phases', RECORDS],
  ['POST /api/digital-twin/identity/goals/:id/activities', RECORDS],
  ['DELETE /api/digital-twin/identity/goals/:id/activities/:activityName', REMOVES_RECORD],
  ['POST /api/digital-twin/identity/goals/:id/calendars', RECORDS],
  ['DELETE /api/digital-twin/identity/goals/:id/calendars/:subcalendarId', REMOVES_RECORD],
  ['POST /api/digital-twin/identity/goals/:id/check-in', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/identity/goals/:id/decompose', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/identity/goals/:id/generate-phases', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/identity/goals/:id/milestones', RECORDS],
  ['PUT /api/digital-twin/identity/goals/:id/milestones/:milestoneId/complete', RECORDS],
  ['PUT /api/digital-twin/identity/goals/:id/milestones/:milestoneId/tasks/:taskId/complete', RECORDS],
  ['POST /api/digital-twin/identity/goals/:id/progress', RECORDS],
  ['PUT /api/digital-twin/identity/goals/:id/progress', RECORDS],
  ['DELETE /api/digital-twin/identity/goals/:id/progress/:entryId', REMOVES_RECORD],
  ['DELETE /api/digital-twin/identity/goals/:id/schedule', REMOVES_RECORD],
  ['POST /api/digital-twin/identity/goals/:id/todos', RECORDS],
  ['DELETE /api/digital-twin/identity/goals/:id/todos/:todoId', REMOVES_RECORD],
  ['PUT /api/digital-twin/identity/goals/:id/todos/:todoId', RECORDS],
  ['PUT /api/digital-twin/identity/goals/birth-date', RECORDS],
  ['POST /api/digital-twin/identity/goals/organize', TOOL_FREE_INFERENCE],
  ['POST /api/digital-twin/identity/goals/organize/apply', RECORDS],
  ['POST /api/digital-twin/identity/longevity/derive', DERIVED_REPORT],
  // /api/digital-twin/social-accounts
  ['POST /api/digital-twin/social-accounts', RECORDS],
  ['DELETE /api/digital-twin/social-accounts/:id', REMOVES_RECORD],
  ['PUT /api/digital-twin/social-accounts/:id', RECORDS],
  ['POST /api/digital-twin/social-accounts/bulk', RECORDS],
  // /api/eidoverse/travel
  ['POST /api/eidoverse/travel/federation/chat', PEER_SURFACE],
  ['POST /api/eidoverse/travel/federation/leave', PEER_SURFACE],
  ['POST /api/eidoverse/travel/federation/visit', PEER_SURFACE],
  // /api/eidoverse/world
  ['DELETE /api/eidoverse/world/controllers/:id', REMOVES_RECORD],
  ['POST /api/eidoverse/world/foundations', RECORDS],
  ['DELETE /api/eidoverse/world/foundations/:id', REMOVES_RECORD],
  ['POST /api/eidoverse/world/foundations/:id/adopt', RECORDS],
  ['POST /api/eidoverse/world/foundations/:id/candidate', IN_PROCESS_COMPUTE],
  ['POST /api/eidoverse/world/foundations/:id/promote', PEER_SYNC],
  ['POST /api/eidoverse/world/foundations/:id/withdraw', REMOVES_RECORD],
  ['POST /api/eidoverse/world/presence', CONFIGURED_WORLD_SYNC],
  ['POST /api/eidoverse/world/project', CONFIGURED_WORLD_SYNC],
  // /api/fableloom
  ['POST /api/fableloom/:id/export/preflight', 'Read-only deterministic package gates and approved voice reference validation; no process, provider call or artifact write.'],
  ['POST /api/fableloom', RECORDS],
  ['DELETE /api/fableloom/:id', REMOVES_RECORD],
  ['PATCH /api/fableloom/:id', RECORDS],
  ['POST /api/fableloom/:id/editorial/autopilot/:runId/cancel', REDUCES_EXECUTION],
  ['POST /api/fableloom/:id/episodes', RECORDS],
  ['DELETE /api/fableloom/:id/episodes/:episodeId', REMOVES_RECORD],
  ['PATCH /api/fableloom/:id/episodes/:episodeId', RECORDS],
  ['POST /api/fableloom/:id/episodes/:episodeId/continuity/review', READ_OVER_POST],
  ['POST /api/fableloom/:id/episodes/:episodeId/nodes', RECORDS],
  ['DELETE /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId', REMOVES_RECORD],
  ['PATCH /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId', RECORDS],
  ['POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions', RECORDS],
  ['DELETE /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId', REMOVES_RECORD],
  ['PATCH /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId', RECORDS],
  ['POST /api/fableloom/:id/episodes/:episodeId/outline/validate', DERIVED_REPORT],
  ['POST /api/fableloom/:id/episodes/:episodeId/production/batch/:runId/cancel', REDUCES_EXECUTION],
  ['POST /api/fableloom/:id/episodes/:episodeId/production/plan', READ_OVER_POST],
  ['POST /api/fableloom/:id/episodes/:episodeId/sessions/host', TOOL_FREE_INFERENCE],
  ['POST /api/fableloom/:id/episodes/:episodeId/sessions/preflight', READ_OVER_POST],
  ['POST /api/fableloom/:id/episodes/:episodeId/shots/apply', RECORDS],
  ['POST /api/fableloom/:id/episodes/:episodeId/shots/cancel', REDUCES_EXECUTION],
  ['DELETE /api/fableloom/sessions/:sessionId', REMOVES_RECORD],
  ['PATCH /api/fableloom/sessions/:sessionId', RECORDS],
  // /api/feature-agents
  ['DELETE /api/feature-agents/:id', REMOVES_RECORD],
  ['POST /api/feature-agents/:id/pause', REDUCES_EXECUTION],
  ['POST /api/feature-agents/:id/stop', REDUCES_EXECUTION],
  // /api/federation/admin/v1
  ['POST /api/federation/admin/v1/execute', PEER_SURFACE],
  ['POST /api/federation/admin/v1/execution/dispatch', PEER_SURFACE],
  ['POST /api/federation/admin/v1/execution/preflight', PEER_SURFACE],
  ['POST /api/federation/admin/v1/execution/status', PEER_SURFACE],
  ['POST /api/federation/admin/v1/plans', PEER_SURFACE],
  ['POST /api/federation/admin/v1/preflight', PEER_SURFACE],
  ['POST /api/federation/admin/v1/receipt', PEER_SURFACE],
  // /api/federation/media/v1
  ['POST /api/federation/media/v1/assets', PEER_SURFACE],
  ['POST /api/federation/media/v1/jobs', PEER_SURFACE],
  ['POST /api/federation/media/v1/jobs/:id/cancel', PEER_SURFACE],
  // /api/feeds
  ['POST /api/feeds', READ_ONLY_EXTERNAL],
  ['DELETE /api/feeds/:id', REMOVES_RECORD],
  ['POST /api/feeds/:id/refresh', READ_ONLY_EXTERNAL],
  ['POST /api/feeds/items/:id/read', RECORDS],
  ['POST /api/feeds/items/read-all', RECORDS],
  ['POST /api/feeds/refresh-all', READ_ONLY_EXTERNAL],
  // /api/games
  ['POST /api/games', RECORDS],
  ['DELETE /api/games/:id', REMOVES_RECORD],
  ['PATCH /api/games/:id', RECORDS],
  ['POST /api/games/:id/artwork', RECORDS],
  ['DELETE /api/games/:id/artwork/:bindingId', REMOVES_RECORD],
  ['PATCH /api/games/:id/artwork/:bindingId', RECORDS],
  ['POST /api/games/:id/compile', IN_PROCESS_COMPUTE],
  ['POST /api/games/:id/music', RECORDS],
  ['DELETE /api/games/:id/music/:bindingId', REMOVES_RECORD],
  ['PATCH /api/games/:id/music/:bindingId', RECORDS],
  ['POST /api/games/:id/sprites', RECORDS],
  ['DELETE /api/games/:id/sprites/:spriteId', REMOVES_RECORD],
  // /api/github
  ['DELETE /api/github/accounts/:id', REMOVES_RECORD],
  ['POST /api/github/audit/:accountId', READ_ONLY_EXTERNAL],
  ['DELETE /api/github/automations/rules/:id', REMOVES_RECORD],
  ['POST /api/github/notifications/sync', HANDLER_GATED],
  ['POST /api/github/repos/sync', READ_ONLY_EXTERNAL],
  // /api/harnesses
  ['POST /api/harnesses/models/refresh', CONFIGURED_INFERENCE],
  // /api/health
  ['POST /api/health/import/xml', RECORDS],
  ['POST /api/health/ingest', RECORDS],
  // /api/history
  ['DELETE /api/history', REMOVES_RECORD],
  ['DELETE /api/history/:id', REMOVES_RECORD],
  // /api/html-composition
  ['POST /api/html-composition/:jobId/cancel', REDUCES_EXECUTION],
  // /api/human-actions
  ['POST /api/human-actions/plans', RECORDS],
  // /api/image-clean
  ['POST /api/image-clean', HANDLER_GATED],
  ['POST /api/image-clean/result/:jobId/save', RECORDS],
  // /api/image-gen
  ['DELETE /api/image-gen/:filename', REMOVES_RECORD],
  ['POST /api/image-gen/:filename/cancel-delete', REDUCES_EXECUTION],
  ['POST /api/image-gen/:filename/clean', IN_PROCESS_MEDIA],
  ['PATCH /api/image-gen/:filename/prompt', RECORDS],
  ['POST /api/image-gen/:filename/remove-watermark', IN_PROCESS_MEDIA],
  ['POST /api/image-gen/:filename/visibility', RECORDS],
  ['POST /api/image-gen/cancel', REDUCES_EXECUTION],
  ['POST /api/image-gen/gallery/lookup', READ_OVER_POST],
  ['POST /api/image-gen/models/:modelId/download', MODEL_DATA],
  ['POST /api/image-gen/models/:modelId/repair', MODEL_DATA],
  ['POST /api/image-gen/models/verify', MODEL_DATA],
  ['POST /api/image-gen/prompt-preview', READ_OVER_POST],
  // Refreshes public Runway documentation into a fixed disposable cache; no credentials, process or paid inference.
  ['POST /api/image-gen/runway-models/refresh', READ_OVER_POST],
  ['POST /api/image-gen/setup/create-venv', HANDLER_GATED],
  ['POST /api/image-gen/setup/flux2-install', MANAGED_INSTALL],
  ['DELETE /api/image-gen/setup/hf-token', REMOVES_RECORD],
  ['POST /api/image-gen/setup/hf-token', CONNECTOR_CREDENTIAL],
  ['POST /api/image-gen/setup/install', HANDLER_GATED],
  ['POST /api/image-gen/setup/moss-install', HANDLER_GATED],
  ['POST /api/image-gen/setup/moss-weights', HANDLER_GATED],
  ['POST /api/image-gen/upload', RECORDS],
  // /api/image-to-3d
  ['DELETE /api/image-to-3d/models/:id', REMOVES_RECORD],
  ['POST /api/image-to-3d/models/:id/usdz', RECORDS],
  // /api/image-video/models
  ['DELETE /api/image-video/models/custom/:id', REMOVES_RECORD],
  ['PATCH /api/image-video/models/custom/:id', RECORDS],
  ['DELETE /api/image-video/models/hf/:dirName', REMOVES_RECORD],
  ['POST /api/image-video/models/install/huggingface', MODEL_DATA],
  ['DELETE /api/image-video/models/lora/:filename', REMOVES_RECORD],
  ['PATCH /api/image-video/models/registry/:id/availability', RECORDS],
  ['DELETE /api/image-video/models/store/:backend/:key', REMOVES_RECORD],
  // /api/imessage
  ['POST /api/imessage/blocklist', RECORDS],
  ['PUT /api/imessage/blocklist', RECORDS],
  ['DELETE /api/imessage/blocklist/:handle', REMOVES_RECORD],
  ['DELETE /api/imessage/conversations/:chatKey', REMOVES_RECORD],
  ['DELETE /api/imessage/events/:id', REMOVES_RECORD],
  ['POST /api/imessage/sync', LOCAL_SOURCE_SYNC],
  // /api/insights
  ['POST /api/insights/goal-scorecard/compute', DERIVED_REPORT],
  ['PUT /api/insights/goal-scorecard/rules', RECORDS],
  ['PUT /api/insights/goal-scorecard/settings', RECORDS],
  ['POST /api/insights/narrative/refresh', TOOL_FREE_INFERENCE],
  ['POST /api/insights/themes/refresh', TOOL_FREE_INFERENCE],
  // /api/instances
  ['POST /api/instances/peers', HANDLER_GATED],
  ['DELETE /api/instances/peers/:id', REMOVES_RECORD],
  ['PUT /api/instances/peers/:id', HANDLER_GATED],
  ['POST /api/instances/peers/:id/connect', HANDLER_GATED],
  ['POST /api/instances/peers/:id/pair-secret', HANDLER_GATED],
  ['POST /api/instances/peers/:id/probe', HANDLER_GATED],
  ['POST /api/instances/peers/:id/reciprocate', HANDLER_GATED],
  ['POST /api/instances/peers/:id/sync', HANDLER_GATED],
  ['POST /api/instances/peers/announce', PEER_SURFACE],
  ['POST /api/instances/peers/pair-secret', PEER_SURFACE],
  ['POST /api/instances/peers/sync-categories', PEER_SURFACE],
  ['DELETE /api/instances/peers/tailcat/forwards/:id', REMOVES_RECORD],
  ['DELETE /api/instances/peers/tailcat/serve', REMOVES_RECORD],
  ['PUT /api/instances/self', RECORDS],
  // /api/jira
  ['DELETE /api/jira/instances/:id', REMOVES_RECORD],
  ['POST /api/jira/instances/:id/test', READ_ONLY_EXTERNAL],
  ['POST /api/jira/reports/generate', TOOL_FREE_INFERENCE],
  // /api/legacy-export
  ['POST /api/legacy-export', READ_OVER_POST],
  // /api/lmstudio
  ['POST /api/lmstudio/analyze-task', TOOL_FREE_INFERENCE],
  ['POST /api/lmstudio/classify-memory', TOOL_FREE_INFERENCE],
  ['POST /api/lmstudio/completion', TOOL_FREE_INFERENCE],
  ['POST /api/lmstudio/download', MODEL_DATA],
  ['POST /api/lmstudio/embeddings', TOOL_FREE_INFERENCE],
  ['POST /api/lmstudio/load', MODEL_DATA],
  ['POST /api/lmstudio/unload', REDUCES_EXECUTION],
  // /api/local-llm
  ['POST /api/local-llm/assessments/delete', MODEL_DATA],
  ['POST /api/local-llm/assessments/run', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/assessments/sweep', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/assessments/sweep/cancel', REDUCES_EXECUTION],
  ['POST /api/local-llm/capability-tests/delete', MODEL_DATA],
  ['POST /api/local-llm/compare', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/delete', MODEL_DATA],
  ['POST /api/local-llm/download-preflight', MODEL_DATA],
  ['POST /api/local-llm/install', MODEL_DATA],
  ['POST /api/local-llm/jev/install/cancel', REDUCES_EXECUTION],
  ['POST /api/local-llm/jev/score', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/jev/unload', REDUCES_EXECUTION],
  ['POST /api/local-llm/laya-mlx/score', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/llama-server/download-model', MODEL_DATA],
  ['POST /api/local-llm/llama-server/download-model/cancel', REDUCES_EXECUTION],
  ['POST /api/local-llm/llama-server/download-model/remove', MODEL_DATA],
  ['POST /api/local-llm/migrate', MODEL_DATA],
  ['POST /api/local-llm/mtplx/models/pull', MODEL_DATA],
  ['POST /api/local-llm/mtplx/models/remove', MODEL_DATA],
  ['POST /api/local-llm/security-guard/install/cancel', REDUCES_EXECUTION],
  ['POST /api/local-llm/slotstream/models/download', MODEL_DATA],
  ['POST /api/local-llm/slotstream/models/download/cancel', REDUCES_EXECUTION],
  ['POST /api/local-llm/switch', MODEL_DATA],
  ['POST /api/local-llm/test', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/test/stream', CONFIGURED_INFERENCE],
  ['POST /api/local-llm/unload', REDUCES_EXECUTION],
  // /api/loops
  ['DELETE /api/loops/:id', REMOVES_RECORD],
  ['POST /api/loops/:id/stop', REDUCES_EXECUTION],
  // /api/lora-datasets
  ['POST /api/lora-datasets/:id/caption-runs/:runId/cancel', REDUCES_EXECUTION],
  // /api/lora-training
  ['POST /api/lora-training/runs/:id/cancel', REDUCES_EXECUTION],
  // /api/loras
  ['DELETE /api/loras/:filename', REMOVES_RECORD],
  ['PATCH /api/loras/:filename', RECORDS],
  ['DELETE /api/loras/auth/civitai', REMOVES_RECORD],
  ['POST /api/loras/auth/civitai', CONNECTOR_CREDENTIAL],
  ['POST /api/loras/install', MODEL_DATA],
  ['POST /api/loras/install/huggingface', MODEL_DATA],
  ['POST /api/loras/install/huggingface/stream', MODEL_DATA],
  ['POST /api/loras/install/preflight', MODEL_DATA],
  // /api/managed-visitor-admin
  ['DELETE /api/managed-visitor-admin/:appId/credential', REMOVES_RECORD],
  ['POST /api/managed-visitor-admin/:appId/credential', MANAGED_VISITOR_BROKER],
  // /api/managed-visitors/v1
  ['POST /api/managed-visitors/v1/admissions', MANAGED_VISITOR_BROKER],
  ['POST /api/managed-visitors/v1/admissions/cancel', REDUCES_EXECUTION],
  ['POST /api/managed-visitors/v1/sessions/:id/actions', MANAGED_VISITOR_BROKER],
  ['POST /api/managed-visitors/v1/sessions/:id/leave', REDUCES_EXECUTION],
  ['POST /api/managed-visitors/v1/sessions/:id/observations', MANAGED_VISITOR_BROKER],
  // /api/meatspace
  ['POST /api/meatspace/activities', RECORDS],
  ['DELETE /api/meatspace/activities/:index', REMOVES_RECORD],
  ['PUT /api/meatspace/activities/:index', RECORDS],
  ['POST /api/meatspace/alcohol/custom-drinks', RECORDS],
  ['DELETE /api/meatspace/alcohol/custom-drinks/:index', REMOVES_RECORD],
  ['PUT /api/meatspace/alcohol/custom-drinks/:index', RECORDS],
  ['POST /api/meatspace/alcohol/log', RECORDS],
  ['DELETE /api/meatspace/alcohol/log/:date/:index', REMOVES_RECORD],
  ['PUT /api/meatspace/alcohol/log/:date/:index', RECORDS],
  ['PUT /api/meatspace/birth-date', RECORDS],
  ['POST /api/meatspace/blood', RECORDS],
  ['DELETE /api/meatspace/blood/:id', REMOVES_RECORD],
  ['POST /api/meatspace/blood-pressure', RECORDS],
  ['DELETE /api/meatspace/blood-pressure/:date', REMOVES_RECORD],
  ['POST /api/meatspace/body', RECORDS],
  ['DELETE /api/meatspace/body/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/config', RECORDS],
  ['POST /api/meatspace/epigenetic', RECORDS],
  ['DELETE /api/meatspace/epigenetic/:id', REMOVES_RECORD],
  ['POST /api/meatspace/eyes', RECORDS],
  ['DELETE /api/meatspace/eyes/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/eyes/:id', RECORDS],
  ['POST /api/meatspace/life-events', RECORDS],
  ['DELETE /api/meatspace/life-events/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/life-events/:id', RECORDS],
  ['PUT /api/meatspace/lifestyle', RECORDS],
  ['POST /api/meatspace/nicotine/custom-products', RECORDS],
  ['DELETE /api/meatspace/nicotine/custom-products/:index', REMOVES_RECORD],
  ['PUT /api/meatspace/nicotine/custom-products/:index', RECORDS],
  ['POST /api/meatspace/nicotine/log', RECORDS],
  ['DELETE /api/meatspace/nicotine/log/:date/:index', REMOVES_RECORD],
  ['PUT /api/meatspace/nicotine/log/:date/:index', RECORDS],
  ['PUT /api/meatspace/post/config', RECORDS],
  ['POST /api/meatspace/post/memory-drill', READ_OVER_POST],
  ['POST /api/meatspace/post/memory-items', RECORDS],
  ['DELETE /api/meatspace/post/memory-items/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/post/memory-items/:id', RECORDS],
  ['POST /api/meatspace/post/memory-items/:id/attest-mastery', RECORDS],
  ['POST /api/meatspace/post/memory-items/:id/practice', RECORDS],
  ['PUT /api/meatspace/post/morse/level', RECORDS],
  ['POST /api/meatspace/post/morse/rounds', RECORDS],
  ['POST /api/meatspace/post/sessions', RECORDS],
  ['POST /api/meatspace/post/training', RECORDS],
  ['POST /api/meatspace/post/training/runs', RECORDS],
  ['POST /api/meatspace/workouts', RECORDS],
  ['DELETE /api/meatspace/workouts/:id', REMOVES_RECORD],
  // /api/meatspace/genome
  ['DELETE /api/meatspace/genome', REMOVES_RECORD],
  ['DELETE /api/meatspace/genome/clinvar', REMOVES_RECORD],
  ['POST /api/meatspace/genome/clinvar/scan', READ_OVER_POST],
  ['POST /api/meatspace/genome/clinvar/sync', REFERENCE_DATASET],
  ['POST /api/meatspace/genome/epigenetic', RECORDS],
  ['DELETE /api/meatspace/genome/epigenetic/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/genome/epigenetic/:id', RECORDS],
  ['POST /api/meatspace/genome/epigenetic/:id/log', RECORDS],
  ['POST /api/meatspace/genome/markers', RECORDS],
  ['DELETE /api/meatspace/genome/markers/:id', REMOVES_RECORD],
  ['PUT /api/meatspace/genome/markers/:id/notes', RECORDS],
  ['POST /api/meatspace/genome/scan', DERIVED_REPORT],
  ['POST /api/meatspace/genome/search', READ_OVER_POST],
  ['POST /api/meatspace/genome/upload', RECORDS],
  // /api/media
  ['POST /api/media/stop', REDUCES_EXECUTION],
  // /api/media-jobs
  ['DELETE /api/media-jobs/:id', REMOVES_RECORD],
  ['POST /api/media-jobs/:id/cancel', REDUCES_EXECUTION],
  ['POST /api/media-jobs/cancel-queued', REDUCES_EXECUTION],
  // /api/media/annotations
  ['PATCH /api/media/annotations/:key', RECORDS],
  // /api/media/collections
  ['POST /api/media/holders/primary', REMOVES_RECORD],
  ['POST /api/media/collections', RECORDS],
  ['DELETE /api/media/collections/:id', REMOVES_RECORD],
  ['PATCH /api/media/collections/:id', RECORDS],
  ['POST /api/media/collections/:id/items', RECORDS],
  ['DELETE /api/media/collections/:id/items/:key', REMOVES_RECORD],
  ['POST /api/media/collections/:id/items/bulk', RECORDS],
  // /api/media/sketches
  ['POST /api/media/sketches', RECORDS],
  ['PUT /api/media/sketches/:key', RECORDS],
  // /api/memory
  ['POST /api/memory', RECORDS],
  ['DELETE /api/memory/:id', REMOVES_RECORD],
  ['PUT /api/memory/:id', RECORDS],
  ['POST /api/memory/:id/approve', RECORDS],
  ['POST /api/memory/:id/reject', RECORDS],
  ['POST /api/memory/consolidate', RECORDS],
  ['POST /api/memory/decay', RECORDS],
  ['DELETE /api/memory/expired', REMOVES_RECORD],
  ['POST /api/memory/link', RECORDS],
  ['POST /api/memory/search', READ_OVER_POST],
  ['POST /api/memory/sync', RECORDS],
  // /api/messages
  ['POST /api/messages/accounts', RECORDS],
  ['DELETE /api/messages/accounts/:id', REMOVES_RECORD],
  ['PUT /api/messages/accounts/:id', RECORDS],
  ['POST /api/messages/accounts/:id/cache/clear', REMOVES_RECORD],
  ['POST /api/messages/debug/clear-token', REMOVES_RECORD],
  ['POST /api/messages/drafts', RECORDS],
  ['DELETE /api/messages/drafts/:id', REMOVES_RECORD],
  ['POST /api/messages/drafts/:id/reconcile', RECORDS],
  ['POST /api/messages/drafts/generate', TOOL_FREE_INFERENCE],
  ['POST /api/messages/evaluate', TOOL_FREE_INFERENCE],
  ['DELETE /api/messages/triage-rules/:index', REMOVES_RECORD],
  // /api/model-personality
  ['DELETE /api/model-personality/history/:runId', REMOVES_RECORD],
  ['PUT /api/model-personality/settings', CONFIGURED_SELECTION],
  // /api/models/performance/task-benchmark
  ['POST /api/models/performance/task-benchmark/discover', CONFIGURED_INFERENCE],
  ['POST /api/models/performance/task-benchmark/run', CONFIGURED_INFERENCE],
  // /api/mood-boards
  ['POST /api/mood-boards', RECORDS],
  ['DELETE /api/mood-boards/:id', REMOVES_RECORD],
  ['PATCH /api/mood-boards/:id', RECORDS],
  ['POST /api/mood-boards/:id/backfill-prompts', RECORDS],
  ['POST /api/mood-boards/:id/items', RECORDS],
  ['DELETE /api/mood-boards/:id/items/:itemId', REMOVES_RECORD],
  ['PATCH /api/mood-boards/:id/items/:itemId', RECORDS],
  ['POST /api/mood-boards/:id/localize-media', PUBLIC_FETCH],
  ['DELETE /api/mood-boards/:id/pinterest', REMOVES_RECORD],
  ['PUT /api/mood-boards/:id/pinterest', RECORDS],
  ['POST /api/mood-boards/:id/pinterest/sync', PUBLIC_FETCH],
  ['POST /api/mood-boards/:id/x-post', PUBLIC_FETCH],
  // /api/mortalloom
  ['POST /api/mortalloom/import', RECORDS],
  // /api/music
  ['POST /api/music/code/preview', READ_OVER_POST],
  ['POST /api/music/models', MODEL_DATA],
  ['DELETE /api/music/models/:engine/*id', REMOVES_RECORD],
  ['POST /api/music/prompt-preview', READ_OVER_POST],
  // /api/music-video
  ['DELETE /api/music-video/:id', REMOVES_RECORD],
  ['POST /api/music-video/:id/auto-reviews/:runId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/auto-reviews/:runId/stop', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/autonomous/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/autonomous/stop', REDUCES_EXECUTION],
  ['DELETE /api/music-video/:id/cast-and-sets', REMOVES_RECORD],
  ['DELETE /api/music-video/:id/cast-and-sets/feedback/:feedbackId', REMOVES_RECORD],
  ['POST /api/music-video/:id/cast-and-sets/reconfirm', RECORDS],
  ['POST /api/music-video/:id/clone', RECORDS],
  ['DELETE /api/music-video/:id/composition/document', REMOVES_RECORD],
  ['POST /api/music-video/:id/composition/document/accept', HANDLER_GATED],
  ['DELETE /api/music-video/:id/composition/document/candidate', REMOVES_RECORD],
  ['POST /api/music-video/:id/composition/document/engine/upgrade', RECORDS],
  ['POST /api/music-video/:id/composition/document/template', RECORDS],
  ['POST /api/music-video/:id/composition/document/zip', HANDLER_GATED],
  ['POST /api/music-video/:id/dev-artifacts', RECORDS],
  ['DELETE /api/music-video/:id/dev-artifacts/:artifactId', REMOVES_RECORD],
  ['POST /api/music-video/:id/dev-artifacts/:artifactId/notes', RECORDS],
  ['PATCH /api/music-video/:id/dev-artifacts/:artifactId/notes/:noteId', RECORDS],
  ['DELETE /api/music-video/:id/excerpt/:excerptId', REMOVES_RECORD],
  ['POST /api/music-video/:id/excerpt/:excerptId/notes', RECORDS],
  ['DELETE /api/music-video/:id/excerpt/:excerptId/notes/:noteId', REMOVES_RECORD],
  ['PATCH /api/music-video/:id/excerpt/:excerptId/notes/:noteId', RECORDS],
  ['POST /api/music-video/:id/excerpt/:excerptId/revisions', RECORDS],
  ['DELETE /api/music-video/:id/film-looks/:lookId', REMOVES_RECORD],
  ['PUT /api/music-video/:id/finished-outside', RECORDS],
  ['POST /api/music-video/:id/handoff/import', RECORDS],
  ['POST /api/music-video/:id/lyrics/import', RECORDS],
  ['POST /api/music-video/:id/lyrics/import-track', RECORDS],
  ['POST /api/music-video/:id/media-pool/add', RECORDS],
  ['POST /api/music-video/:id/media-pool/delete', REMOVES_RECORD],
  ['POST /api/music-video/:id/media-pool/import', RECORDS],
  ['PATCH /api/music-video/:id/media-pool/marks', RECORDS],
  ['PUT /api/music-video/:id/production-review', RECORDS],
  ['POST /api/music-video/:id/production-review/alignment', HANDLER_GATED],
  ['POST /api/music-video/:id/production-review/approve', HANDLER_GATED],
  ['POST /api/music-video/:id/production-review/document-shots', RECORDS],
  ['POST /api/music-video/:id/production-review/feedback', RECORDS],
  ['POST /api/music-video/:id/production-review/feedback/resolve', HANDLER_GATED],
  ['POST /api/music-video/:id/production-review/import', RECORDS],
  ['POST /api/music-video/:id/production-review/lyric-anchors', RECORDS],
  ['POST /api/music-video/:id/production-review/revert', RECORDS],
  ['POST /api/music-video/:id/production-review/shots/:shotId/bind', RECORDS],
  ['DELETE /api/music-video/:id/production-review/stale-rows', REMOVES_RECORD],
  ['POST /api/music-video/:id/production-runs/:runId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/production-runs/:runId/stop', REDUCES_EXECUTION],
  ['PATCH /api/music-video/:id/publish-kit/copy', RECORDS],
  ['POST /api/music-video/:id/publish-kit/cover-art', IN_PROCESS_MEDIA],
  ['PUT /api/music-video/:id/publish-kit/cover-art/design', RECORDS],
  ['PUT /api/music-video/:id/publish-kit/thumbnail', RECORDS],
  ['DELETE /api/music-video/:id/publish-kit/youtube-thumbnail', REMOVES_RECORD],
  ['POST /api/music-video/:id/publish-kit/youtube-thumbnail', IN_PROCESS_MEDIA],
  ['POST /api/music-video/:id/publish-kit/youtube-thumbnail/paint/preview', READ_OVER_POST],
  ['POST /api/music-video/:id/publish-kit/youtube-thumbnail/tests', RECORDS],
  ['DELETE /api/music-video/:id/publish-kit/youtube-thumbnail/tests/:filename', REMOVES_RECORD],
  ['POST /api/music-video/:id/publish/:target/cross-links', HANDLER_GATED],
  ['POST /api/music-video/:id/publish/:target/prepare', HANDLER_GATED],
  ['POST /api/music-video/:id/publish/:target/preview', READ_OVER_POST],
  ['PUT /api/music-video/:id/publish/cross-links', RECORDS],
  ['DELETE /api/music-video/:id/publish/drafts/:draftId', REMOVES_RECORD],
  ['DELETE /api/music-video/:id/publish/posts/:target', REMOVES_RECORD],
  ['PUT /api/music-video/:id/publish/posts/:target', RECORDS],
  ['POST /api/music-video/:id/references/catalog-labels', RECORDS],
  ['POST /api/music-video/:id/render-cleanup', REMOVES_RECORD],
  ['POST /api/music-video/:id/revisions/:revisionId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/revisions/:revisionId/release', RECORDS],
  ['POST /api/music-video/:id/scenes', RECORDS],
  ['DELETE /api/music-video/:id/scenes/:sceneId', REMOVES_RECORD],
  ['PATCH /api/music-video/:id/scenes/:sceneId', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/merge-next', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/merge-previous', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/split', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/start', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/swap-frames', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/takes', RECORDS],
  ['PATCH /api/music-video/:id/scenes/:sceneId/takes/:takeId', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/takes/:takeId/select', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/takes/reject-unused', RECORDS],
  ['POST /api/music-video/:id/scenes/:sceneId/takes/use', RECORDS],
  ['POST /api/music-video/:id/scenes/reorder', RECORDS],
  ['POST /api/music-video/:id/shots/:sceneId/render/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/song-revision', RECORDS],
  ['POST /api/music-video/:id/song-revision/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/:id/story/apply', RECORDS],
  ['POST /api/music-video/:id/story/art-guides', HANDLER_GATED],
  ['POST /api/music-video/:id/story/beats', RECORDS],
  ['POST /api/music-video/:id/story/propose', HANDLER_GATED],
  ['PUT /api/music-video/:id/story/summary', RECORDS],
  ['PUT /api/music-video/:id/festival-packet', RECORDS],
  ['PATCH /api/music-video/:id/treatment', RECORDS],
  ['POST /api/music-video/:id/treatment/apply', RECORDS],
  ['POST /api/music-video/:id/treatment/proofs/:proofId/review', RECORDS],
  ['DELETE /api/music-video/:id/vocal-stem', REMOVES_RECORD],
  ['POST /api/music-video/excerpt/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/lyrics/align/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/making-of/export', READ_OVER_POST],
  ['POST /api/music-video/making-of/preview', READ_OVER_POST],
  ['POST /api/music-video/publish-kit/:jobId/cancel', REDUCES_EXECUTION],
  ['DELETE /api/music-video/publish/artist-styles', REMOVES_RECORD],
  ['PUT /api/music-video/publish/artist-styles', RECORDS],
  ['DELETE /api/music-video/publish/cover-fonts/:fontId', REMOVES_RECORD],
  ['PUT /api/music-video/publish/platforms', RECORDS],
  ['POST /api/music-video/render/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/transcribe-midi/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/music-video/vocal-stem/separate/:jobId/cancel', REDUCES_EXECUTION],
  // /api/music-video/character-styles
  ['PUT /api/music-video/character-styles/:id/reference', RECORDS],
  // /api/music/supercollider
  ['POST /api/music/supercollider/renders/:jobId/cancel', REDUCES_EXECUTION],
  // /api/notes
  ['DELETE /api/notes/vaults/:id', REMOVES_RECORD],
  ['DELETE /api/notes/vaults/:id/note', REMOVES_RECORD],
  ['POST /api/notes/vaults/:id/note', RECORDS],
  ['PUT /api/notes/vaults/:id/note', RECORDS],
  // /api/notifications
  ['DELETE /api/notifications', REMOVES_RECORD],
  ['DELETE /api/notifications/:id', REMOVES_RECORD],
  ['POST /api/notifications/:id/read', RECORDS],
  ['POST /api/notifications/read-all', RECORDS],
  // /api/palette
  ['POST /api/palette/action/:id', HANDLER_GATED],
  // /api/peer-administration
  ['PUT /api/peer-administration/catalog-review', HANDLER_GATED],
  ['POST /api/peer-administration/execution-dispatch', HANDLER_GATED],
  ['POST /api/peer-administration/execution-grants', HANDLER_GATED],
  ['POST /api/peer-administration/execution-preview', HANDLER_GATED],
  ['POST /api/peer-administration/execution-status', HANDLER_GATED],
  ['POST /api/peer-administration/grants', HANDLER_GATED],
  ['POST /api/peer-administration/preview', HANDLER_GATED],
  // /api/peer-media
  ['POST /api/peer-media/delete', PEER_SURFACE],
  ['POST /api/peer-media/release', PEER_SURFACE],
  // /api/peer-sync
  ['POST /api/peer-sync/pull-metadata', PEER_SYNC],
  ['POST /api/peer-sync/pull-record', PEER_SYNC],
  ['POST /api/peer-sync/push', PEER_SURFACE],
  ['POST /api/peer-sync/subscriptions', PEER_SYNC],
  ['DELETE /api/peer-sync/subscriptions/:id', REMOVES_RECORD],
  ['POST /api/peer-sync/sync-now', PEER_SYNC],
  ['POST /api/peer-sync/sync-record', PEER_SYNC],
  // /api/pipeline
  ['DELETE /api/pipeline/audio/music-library/:filename', REMOVES_RECORD],
  ['PATCH /api/pipeline/editorial/checks/:id', RECORDS],
  ['DELETE /api/pipeline/editorial/custom-checks/:id', REMOVES_RECORD],
  ['PATCH /api/pipeline/editorial/readiness-gate', RECORDS],
  ['DELETE /api/pipeline/issues/:id', REMOVES_RECORD],
  ['PATCH /api/pipeline/issues/:id', RECORDS],
  ['POST /api/pipeline/issues/:id/auto-run-text/cancel', REDUCES_EXECUTION],
  ['DELETE /api/pipeline/issues/:id/pov-rewrites/:rewriteId', REMOVES_RECORD],
  ['POST /api/pipeline/issues/:id/stages/:stageId/recover', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/:stageId/restore', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/audio/cues/:cueIdx/render', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/issues/:id/stages/audio/extract-lines', PIPELINE_DETERMINISTIC],
  ['PATCH /api/pipeline/issues/:id/stages/audio/lines/:lineIdx', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/audio/lines/:lineIdx/render', PIPELINE_DETERMINISTIC],
  ['DELETE /api/pipeline/issues/:id/stages/audio/music', REMOVES_RECORD],
  ['POST /api/pipeline/issues/:id/stages/audio/music/attach', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/audio/music/generate', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/issues/:id/stages/audio/music/upload', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/comicPages/extract-pages', PIPELINE_DETERMINISTIC],
  ['PATCH /api/pipeline/issues/:id/stages/comicPages/pages/:pageIndex', RECORDS],
  ['POST /api/pipeline/issues/:id/stages/storyboards/scenes/:index/video', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/series', RECORDS],
  ['DELETE /api/pipeline/series/:id', REMOVES_RECORD],
  ['PATCH /api/pipeline/series/:id', RECORDS],
  ['PATCH /api/pipeline/series/:id/arc-fields/:field/lock', RECORDS],
  ['POST /api/pipeline/series/:id/arc/derive-from-manuscript/commit', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/series/:id/autopilot/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/autopilot/model-outcomes', RECORDS],
  ['POST /api/pipeline/series/:id/autopilot/pause', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/continuity-bible/generate/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/editorial/analyze/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/editorial/checks/run/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/editorial/panel/run/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/issues', RECORDS],
  ['POST /api/pipeline/series/:id/manuscript/completeness/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/manuscript/cuts/apply', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/series/:id/manuscript/cuts/preview', PIPELINE_DETERMINISTIC],
  ['PATCH /api/pipeline/series/:id/manuscript/review/comments/:commentId', RECORDS],
  ['POST /api/pipeline/series/:id/manuscript/review/comments/:commentId/accept', RECORDS],
  ['POST /api/pipeline/series/:id/manuscript/review/comments/:commentId/undo', RECORDS],
  ['PUT /api/pipeline/series/:id/manuscript/sections/:issueId', RECORDS],
  ['POST /api/pipeline/series/:id/reverse-outline/generate/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/review/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/review/fix/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/:id/seasons', RECORDS],
  ['DELETE /api/pipeline/series/:id/seasons/:seasonId', REMOVES_RECORD],
  ['PATCH /api/pipeline/series/:id/seasons/:seasonId', RECORDS],
  ['POST /api/pipeline/series/:id/seasons/:seasonId/generate-beats/cancel', REDUCES_EXECUTION],
  ['POST /api/pipeline/series/merge', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/series/merge/preview', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/tts/narrate', PIPELINE_DETERMINISTIC],
  ['PATCH /api/pipeline/tts/narrate/segment', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/tts/narrate/segment', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/tts/preview', PIPELINE_DETERMINISTIC],
  ['POST /api/pipeline/tts/synthesize', PIPELINE_DETERMINISTIC],
  // /api/ports
  ['POST /api/ports/allocate', READ_ONLY_PROBE],
  ['POST /api/ports/check', READ_ONLY_PROBE],
  // /api/privacy
  ['DELETE /api/privacy/broker-cases/:id/evidence', REMOVES_RECORD],
  ['POST /api/privacy/broker-cases/:id/recheck', RECORDS],
  ['POST /api/privacy/broker-cases/:id/transition', RECORDS],
  ['PUT /api/privacy/brokers/:id', RECORDS],
  ['POST /api/privacy/brokers/refresh', READ_ONLY_EXTERNAL],
  ['POST /api/privacy/changes', RECORDS],
  ['POST /api/privacy/changes/:id/orgs/:orgId/draft-email', RECORDS],
  ['POST /api/privacy/changes/:id/orgs/:orgId/removed', RECORDS],
  ['POST /api/privacy/changes/:id/orgs/:orgId/updated', RECORDS],
  ['POST /api/privacy/orgs', RECORDS],
  ['DELETE /api/privacy/orgs/:id', REMOVES_RECORD],
  ['PUT /api/privacy/orgs/:id', RECORDS],
  ['PUT /api/privacy/orgs/:id/holdings', RECORDS],
  ['POST /api/privacy/subjects', RECORDS],
  ['DELETE /api/privacy/subjects/:id', REMOVES_RECORD],
  ['PUT /api/privacy/subjects/:id', RECORDS],
  ['POST /api/privacy/subjects/:id/consents/revoke', REDUCES_EXECUTION],
  ['POST /api/privacy/vault', RECORDS],
  ['DELETE /api/privacy/vault/:id', REMOVES_RECORD],
  ['PUT /api/privacy/vault/:id', RECORDS],
  ['POST /api/privacy/vault/:id/reveal', READ_OVER_POST],
  // /api/prompts
  ['DELETE /api/prompts/:stage', REMOVES_RECORD],
  ['POST /api/prompts/:stage/preview', READ_OVER_POST],
  ['POST /api/prompts/reload', READ_OVER_POST],
  ['DELETE /api/prompts/variables/:key', REMOVES_RECORD],
  // /api/provider-fallbacks
  ['PUT /api/provider-fallbacks', CONFIGURED_SELECTION],
  // /api/providers
  ['DELETE /api/providers/:id', REMOVES_RECORD],
  ['POST /api/providers/:id/derive', RECORDS],
  ['POST /api/providers/:id/refresh-models', CONFIGURED_INFERENCE],
  ['POST /api/providers/:id/status/recover', RECORDS],
  ['POST /api/providers/:id/test', CONFIGURED_INFERENCE],
  ['POST /api/providers/:id/test-vision', CONFIGURED_INFERENCE],
  ['POST /api/providers/:id/vision-suite', CONFIGURED_INFERENCE],
  ['POST /api/providers/bindings', RECORDS],
  ['PATCH /api/providers/bindings/:id', RECORDS],
  ['POST /api/providers/bindings/:id/link/preview', RECORDS],
  ['POST /api/providers/bindings/:id/unlink', RECORDS],
  ['POST /api/providers/codex/account/login/cancel', REDUCES_EXECUTION],
  ['DELETE /api/providers/connections/:id', REMOVES_RECORD],
  ['POST /api/providers/connections/:id/refresh-models', CONFIGURED_INFERENCE],
  ['POST /api/providers/fleet-host/key', PEER_SURFACE],
  ['POST /api/providers/fleet-host/stop', REDUCES_EXECUTION],
  ['POST /api/providers/fleet-peer-hosts/:peerId/key', RECORDS],
  ['POST /api/providers/model-pins/clear', RECORDS],
  ['PATCH /api/providers/routes/:providerId/model-aliases', RECORDS],
  ['DELETE /api/providers/services/:slug', REMOVES_RECORD],
  ['POST /api/providers/services/:slug/refresh-catalog', CONFIGURED_INFERENCE],
  // /api/providers/comparison
  ['POST /api/providers/comparison/import', RECORDS],
  // /api/rapid-reader
  ['POST /api/rapid-reader/library', RECORDS],
  ['DELETE /api/rapid-reader/library/:id', REMOVES_RECORD],
  ['POST /api/rapid-reader/library/fetch', PUBLIC_FETCH],
  // /api/review
  ['DELETE /api/review/items/:id', REMOVES_RECORD],
  ['PATCH /api/review/items/:id', RECORDS],
  ['POST /api/review/items/:id/complete', RECORDS],
  ['POST /api/review/items/:id/dismiss', RECORDS],
  ['POST /api/review/items/bulk-status', RECORDS],
  ['POST /api/review/queue/delivery', RECORDS],
  ['POST /api/review/queue/triage', RECORDS],
  ['POST /api/review/todo', RECORDS],
  // /api/rounds
  ['POST /api/rounds', RECORDS],
  ['DELETE /api/rounds/:id', REMOVES_RECORD],
  ['PATCH /api/rounds/:id', RECORDS],
  ['POST /api/rounds/:id/refresh-template', RECORDS],
  ['POST /api/rounds/reference-audio/import/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/rounds/reference-audio/transcribe-midi/:jobId/cancel', REDUCES_EXECUTION],
  // /api/runs
  ['DELETE /api/runs', REMOVES_RECORD],
  ['DELETE /api/runs/:id', REMOVES_RECORD],
  ['POST /api/runs/:id/stop', REDUCES_EXECUTION],
  // /api/screenshots
  ['POST /api/screenshots', RECORDS],
  // /api/settings
  ['PUT /api/settings/ai-assignments/:id', HANDLER_GATED],
  ['PUT /api/settings/credentials/:id', CONNECTOR_CREDENTIAL],
  ['PUT /api/settings/features/:featureId', FEATURE_TOGGLE],
  ['POST /api/settings/features/eidoverse/host', LOCAL_BRIDGE],
  ['PUT /api/settings/features/groups/:groupId', FEATURE_TOGGLE],
  ['POST /api/settings/orchestration-profiles', RECORDS],
  ['DELETE /api/settings/orchestration-profiles/:id', REMOVES_RECORD],
  ['PUT /api/settings/orchestration-profiles/:id', RECORDS],
  // /api/sharing
  ['DELETE /api/sharing/buckets/:id', REMOVES_RECORD],
  ['PUT /api/sharing/buckets/:id', RECORDS],
  ['POST /api/sharing/buckets/:id/export', RECORDS],
  ['POST /api/sharing/buckets/:id/inbox/:manifestId/dismiss', REMOVES_RECORD],
  ['POST /api/sharing/buckets/:id/inbox/:manifestId/promote', RECORDS],
  ['POST /api/sharing/subscriptions', RECORDS],
  ['DELETE /api/sharing/subscriptions/:id', REMOVES_RECORD],
  // /api/spotify
  ['POST /api/spotify/auth/clear', REMOVES_RECORD],
  ['POST /api/spotify/auth/credentials', CONNECTOR_CREDENTIAL],
  ['POST /api/spotify/playlists/sync', EXTERNAL_SYNC],
  ['POST /api/spotify/sync', EXTERNAL_SYNC],
  // /api/sprites
  ['POST /api/sprites', RECORDS],
  ['DELETE /api/sprites/:id', REMOVES_RECORD],
  ['PATCH /api/sprites/:id', RECORDS],
  ['DELETE /api/sprites/:id/assets', REMOVES_RECORD],
  ['POST /api/sprites/:id/atlas/compile', IN_PROCESS_MEDIA],
  ['POST /api/sprites/:id/reference/lock', IN_PROCESS_MEDIA],
  ['POST /api/sprites/:id/reference/main/unlock', RECORDS],
  ['POST /api/sprites/:id/reference/turnaround/unlock', RECORDS],
  ['POST /api/sprites/:id/reference/unlock', RECORDS],
  ['POST /api/sprites/:id/tracks/:trackId/approve', RECORDS],
  ['POST /api/sprites/:id/tracks/:trackId/reopen', RECORDS],
  ['POST /api/sprites/:id/walk/approve', RECORDS],
  ['POST /api/sprites/:id/walk/reopen', RECORDS],
  ['PUT /api/sprites/:id/walk/target', RECORDS],
  ['POST /api/sprites/:id/walk/unlock', RECORDS],
  ['POST /api/sprites/animation-tracks', RECORDS],
  ['DELETE /api/sprites/animation-tracks/:trackId', REMOVES_RECORD],
  ['PUT /api/sprites/animation-tracks/:trackId', RECORDS],
  // /api/stacker-news
  ['POST /api/stacker-news/accounts', HANDLER_GATED],
  ['DELETE /api/stacker-news/accounts/:id', REMOVES_RECORD],
  ['PATCH /api/stacker-news/accounts/:id', HANDLER_GATED],
  ['POST /api/stacker-news/actions', RECORDS],
  ['POST /api/stacker-news/analyses/:id/feedback', RECORDS],
  ['POST /api/stacker-news/items', RECORDS],
  ['POST /api/stacker-news/items/:id/analyze', TOOL_FREE_INFERENCE],
  ['POST /api/stacker-news/territories', HANDLER_GATED],
  ['DELETE /api/stacker-news/territories/:id', REMOVES_RECORD],
  ['PATCH /api/stacker-news/territories/:id', HANDLER_GATED],
  // /api/standardize
  ['POST /api/standardize/analyze', READ_ONLY_EXTERNAL],
  // /api/story-builder
  ['POST /api/story-builder', RECORDS],
  ['DELETE /api/story-builder/:id', REMOVES_RECORD],
  ['PATCH /api/story-builder/:id', RECORDS],
  ['POST /api/story-builder/:id/current-step/:stepId', RECORDS],
  ['POST /api/story-builder/:id/issues/:issueId/lock', RECORDS],
  ['POST /api/story-builder/:id/reconcile', RECORDS],
  ['POST /api/story-builder/:id/steps/:stepId/lock', RECORDS],
  ['POST /api/story-builder/:id/steps/:stepId/unlock', RECORDS],
  ['POST /api/story-builder/:id/sync', RECORDS],
  // /api/storyboards
  ['POST /api/storyboards', RECORDS],
  ['DELETE /api/storyboards/:id', REMOVES_RECORD],
  ['PATCH /api/storyboards/:id', RECORDS],
  ['POST /api/storyboards/:id/beats', RECORDS],
  ['DELETE /api/storyboards/:id/beats/:beatId', REMOVES_RECORD],
  ['PATCH /api/storyboards/:id/beats/:beatId', RECORDS],
  ['POST /api/storyboards/:id/beats/:beatId/move', RECORDS],
  ['POST /api/storyboards/:id/beats/:beatId/panels', RECORDS],
  ['POST /api/storyboards/:id/beats/add', RECORDS],
  ['DELETE /api/storyboards/:id/panels/:panelId', REMOVES_RECORD],
  ['PATCH /api/storyboards/:id/panels/:panelId', RECORDS],
  ['PATCH /api/storyboards/:id/panels/:panelId/make/:nodeId', RECORDS],
  ['POST /api/storyboards/:id/panels/:panelId/move', RECORDS],
  ['POST /api/storyboards/:id/panels/:panelId/scene-art', RECORDS],
  ['POST /api/storyboards/:id/panels/:panelId/takes', RECORDS],
  ['DELETE /api/storyboards/:id/panels/:panelId/takes/:takeId', REMOVES_RECORD],
  ['POST /api/storyboards/:id/panels/:panelId/takes/:takeId/select', RECORDS],
  ['PUT /api/storyboards/:id/recipe', RECORDS],
  ['POST /api/storyboards/:id/video', RECORDS],
  ['POST /api/storyboards/fit-music-video/:projectId', RECORDS],
  ['POST /api/storyboards/group-by-song/:projectId', RECORDS],
  ['POST /api/storyboards/sync-music-video/:projectId', RECORDS],
  ['PUT /api/storyboards/sync-music-video/:projectId/auto', RECORDS],
  ['POST /api/storyboards/from-fableloom/:loomId/:episodeId', RECORDS],
  ['POST /api/storyboards/from-music-video/:projectId', RECORDS],
  ['POST /api/storyboards/from-pipeline/:issueId', RECORDS],
  ['POST /api/storyboards/music-video/:projectId/shots/:sceneId/panel-art', RECORDS],
  ['POST /api/storyboards/music-video/:projectId/shots/:sceneId/update-from-panel', RECORDS],
  ['POST /api/storyboards/pipeline/:issueId/update-from-board', RECORDS],
  ['POST /api/storyboards/recipes', RECORDS],
  ['DELETE /api/storyboards/recipes/:recipeId', REMOVES_RECORD],
  // /api/sync
  ['POST /api/sync/tombstones/sweep', REMOVES_RECORD],
  // /api/system
  ['PUT /api/system/health/thresholds', RECORDS],
  ['DELETE /api/system/health/warnings/:type/dismiss', REMOVES_RECORD],
  ['POST /api/system/health/warnings/:type/dismiss', RECORDS],
  // /api/system-resources
  ['POST /api/system-resources/duplicates/rectify', MODEL_DATA],
  ['POST /api/system-resources/report', READ_ONLY_PROBE],
  // /api/threejs-models
  ['DELETE /api/threejs-models/:id', REMOVES_RECORD],
  // /api/timeline
  ['DELETE /api/timeline/events', REMOVES_RECORD],
  ['POST /api/timeline/import/browser', RECORDS],
  ['POST /api/timeline/import/discord', RECORDS],
  ['POST /api/timeline/import/spotify', RECORDS],
  ['POST /api/timeline/import/takeout-location', RECORDS],
  ['POST /api/timeline/import/whatsapp', RECORDS],
  ['POST /api/timeline/import/youtube', RECORDS],
  // /api/tools
  ['DELETE /api/tools/:id', REMOVES_RECORD],
  // /api/tracks
  ['POST /api/tracks', RECORDS],
  ['DELETE /api/tracks/:id', REMOVES_RECORD],
  ['PATCH /api/tracks/:id', RECORDS],
  ['DELETE /api/tracks/:id/audio', REMOVES_RECORD],
  ['POST /api/tracks/:id/audio/attach', RECORDS],
  ['POST /api/tracks/:id/chiptune/render', FIXED_ENCODE],
  ['DELETE /api/tracks/:id/renders/:renderId', REMOVES_RECORD],
  ['POST /api/tracks/:id/renders/:renderId/select', RECORDS],
  ['POST /api/tracks/:id/waveform/render', FIXED_ENCODE],
  ['POST /api/tracks/import/:jobId/cancel', REDUCES_EXECUTION],
  // /api/tribe
  ['DELETE /api/tribe/beeper/identities/:identityId', REMOVES_RECORD],
  ['DELETE /api/tribe/beeper/link', REMOVES_RECORD],
  ['POST /api/tribe/beeper/link', RECORDS],
  ['POST /api/tribe/beeper/link-new', RECORDS],
  ['POST /api/tribe/outreach/draft', TOOL_FREE_INFERENCE],
  ['POST /api/tribe/people', RECORDS],
  ['DELETE /api/tribe/people/:id', REMOVES_RECORD],
  ['PUT /api/tribe/people/:id', RECORDS],
  ['POST /api/tribe/people/:id/memories', RECORDS],
  ['DELETE /api/tribe/people/:id/memories/:memoryId', REMOVES_RECORD],
  ['POST /api/tribe/people/:id/touchpoints', RECORDS],
  ['POST /api/tribe/people/:id/touchpoints/calendar', RECORDS],
  // /api/universe-builder
  ['POST /api/universe-builder', RECORDS],
  ['DELETE /api/universe-builder/:id', REMOVES_RECORD],
  ['PATCH /api/universe-builder/:id', RECORDS],
  ['POST /api/universe-builder/:id/adopt-style', RECORDS],
  ['DELETE /api/universe-builder/:id/canon/:kind/:entryId', REMOVES_RECORD],
  ['DELETE /api/universe-builder/:id/canon/:kind/:entryId/image-refs/:filename', REMOVES_RECORD],
  ['POST /api/universe-builder/:id/canon/:kind/:entryId/apply-image-correction', RECORDS],
  ['PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock', RECORDS],
  ['PATCH /api/universe-builder/:id/canon/:kind/lock-all', RECORDS],
  ['POST /api/universe-builder/:id/canon/backfill-descriptions', RECORDS],
  ['POST /api/universe-builder/:id/characters/:entryId/augment/apply', RECORDS],
  ['DELETE /api/universe-builder/:id/characters/:entryId/reference-sheet', REMOVES_RECORD],
  ['POST /api/universe-builder/:id/characters/:entryId/reference-sheet/preview', READ_OVER_POST],
  ['POST /api/universe-builder/:id/import/markdown', RECORDS],
  ['POST /api/universe-builder/:id/restore-starter', 'Replaces record text with bundled defaults only; no agent, process or filesystem operation.'],
  ['POST /api/universe-builder/:id/style-references', RECORDS],
  ['DELETE /api/universe-builder/:id/style-references/:referenceId', REMOVES_RECORD],
  ['PATCH /api/universe-builder/:id/variations/lock-all', RECORDS],
  ['POST /api/universe-builder/merge', RECORDS],
  ['POST /api/universe-builder/merge/preview', READ_OVER_POST],
  // /api/update
  ['POST /api/update/check', READ_ONLY_EXTERNAL],
  ['DELETE /api/update/ignore', REMOVES_RECORD],
  ['POST /api/update/ignore', RECORDS],
  // /api/uploads
  ['DELETE /api/uploads', REMOVES_RECORD],
  ['POST /api/uploads', RECORDS],
  ['DELETE /api/uploads/:filename', REMOVES_RECORD],
  // /api/usage
  ['DELETE /api/usage', REMOVES_RECORD],
  ['POST /api/usage/backfill', IN_PROCESS_COMPUTE],
  ['PUT /api/usage/fleet-billing', RECORDS],
  ['POST /api/usage/messages', CLIENT_TELEMETRY],
  ['POST /api/usage/session', CLIENT_TELEMETRY],
  ['PUT /api/usage/subscriptions', RECORDS],
  ['POST /api/usage/tokens', CLIENT_TELEMETRY],
  // /api/video-gen
  ['POST /api/video-gen/cancel', REDUCES_EXECUTION],
  ['DELETE /api/video-gen/history/:id', REMOVES_RECORD],
  ['POST /api/video-gen/history/:id/cancel-delete', REDUCES_EXECUTION],
  ['PATCH /api/video-gen/history/:id/prompt', RECORDS],
  ['POST /api/video-gen/history/:id/visibility', RECORDS],
  ['POST /api/video-gen/ic-loras/:mode/download', MODEL_DATA],
  ['POST /api/video-gen/ic-loras/:mode/repair', MODEL_DATA],
  ['POST /api/video-gen/model-terms', RECORDS],
  ['POST /api/video-gen/models/:modelId/download', MODEL_DATA],
  ['POST /api/video-gen/models/:modelId/repair', MODEL_DATA],
  ['POST /api/video-gen/models/verify', MODEL_DATA],
  ['POST /api/video-gen/prompt-preview', READ_OVER_POST],
  ['POST /api/video-gen/text-encoder/download', MODEL_DATA],
  ['POST /api/video-gen/text-encoder/repair', MODEL_DATA],
  ['POST /api/video-gen/text-encoders/:id/download', MODEL_DATA],
  ['POST /api/video-gen/text-encoders/:id/repair', MODEL_DATA],
  // /api/video-timeline
  ['POST /api/video-timeline/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/video-timeline/projects', RECORDS],
  ['DELETE /api/video-timeline/projects/:id', REMOVES_RECORD],
  ['PATCH /api/video-timeline/projects/:id', RECORDS],
  // /api/voice
  ['PUT /api/voice/config', HANDLER_GATED],
  ['DELETE /api/voice/profiles/:id', REMOVES_RECORD],
  ['POST /api/voice/profiles/:id/assign', RECORDS],
  ['POST /api/voice/profiles/:id/benchmark', LOCAL_TTS],
  ['POST /api/voice/profiles/:id/benchmark-interactive', LOCAL_TTS],
  ['POST /api/voice/profiles/:id/benchmark-interactive/complete', RECORDS],
  ['POST /api/voice/profiles/:id/fine-tune/:jobId/cancel', REDUCES_EXECUTION],
  ['POST /api/voice/profiles/:id/fine-tune/:jobId/promote', RECORDS],
  ['POST /api/voice/profiles/:id/promote', RECORDS],
  ['POST /api/voice/profiles/clone', RECORDS],
  ['POST /api/voice/profiles/design', RECORDS],
  ['POST /api/voice/profiles/preset', RECORDS],
  ['POST /api/voice/qwen3/download-model', MODEL_DATA],
  ['POST /api/voice/speak', LOCAL_TTS],
  ['POST /api/voice/studio/design', LOCAL_TTS],
  ['POST /api/voice/studio/unload', REDUCES_EXECUTION],
  ['POST /api/voice/test', LOCAL_TTS],
  ['POST /api/voice/tts/unload', REDUCES_EXECUTION],
  // /api/voice/public
  ['POST /api/voice/public/synthesize', EXPOSED_API],
  // /api/workspace-contexts
  ['DELETE /api/workspace-contexts/:appId', REMOVES_RECORD],
  ['POST /api/workspace-contexts/:appId/restore', READ_ONLY_EXTERNAL],
  ['POST /api/workspace-contexts/:appId/save', READ_ONLY_EXTERNAL],
  // /api/writers-room
  ['POST /api/writers-room/exercises', RECORDS],
  ['POST /api/writers-room/exercises/:id/discard', RECORDS],
  ['POST /api/writers-room/exercises/:id/finish', RECORDS],
  ['POST /api/writers-room/exercises/:id/promote', RECORDS],
  ['POST /api/writers-room/folders', RECORDS],
  ['DELETE /api/writers-room/folders/:id', REMOVES_RECORD],
  ['POST /api/writers-room/works', RECORDS],
  ['DELETE /api/writers-room/works/:id', REMOVES_RECORD],
  ['PATCH /api/writers-room/works/:id', RECORDS],
  ['POST /api/writers-room/works/:id/analysis/:analysisId/scene-image', RECORDS],
  ['POST /api/writers-room/works/:id/characters', RECORDS],
  ['DELETE /api/writers-room/works/:id/characters/:characterId', REMOVES_RECORD],
  ['PATCH /api/writers-room/works/:id/characters/:characterId', RECORDS],
  ['POST /api/writers-room/works/:id/characters/:characterId/augment/apply', RECORDS],
  ['PUT /api/writers-room/works/:id/draft', RECORDS],
  ['POST /api/writers-room/works/:id/live-render-preview', RECORDS],
  ['POST /api/writers-room/works/:id/objects', RECORDS],
  ['DELETE /api/writers-room/works/:id/objects/:objectId', REMOVES_RECORD],
  ['PATCH /api/writers-room/works/:id/objects/:objectId', RECORDS],
  ['POST /api/writers-room/works/:id/places', RECORDS],
  ['DELETE /api/writers-room/works/:id/places/:placeId', REMOVES_RECORD],
  ['PATCH /api/writers-room/works/:id/places/:placeId', RECORDS],
  ['POST /api/writers-room/works/:id/polish/cancel', REDUCES_EXECUTION],
  ['POST /api/writers-room/works/:id/polish/revert', RECORDS],
  ['POST /api/writers-room/works/:id/promote-to-pipeline', RECORDS],
  ['POST /api/writers-room/works/:id/versions', RECORDS],
  ['PATCH /api/writers-room/works/:id/versions/:draftId', RECORDS],
  // /api/x
  ['POST /api/x/accounts', RECORDS],
  ['DELETE /api/x/accounts/:id', REMOVES_RECORD],
  ['PATCH /api/x/accounts/:id', RECORDS],
  ['POST /api/x/drafts', RECORDS],
  // /sdapi/v1
  ['POST /sdapi/v1/options', READ_OVER_POST],
  ['POST /sdapi/v1/txt2img', HANDLER_GATED],
];

const routeKey = ({ method, path }) => `${method} ${path}`;
const isGated = (method, path) => hostControlRouteFor(method, path) !== null || hostControlBodyRouteFor(method, path) !== null;

/** The classification problems of `routes` (scanRouteGraph rows) against reviewed-open `entries`. */
const classify = (routes, entries) => {
  const mutations = new Set(routes.filter((route) => MUTATING_METHODS.has(route.method)).map(routeKey));
  const seen = new Set();
  const duplicated = [];
  for (const [key] of entries) {
    if (seen.has(key)) duplicated.push(key);
    seen.add(key);
  }
  const alsoGated = [...seen].filter((key) => isGated(...key.split(' ')));
  return {
    unclassified: [...mutations].filter((key) => !seen.has(key) && !isGated(...key.split(' '))),
    stale: [...seen].filter((key) => !mutations.has(key) && !alsoGated.includes(key)),
    alsoGated,
    duplicated,
  };
};

const RULES = 'Classify each route by the family notes in the header of server/lib/hostControlRoutes.js: '
  + 'gate it in HOST_CONTROL_ROUTES, or list it in REVIEWED_OPEN_MUTATIONS (server/hostControlCoverage.test.js) with a reason.';

describe('host-control coverage of mounted mutating routes (#12952)', () => {
  const { routes } = scanRouteGraph();

  it('classifies every mounted mutation exactly once, with no stale or gated entries', () => {
    const problems = classify(routes, REVIEWED_OPEN_MUTATIONS);
    expect(problems.unclassified, `Unclassified mutating routes. ${RULES}`).toEqual([]);
    expect(problems.stale, 'Reviewed-open entries that no mounted route matches; delete them.').toEqual([]);
    expect(problems.alsoGated, 'Reviewed-open entries that are also gated; delete them from REVIEWED_OPEN_MUTATIONS.').toEqual([]);
    expect(problems.duplicated, 'Reviewed-open entries listed twice.').toEqual([]);
  });

  it('gives every reviewed-open entry a reason', () => {
    expect(REVIEWED_OPEN_MUTATIONS.filter(([, reason]) => typeof reason !== 'string' || !reason.trim())).toEqual([]);
  });

  it('fails on a new unclassified mutation, a stale entry, a gated entry and a double listing', () => {
    const problems = classify(
      [...routes, { method: 'POST', path: '/api/example-feature/:id/run' }, { method: 'GET', path: '/api/example-feature' }],
      [
        ...REVIEWED_OPEN_MUTATIONS,
        ['DELETE /api/example-retired/:id', REMOVES_RECORD],
        ['POST /api/apps/:id/start', RECORDS],
        REVIEWED_OPEN_MUTATIONS[0],
      ],
    );
    expect(problems).toEqual({
      unclassified: ['POST /api/example-feature/:id/run'],
      stale: ['DELETE /api/example-retired/:id'],
      alsoGated: ['POST /api/apps/:id/start'],
      duplicated: [REVIEWED_OPEN_MUTATIONS[0][0]],
    });
  });

  it('counts body-gated routes as covered', () => {
    expect(routes.some(({ method, path }) => method === 'PUT' && path === '/api/settings')).toBe(true);
    expect(classify([{ method: 'PUT', path: '/api/settings' }], []).unclassified).toEqual([]);
  });
});

// --- GET routes that reach host-process work (#13097) ---

// Site reasons: one reviewed binding, which ends the trace for every GET.
const HOST_QUERY = 'Runs one fixed read-only host query (sysctl, nvidia-smi, vm_stat, ps or a process listing, lsof/netstat, du/find, `which`, `defaults read`, an is-running AppleScript, `tailscale status`, `ffmpeg -filters`, `-encoders` or `-list_devices`); the caller chooses no command, argument or path, and host state does not change.';
const VERSION_PROBE = 'Runs an installed tool or interpreter only to check it (`--version`, `brew list`, `--probe`, or a fixed `python -c` import or version script); the executable is PortOS-managed or comes from code or gated settings, and the check installs, starts and changes nothing.';
const ICLOUD_HEAL = 'Asks iCloud (`brctl download`) to download the evicted file PortOS is already reading; the caller names no path and nothing else runs.';
const GIT_PROBE = 'Runs a fixed read-only git or gh query (`rev-parse`, `remote get-url`, `status`, `gh api user` or `rate_limit`) and changes no repository or remote state.';
const KILLS_OWN_CHILD = 'Signals a child process PortOS itself started (its timeout or cancel path); starts nothing.';
const PM2_LIST = 'Reads `pm2 jlist` through a short-lived cache; starts, stops or changes no process.';
const STATIC_JSON = 'Loads the checked-in prompt-integrity JSON snapshot with `require`; the path is a constant, not a computed module.';
const CDP_VERSION = "Reads the managed browser's DevTools `/json/version` endpoint; opens, lists or steers no page.";

// 'path#binding', repo-relative, as the trace labels module-scope bindings.
const REVIEWED_PROCESS_SITES = [
  ['server/lib/buildIdentity.js#probe', GIT_PROBE],
  ['server/lib/bufferedSpawn.js#killProcessTree', KILLS_OWN_CHILD],
  ['server/lib/commandExists.js#commandExists', VERSION_PROBE],
  ['server/lib/cudaCapability.js#detectCudaComputeCapability', HOST_QUERY],
  ['server/lib/cudaCapability.js#detectCudaGpus', HOST_QUERY],
  ['server/lib/cudaCapability.js#detectCudaUtilization', HOST_QUERY],
  ['server/lib/cudaCapability.js#queryNvidiaSmi', HOST_QUERY],
  ['server/lib/detachedSpawn.js#processMatches', HOST_QUERY],
  ['server/lib/detachedSpawn.js#queryWin32Command', HOST_QUERY],
  ['server/lib/detachedSpawn.js#snapshotProcesses', HOST_QUERY],
  ['server/lib/ffmpeg.js#probeEncoderCapability', HOST_QUERY],
  ['server/lib/ffmpeg.js#supportsSetparamsFilter', HOST_QUERY],
  ['server/lib/fileCore.js#dirSize', HOST_QUERY],
  ['server/lib/fullDiskAccess.js#defaultReadProcess', HOST_QUERY],
  ['server/lib/gitRemote.js#readRemoteUrl', GIT_PROBE],
  ['server/lib/icloudFile.js#materializeAndWait', ICLOUD_HEAL],
  ['server/lib/icloudFile.js#requestMaterialization', ICLOUD_HEAL],
  ['server/lib/memoryStats.js#macMemory', HOST_QUERY],
  ['server/lib/platform.js#getListeningPorts', HOST_QUERY],
  ['server/lib/platform.js#probeArm64Hardware', HOST_QUERY],
  ['server/lib/processEnv.js#whichFirst', HOST_QUERY],
  ['server/lib/processEnv.js#whichFirstSync', HOST_QUERY],
  ['server/lib/pythonSetup.js#isMuscriptorRuntimeReady', VERSION_PROBE],
  ['server/lib/pythonSetup.js#probeFlux2Venv', VERSION_PROBE],
  ['server/lib/pythonSetup.js#probePythonArch', VERSION_PROBE],
  ['server/lib/pythonSetup.js#probePythonHealth', VERSION_PROBE],
  ['server/lib/tailscale.js#readTailscaleStatus', HOST_QUERY],
  ['server/services/agentManagement.js#getAgentProcessStats', HOST_QUERY],
  ['server/services/agents.js#getProcessInfo', HOST_QUERY],
  ['server/services/agents.js#readUnixSnapshot', HOST_QUERY],
  ['server/services/agents.js#readWindowsSnapshot', HOST_QUERY],
  ['server/services/browserService.js#getCdpVersion', CDP_VERSION],
  ['server/services/dataManager.js#getDirSizeAndCount', HOST_QUERY],
  ['server/services/git.js#isRepo', GIT_PROBE],
  ['server/services/github.js#getGitHubAuthStatus', GIT_PROBE],
  ['server/services/github.js#probeGh', GIT_PROBE],
  ['server/services/imageGen/mossRuntime.js#probeMossBinary', VERSION_PROBE],
  ['server/services/itermAuth.js#isItermRunning', HOST_QUERY],
  ['server/services/itermAuth.js#readApiServerEnabled', HOST_QUERY],
  ['server/services/jev.js#isBasePythonSupported', VERSION_PROBE],
  ['server/services/llamaServerManager.js#readLlamaServerVersion', VERSION_PROBE],
  ['server/services/mediaService.js#listDevices', HOST_QUERY],
  ['server/services/modelAbuseGuard.js#isBasePythonSupported', VERSION_PROBE],
  ['server/services/pipeline/musicGen.js#isEngineHealthy', VERSION_PROBE],
  ['server/services/pm2.js#fetchJlist', PM2_LIST],
  ['server/services/rigging/runtime.js#probeBlenderModule', VERSION_PROBE],
  ['server/services/taskPromptDefaults/integrityHash.js#readPromptIntegritySnapshot', STATIC_JSON],
  ['server/services/videoGen/runtimes.js#isByovRuntimeCurrent', VERSION_PROBE],
  ['server/services/videoGen/runtimes.js#isByovRuntimeReady', VERSION_PROBE],
  ['server/services/videoGen/runtimes.js#probeRuntimeFingerprint', VERSION_PROBE],
  ['server/services/videoGen/runtimes.js#resolveByovRuntimeLoraCapable', VERSION_PROBE],
  ['server/services/videoGen/runtimes.js#resolveA2vLoraStageCapable', 'Runs only the fixed LTX A2V seam probe in the installed venv: imports pipeline definitions and reads pinned checkout revision/status; loads no model, downloads nothing and accepts no request-supplied command or path.'],
  ['server/services/ytdlpUpdate.js#readYtDlpVersion', VERSION_PROBE],
];

// GET reasons.
const FORGE_READ = "Reads repository and forge state: read-only git (status, branch, log, ls-files, ls-remote) in a registered app checkout or PortOS's own, and gh/glab queries authenticated with the stored forge token; changes no repository or remote state beyond PortOS's own records.";
const PM2_READ = 'Reads PM2 process state or logs (`pm2 jlist`, `pm2 logs --nostream`) of a PortOS-managed process; starts, stops or reconfigures nothing.';
const RUNTIME_STATUS = "Reports an installed local runtime's state with fixed status, version and import probes and PM2 reads (Ollama, llama-server, MTPLX, SlotStream, JEV, LAYA, the abuse guard, Docker, SuperCollider, a TTS or image backend, the database); installs, starts and reconfigures nothing.";
const PROVIDER_STATUS = 'Reads installed provider CLIs and runtimes: `--version` and `models` probes of the configured commands, cached runtime readiness, and the Codex app-server account or model list; takes no caller prompt, command or provider choice, and the install and run functions in the runtime table run only from gated routes.';
const PROVIDER_USAGE = 'Reads quota and usage from the enabled provider CLIs on their fixed usage commands (`claude /usage`, a TUI usage screen, the Codex app-server account read), cached; takes no caller prompt or provider choice.';
const TOOLKIT_INJECTED = 'Toolkit factory route (lib/aiToolkit/routes and their PortOS wrappers): the handler reads provider, run, prompt or benchmark records through the injected service and starts no run.';
const TOOL_CATALOG = 'Lists a catalog whose entries carry executors (agent, voice and creative tools, MCP tool adapters, mind recipes); the handler returns metadata, and the executors run only through the gated tool dispatch.';
const JOB_TABLE = "Reads media-job queue state or a job record; the traced encoders and generators sit in the queue's runtime table and run only from the queue worker after a gated enqueue.";
const ACTIVE_WORK_READ = 'Reports in-flight work by reading the in-memory state of the runner, backup and media-job modules, loaded lazily, plus GPU telemetry; starts none of it.';
const STORED_MEDIA_PROBE = 'Runs ffprobe over media PortOS already stored (a generation history item) to read its stream facts; no decode or encode, and the caller supplies no path or argument.';
const MUSIC_VIDEO_PLAN_READ = "Plans the render to report shot, look or cleanup state; the plan's performance-take review decodes the song master with ffmpeg only for a caller with host control (`requestHasHostControl`, #13156), and anyone else gets the plan with that take unchecked.";
const MOLTBOOK_READ = 'Reads from the Moltbook API with the stored agent key; a response that demands verification is answered with the account\'s configured model and screened by the local abuse classifier, as on every Moltbook call.';
const PEER_PAYLOAD = 'Peer endpoint in PEER_API_SURFACE that builds its payload from stored records; the executors the trace reaches come from whole-module namespace imports of the stores it reads.';
const PEER_ADMIN_READ = 'Describes peer-administration state from stored grants and catalog reviews; the installer and execution adapters the trace reaches run only from the handler-gated execution and catalog-review writes.';
const SYNC_CATEGORY_TABLE = "Reads sync categories, checksums, a manifest or a snapshot; the trace follows the snapshot category table whole into its applyRemote handlers, whose tombstone apply trashes a peer-deleted video only when a pulled peer snapshot is applied, never from a GET.";
const PEER_RELAY_LISTENER = "Reads stored records through a whole-module instances.js import; the trace reaches probePeer and the socket relay's `peer:sync:event` listener, which trashes a video only when a delete frame from its paired owner arrives, never from this GET.";

// 'METHOD /path' as scanRouteGraph spells it, like REVIEWED_OPEN_MUTATIONS.
const REVIEWED_PROCESS_GETS = [
  ['GET /api/agent-context/manifest', TOOL_CATALOG],
  ['GET /api/agents/tools/feed', MOLTBOOK_READ],
  ['GET /api/agents/tools/post/:postId', MOLTBOOK_READ],
  ['GET /api/agents/tools/published', MOLTBOOK_READ],
  ['GET /api/agents/tools/rate-limits', MOLTBOOK_READ],
  ['GET /api/agents/tools/relevant-posts', MOLTBOOK_READ],
  ['GET /api/agents/tools/submolts', MOLTBOOK_READ],
  ['GET /api/apps', PEER_RELAY_LISTENER],
  ['GET /api/apps/:id', FORGE_READ],
  ['GET /api/apps/:id/issues', FORGE_READ],
  ['GET /api/apps/:id/lane-health', FORGE_READ],
  ['GET /api/apps/:id/logs', PM2_READ],
  ['GET /api/apps/:id/pull-requests', FORGE_READ],
  ['GET /api/apps/:id/quality-history', PEER_RELAY_LISTENER],
  ['GET /api/apps/:id/quality-schedule', FORGE_READ],
  ['GET /api/apps/:id/repository-sources', "Inspects a managed app's checkouts with read-only git and gh queries, and refreshes origin with `git fetch` when the last fetch is stale; a fetch updates only remote-tracking refs, and the caller chooses no repository, remote or command."],
  ['GET /api/apps/quality-federation', PEER_RELAY_LISTENER],
  ['GET /api/beeper/oauth/callback', 'OAuth redirect target: stores the credential Beeper returns and arms its ingestion socket to the fixed Beeper endpoint, as completing the connection the operator started requires.'],
  ['GET /api/browser', "Reads the managed browser's status, including its tab list over CDP; a caller without host control gets pages and downloads stripped (#12488)."],
  ['GET /api/browser/logs', PM2_READ],
  ['GET /api/capabilities', PROVIDER_STATUS],
  ['GET /api/code-animation/execution', 'Reports which containment mechanism the code-animation worker would use, from a fixed Docker or sandbox availability probe; runs no worker.'],
  ['GET /api/code-animation/generate/:id', JOB_TABLE],
  ['GET /api/code-review/reviewer-identities', FORGE_READ],
  ['GET /api/cos/actionable-insights', 'Runs the PM2 health sweep (it restarts errored processes) only for a caller with host control, like its gated twin POST /api/cos/health/check; anyone else reads the recorded snapshot. Leftover-branch detection runs read-only git and gh queries.'],
  ['GET /api/cos/mind/recipes', TOOL_CATALOG],
  ['GET /api/cos/mind/recipes/:recipeId', TOOL_CATALOG],
  ['GET /api/cos/mind/tools', TOOL_CATALOG],
  ['GET /api/cos/mind/visibility', 'Reads persistent-mind workspace preflights: read-only git status of each workspace and `--version` checks of the CLIs it would use; starts nothing.'],
  ['GET /api/cos/schedule', FORGE_READ],
  ['GET /api/cos/schedule/due', FORGE_READ],
  ['GET /api/cos/schedule/due/:appId', FORGE_READ],
  ['GET /api/cos/schedule/task/:taskType', FORGE_READ],
  ['GET /api/cos/tools', TOOL_CATALOG],
  ['GET /api/cos/upcoming', FORGE_READ],
  ['GET /api/cos/workflow', FORGE_READ],
  ['GET /api/creative-director/:id/execution', PROVIDER_STATUS],
  ['GET /api/creative-director/tools', TOOL_CATALOG],
  ['GET /api/database/status', 'Runs the fixed `scripts/db.sh status` report and Postgres size queries; changes no database or container.'],
  ['GET /api/devtools/video-download/yt-dlp', RUNTIME_STATUS],
  ['GET /api/digital-twin/gaps', 'Computes twin confidence locally: the handler calls calculateConfidence without a provider, so the provider branch the trace reaches never runs here.'],
  ['GET /api/docker-containment/status', RUNTIME_STATUS],
  ['GET /api/eidoverse/world/controllers', 'Lists Eidoverse controller definitions loaded with `import()` from the definitions directory PortOS ships; the caller names no module and no controller runs.'],
  ['GET /api/federation/media/v1/status', 'Reports which local media generators this install offers peers, from readiness probes and the media-job queue\'s in-memory state; the encoders in the queue\'s runtime table run only from its worker.'],
  ['GET /api/git/:appId', FORGE_READ],
  ['GET /api/git/submodules/status', FORGE_READ],
  ['GET /api/github/accounts/:id/status', FORGE_READ],
  ['GET /api/github/notifications/:accountId/:threadId/deployment', FORGE_READ],
  ['GET /api/harnesses', PROVIDER_STATUS],
  ['GET /api/html-composition/beats', 'Measures the beat grid of an existing Music-library track (the caller picks the track, never a path); the ffmpeg decode runs once per file modification time and every later read serves the cached grid (#13156).'],
  ['GET /api/image-gen/status', RUNTIME_STATUS],
  ['GET /api/image-to-3d/targets', 'Reports image-to-3D target install state with each adapter\'s fixed probes (Metal toolchain, module imports); the adapter table\'s install and generate functions run only from the gated install and generate routes.'],
  ['GET /api/image-to-3d/targets/:targetId/install', 'Reports image-to-3D target install state with each adapter\'s fixed probes (Metal toolchain, module imports); the adapter table\'s install and generate functions run only from the gated install and generate routes.'],
  ['GET /api/image-to-3d/trellis2/install', 'Reports image-to-3D target install state with each adapter\'s fixed probes (Metal toolchain, module imports); the adapter table\'s install and generate functions run only from the gated install and generate routes.'],
  ['GET /api/instances', SYNC_CATEGORY_TABLE],
  ['GET /api/instances/sync-status', SYNC_CATEGORY_TABLE],
  ['GET /api/iterm/status', 'Reports iTerm2 bridge availability from fixed probes (`defaults read`, an is-running AppleScript) and the bridge\'s current state; opens no API connection.'],
  ['GET /api/local-llm/assessments', RUNTIME_STATUS],
  ['GET /api/local-llm/capability-tests', RUNTIME_STATUS],
  ['GET /api/local-llm/jev/heads', 'Lists trained JEV heads and whether training runs; the trainer module is loaded whole, but only its in-memory running flag is read.'],
  ['GET /api/local-llm/jev/status', RUNTIME_STATUS],
  ['GET /api/local-llm/laya-mlx/status', RUNTIME_STATUS],
  ['GET /api/local-llm/llama-server/status', RUNTIME_STATUS],
  ['GET /api/local-llm/llama-server/update-status', RUNTIME_STATUS],
  ['GET /api/local-llm/mtplx/models/search', 'Searches the MTPLX model catalog with the installed CLI (`mtplx forge discover --json`), the caller\'s query passed as one argument with no shell; downloads nothing.'],
  ['GET /api/local-llm/mtplx/status', RUNTIME_STATUS],
  ['GET /api/local-llm/persistent-mind-setup', RUNTIME_STATUS],
  ['GET /api/local-llm/security-guard/status', RUNTIME_STATUS],
  ['GET /api/local-llm/slotstream/status', RUNTIME_STATUS],
  ['GET /api/local-llm/status', RUNTIME_STATUS],
  ['GET /api/logs/:processName', PM2_READ],
  ['GET /api/logs/app/:appId', PM2_READ],
  ['GET /api/managed-visitor-admin', 'Lists managed-app visitor credentials through the injected broker (services/managedVisitors.js); it issues and runs nothing.'],
  ['GET /api/managed-visitors/v1/capabilities', 'Reads a managed-app visitor\'s capabilities through the injected broker (services/managedVisitors.js), whose credentials work only for a local same-origin app; it runs nothing.'],
  ['GET /api/media-jobs', JOB_TABLE],
  ['GET /api/media-jobs/:id', JOB_TABLE],
  ['GET /api/media-jobs/holds', JOB_TABLE],
  ['GET /api/media-jobs/queue', JOB_TABLE],
  ['GET /api/models/performance/task-benchmark', TOOLKIT_INJECTED],
  ['GET /api/music-video', JOB_TABLE],
  ['GET /api/music-video/:id', JOB_TABLE],
  ['GET /api/music-video/:id/cast-and-sets/casting-changes', "Rebuilds the Cast & Sets image plan from stored records and the linked Casting records' media to compare reference images; the trace reaches the provider runner through the service's test-seam `deps` defaults, but this read calls only the catalog reads and queues or runs nothing."],
  ['GET /api/music-video/:id/film-looks', MUSIC_VIDEO_PLAN_READ],
  ['GET /api/music-video/:id/media-pool/library', 'Searches stored media for the pool; the trace reaches the local image backend whole through a namespace import, while the handler reads only its gallery records.'],
  ['GET /api/music-video/:id/media-pool/search', 'Searches stored media for the pool; the trace reaches the local image backend whole through a namespace import, while the handler reads only its gallery records.'],
  ['GET /api/music-video/:id/publish/drafts', 'Checks whether each publish draft the operator opened through the gated prepare route is still a tab in the managed browser (a CDP target lookup); opens, fills or submits nothing.'],
  ['GET /api/music-video/:id/render-cleanup', MUSIC_VIDEO_PLAN_READ],
  ['GET /api/music-video/:id/shot-renders', MUSIC_VIDEO_PLAN_READ],
  ['GET /api/music-video/:id/shot-renders/:name', 'Streams an already-rendered shot segment file by its content-hash name; the ffmpeg the trace reaches through the shot-segment module renders only from the gated shot-render routes (#13156).'],
  ['GET /api/music/supercollider/status', RUNTIME_STATUS],
  ['GET /api/palette/manifest', TOOL_CATALOG],
  ['GET /api/peer-administration/catalog-review', PEER_ADMIN_READ],
  ['GET /api/peer-administration/catalog-reviews', PEER_ADMIN_READ],
  ['GET /api/peer-administration/peers/:peerId', PEER_ADMIN_READ],
  ['GET /api/peer-sync/cos-tasks', PEER_PAYLOAD],
  ['GET /api/peer-sync/eidoverse-foundations', PEER_PAYLOAD],
  ['GET /api/peer-sync/library-manifest', PEER_PAYLOAD],
  ['GET /api/pipeline/tts/voices', 'Lists TTS voices from the configured engines\' catalogs; the synthesize functions in the engine table run only from the speak and synthesis routes.'],
  ['GET /api/prompts', TOOLKIT_INJECTED],
  ['GET /api/prompts/:stage', TOOLKIT_INJECTED],
  ['GET /api/prompts/variables', TOOLKIT_INJECTED],
  ['GET /api/prompts/variables/:key', TOOLKIT_INJECTED],
  ['GET /api/providers', PROVIDER_STATUS],
  ['GET /api/providers/:id', PROVIDER_STATUS],
  ['GET /api/providers/:id/status', TOOLKIT_INJECTED],
  ['GET /api/providers/active', PROVIDER_STATUS],
  ['GET /api/providers/catalog', PROVIDER_STATUS],
  ['GET /api/providers/codex/account', PROVIDER_STATUS],
  ['GET /api/providers/codex/models', PROVIDER_STATUS],
  ['GET /api/providers/comparison', TOOLKIT_INJECTED],
  ['GET /api/providers/composites/:id', PROVIDER_STATUS],
  ['GET /api/providers/fleet-host', PROVIDER_STATUS],
  ['GET /api/providers/fleet-host/usage', PEER_RELAY_LISTENER],
  ['GET /api/providers/harnesses', PROVIDER_STATUS],
  ['GET /api/providers/management/preview', TOOLKIT_INJECTED],
  ['GET /api/providers/model-pins', FORGE_READ],
  ['GET /api/providers/opencode/installation', PROVIDER_STATUS],
  ['GET /api/providers/readiness', PROVIDER_STATUS],
  ['GET /api/providers/runtimes', PROVIDER_STATUS],
  ['GET /api/providers/samples', PROVIDER_STATUS],
  ['GET /api/providers/status', TOOLKIT_INJECTED],
  ['GET /api/quota-burn', PROVIDER_USAGE],
  ['GET /api/remote-desktop/status', 'Reports whether a VNC server answers on the fixed loopback port; mints no session.'],
  ['GET /api/review/queue', 'Builds the review queue from stored records and read-only git and forge queries; the provider calls in the trace come from a local `identity` that shadows the identity-service namespace import, so the whole service is followed.'],
  ['GET /api/runs', TOOLKIT_INJECTED],
  ['GET /api/runs/:id', TOOLKIT_INJECTED],
  ['GET /api/runs/:id/output', TOOLKIT_INJECTED],
  ['GET /api/runs/:id/prompt', TOOLKIT_INJECTED],
  ['GET /api/settings/ai-assignments', FORGE_READ],
  ['GET /api/settings/media-share-candidates', 'Reports which local media generators this install offers peers, from readiness probes and the media-job queue\'s in-memory state; the encoders in the queue\'s runtime table run only from its worker.'],
  ['GET /api/sprites/:id/walk/runs/:runId/source-frames', 'Lists the raw frames already on disk for a walk run; the ffmpeg re-extraction the trace reaches runs only for `extract: true`, which only the gated POST .../source-frames/extract passes (#13156).'],
  ['GET /api/sync', SYNC_CATEGORY_TABLE],
  ['GET /api/sync/:category/checksum', SYNC_CATEGORY_TABLE],
  ['GET /api/sync/:category/manifest', SYNC_CATEGORY_TABLE],
  ['GET /api/sync/:category/snapshot', SYNC_CATEGORY_TABLE],
  ['GET /api/system/activity', ACTIVE_WORK_READ],
  ['GET /api/system/health/details', JOB_TABLE],
  ['GET /api/system/processing', ACTIVE_WORK_READ],
  ['GET /api/update/auto', ACTIVE_WORK_READ],
  ['GET /api/update/status', FORGE_READ],
  ['GET /api/usage', PROVIDER_USAGE],
  ['GET /api/usage/claude-code', PROVIDER_USAGE],
  ['GET /api/usage/providers', PROVIDER_USAGE],
  ['GET /api/video-gen/active', JOB_TABLE],
  ['GET /api/video-gen/history/:id', STORED_MEDIA_PROBE],
  ['GET /api/video-gen/upscale/:id/plan', STORED_MEDIA_PROBE],
  ['GET /api/voice/facetime/status', RUNTIME_STATUS],
  ['GET /api/voice/public/voices', 'Lists TTS voices from the configured engines\' catalogs; the synthesize functions in the engine table run only from the speak and synthesis routes.'],
  ['GET /api/voice/qwen3/status', RUNTIME_STATUS],
  ['GET /api/voice/status', RUNTIME_STATUS],
  ['GET /api/voice/voices', 'Lists TTS voices from the configured engines\' catalogs; the synthesize functions in the engine table run only from the speak and synthesis routes.'],
  ['GET /api/workspace-contexts/:appId', FORGE_READ],
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Classification problems of the GET `routes` (scanRouteGraph rows) traced with `routeSinks` against `entries`. */
const classifyProcessGets = (routes, entries, routeSinks) => {
  const reaching = new Set(routes
    .filter((route) => route.method === 'GET' && route.declarations.some((declaration) => routeSinks(declaration).length))
    .map(routeKey));
  const seen = new Set();
  const duplicated = [];
  for (const [key] of entries) {
    if (seen.has(key)) duplicated.push(key);
    seen.add(key);
  }
  const alsoGated = [...seen].filter((key) => isGated(...key.split(' ')));
  return {
    unclassified: [...reaching].filter((key) => !seen.has(key) && !isGated(...key.split(' '))),
    stale: [...seen].filter((key) => !reaching.has(key) && !alsoGated.includes(key)),
    alsoGated,
    duplicated,
  };
};

const GET_RULES = 'Gate the GET in HOST_CONTROL_ROUTES (server/lib/hostControlRoutes.js), or list it in REVIEWED_PROCESS_GETS '
  + '(server/hostControlCoverage.test.js) with what it actually runs. A fixed read-only probe many GETs share belongs in REVIEWED_PROCESS_SITES instead.';

describe('host-control coverage of GET routes that reach host processes (#13097)', () => {
  const { routes } = scanRouteGraph();
  const tracer = createProcessReachTracer({ repoRoot: REPO_ROOT, reviewedSites: REVIEWED_PROCESS_SITES.map(([site]) => site) });

  it('classifies every GET whose handler reaches host-process work, with no stale, gated or doubled entries', () => {
    const problems = classifyProcessGets(routes, REVIEWED_PROCESS_GETS, tracer.routeSinks);
    const evidence = problems.unclassified.map((key) => {
      const route = routes.find((candidate) => routeKey(candidate) === key);
      const declaration = route.declarations.find((candidate) => tracer.routeSinks(candidate).length);
      return `${key}\n    ${tracer.explainRoute(declaration).chain.join('\n    > ')}`;
    });
    expect(evidence, `GET routes that reach host-process work. ${GET_RULES}`).toEqual([]);
    expect(problems.stale, 'Reviewed GET entries whose route is gone or no longer reaches host-process work; delete them.').toEqual([]);
    expect(problems.alsoGated, 'Reviewed GET entries that are also gated; delete them from REVIEWED_PROCESS_GETS.').toEqual([]);
    expect(problems.duplicated, 'Reviewed GET entries listed twice.').toEqual([]);
  }, 120_000);

  it('keeps every reviewed site a live binding that still reaches host-process work', () => {
    const dead = REVIEWED_PROCESS_SITES
      .filter(([site]) => !tracer.traceSite(site)?.sinks.length)
      .map(([site]) => site);
    expect(dead, 'Reviewed sites that no longer exist or no longer reach a sink; delete them.').toEqual([]);
    const sites = REVIEWED_PROCESS_SITES.map(([site]) => site);
    expect(sites.filter((site, index) => sites.indexOf(site) !== index), 'Reviewed sites listed twice.').toEqual([]);
  }, 120_000);

  it('gives every reviewed GET and site a reason', () => {
    expect([...REVIEWED_PROCESS_GETS, ...REVIEWED_PROCESS_SITES]
      .filter(([, reason]) => typeof reason !== 'string' || !reason.trim())).toEqual([]);
  });

  it('fails on a new process-spawning GET, through a lazy import, a barrel, a namespace and an injected dependency', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-process-gets-'));
    const write = (relative, text) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), text);
    };
    try {
      write('server/index.js', [
        "import exampleRoutes from './routes/example.js';",
        "import { createFactoryRoutes } from './routes/factory.js';",
        "app.use('/api/example', exampleRoutes);",
        "app.use('/api/factory', createFactoryRoutes(service));",
      ].join('\n'));
      write('server/routes/example.js', [
        "import { Router } from 'express';",
        "import { probe } from '../services/index.js';",
        "import * as tabs from '../services/tabs.js';",
        "import { readNotes } from '../services/notes.js';",
        "import { fixedProbe } from '../services/fixed.js';",
        'const router = Router();',
        "router.get('/lazy', async (req, res) => { const { encode } = await import('../services/encode.js'); res.json(await encode()); });",
        "router.get('/barrel', async (req, res) => res.json(await probe()));",
        "router.get('/namespace', async (req, res) => res.json(await tabs.open()));",
        "router.get('/notes', async (req, res) => res.json(await readNotes()));",
        "router.get('/reviewed', async (req, res) => res.json(await fixedProbe()));",
        'export default router;',
      ].join('\n'));
      write('server/routes/factory.js', [
        "import { Router } from 'express';",
        'export function createFactoryRoutes(service) {',
        '  const router = Router();',
        "  router.get('/', async (req, res) => res.json(await service.list()));",
        '  return router;',
        '}',
      ].join('\n'));
      write('server/services/encode.js', "import { spawn } from 'node:child_process';\nexport const encode = () => spawn('ffmpeg', ['-version']);\n");
      write('server/services/index.js', "export * from './notes.js';\nexport * from './probe.js';\n");
      write('server/services/probe.js', "import { execFile } from 'child_process';\nexport function probe() { return execFile('git', ['status']); }\n");
      write('server/services/tabs.js', "export const open = () => fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' });\n");
      write('server/services/notes.js', "import { readFile } from 'node:fs/promises';\nexport const readNotes = () => readFile('notes.json', 'utf8');\n");
      write('server/services/fixed.js', "import { execFileSync } from 'node:child_process';\nexport const fixedProbe = () => execFileSync('sysctl', ['-n', 'hw.ncpu']);\n");

      const fixture = scanRouteGraph({ repoRoot: root }).routes;
      const traced = createProcessReachTracer({ repoRoot: root, reviewedSites: ['server/services/fixed.js#fixedProbe'] });
      expect(classifyProcessGets(fixture, [], traced.routeSinks).unclassified.sort()).toEqual([
        'GET /api/example/barrel',
        'GET /api/example/lazy',
        'GET /api/example/namespace',
        'GET /api/factory',
      ]);
      expect(fixture.find((route) => route.path === '/api/example/namespace').declarations.flatMap(traced.routeSinks)).toEqual(['browser']);
      expect(fixture.find((route) => route.path === '/api/factory').declarations.flatMap(traced.routeSinks)).toEqual(['injected-dependency']);
      expect(traced.traceSite('server/services/fixed.js#fixedProbe').sinks).toEqual(['child_process']);
      expect(classifyProcessGets(fixture, [['GET /api/example/notes', 'Reads notes.']], traced.routeSinks).stale).toEqual(['GET /api/example/notes']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
