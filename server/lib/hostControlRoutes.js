/**
 * The audited list of HTTP routes that execute on the host (#8716).
 *
 * Each one needs operator authority — `requireHostControl` in
 * services/authGate.js, applied to every route here by `hostControlRouteGate`:
 * an operator session when a password is set, or a local connection when none
 * is. A peer credential (scoped token or legacy Basic) never qualifies, and a
 * remote LAN/tailnet caller on a password-free install is refused (#8226).
 * The socket twin is HOST_CONTROL_SOCKET_EVENTS in services/socket.js;
 * `/api/commands/*` mounts `requireHostControl` per route in routes/commands.js.
 *
 * A route belongs here when it runs a process, git, npm, gh or a CoS agent on
 * the host, or when it sets what one will run (a repo path, a start command, a
 * task prompt, a shell job). Read-only GETs stay open. Mutating routes in the
 * same families that are deliberately left OUT:
 *   - apps: delete/archive/unarchive, detect-icons, scope-adherence — they
 *     change only PortOS's own records or read files; nothing runs.
 *   - CoS: stop/pause/kill/terminate/delete and feedback — they reduce or
 *     annotate execution, never start it; task reorder/refresh/enhance,
 *     templates, challenge and goal-fidelity reports — records and LLM text
 *     only, and sub-agents call the latter from loopback anyway.
 *   - standardize/analyze — reads the repo; `apply` and `backup` are gated.
 *   - feature agents and loops: pause/stop/delete — they reduce execution.
 *   - code-review/cli-outcome — records a reviewer verdict; nothing runs.
 *   - providers (#8721): the gated writes choose the binary, its args, the
 *     endpoint and credentials a tool-running CLI harness talks to, or which
 *     harnesses and wrapper CLIs may run at all. Left open: DELETEs (a
 *     connection still in use is refused with a 409), fleet-host/stop and the
 *     Codex login cancel (they stop execution), the fleet key reveals (a read
 *     of a secret, not execution), binding create/edit/unlink (minted routes
 *     arrive disabled; unlink clones the endpoint the binding already had;
 *     link/preview only reads), the model-comparison import (records only),
 *     model pins/aliases, derive and status recovery (they choose among
 *     already-configured values), and test, vision, refresh-models and
 *     refresh-catalog (they run an already-configured provider on a fixed
 *     prompt, as every AI feature does).
 *   - pipeline and FableLoom: only autopilot start is gated — with gap filing
 *     or self-improvement on it queues CoS agents. Every other pipeline route
 *     generates text or media through an already-configured provider, the
 *     same as any AI feature; the caller never chooses what runs.
 *   - settings: feature toggles and the Eidoverse host bridge (they arm
 *     PortOS's own integrations or open a listener), orchestration profiles,
 *     AI assignments and credentials (they choose among configured providers
 *     or store a key). The `PUT /api/settings` and `PUT /api/cos/config`
 *     slices that change execution policy are gated per request body — see
 *     HOST_CONTROL_SETTINGS_SLICES and HOST_CONTROL_OPEN_COS_CONFIG_KEYS.
 *
 * Patterns are `METHOD /path`, with Express-style `:param` (one segment) and
 * `*name` (the rest of the path). Matching is case-insensitive and ignores one
 * trailing slash, exactly as Express routing does, so a request cannot reach a
 * listed handler by a spelling this list does not match.
 */

import { escapeRegExp } from './textUtils.js';

export const HOST_CONTROL_ROUTES = Object.freeze([
  // Apps: create/edit choose the repo path and the start/build commands; the
  // lifecycle and launch routes run them under PM2 or the native launcher.
  'POST /api/apps',
  'PUT /api/apps/:id',
  'POST /api/apps/:id/start',
  'POST /api/apps/:id/stop',
  'POST /api/apps/:id/restart',
  'POST /api/apps/:id/build',
  'POST /api/apps/:id/native-launch',
  'POST /api/apps/:id/refresh-config',
  'POST /api/apps/:id/open-editor',
  'POST /api/apps/:id/open-claude',
  'POST /api/apps/:id/open-folder',
  'POST /api/apps/:id/open-xcode',
  // Edits and commits inside the app's repo (git runs its hooks) or runs gh.
  'POST /api/apps/:id/upgrade-tls',
  'POST /api/apps/:id/fix-vite-hosts',
  'POST /api/apps/:id/xcode-scripts/install',
  'PUT /api/apps/:id/documents/*docPath',
  'POST /api/apps/:id/quality-snapshot',
  'POST /api/apps/:id/repository-sources/sync-fork',
  'POST /api/apps/:id/pull-requests/:number/resolve',
  'POST /api/apps/:id/pull-requests/:number/merge',
  'POST /api/apps/:id/pull-requests/:number/review',
  'POST /api/apps/:id/pull-requests/:number/do-review',
  // Enable or queue CoS agent work against an app.
  'POST /api/apps/:id/launch-videos',
  'POST /api/apps/:id/quality-schedule/apply',
  'PUT /api/apps/bulk-task-type/:taskType',
  'PUT /api/apps/:id/task-types/all',
  'PUT /api/apps/:id/task-types/:taskType',

  // CoS: queue, release or steer an agent that runs shell commands in a
  // worktree, or a job that runs a shell command directly.
  'POST /api/cos/start',
  'POST /api/cos/resume',
  'POST /api/cos/evaluate',
  'POST /api/cos/tasks',
  'PUT /api/cos/tasks/:id',
  'POST /api/cos/tasks/slashdo',
  'POST /api/cos/tasks/jira-ticket',
  'POST /api/cos/tasks/:id/approve',
  'POST /api/cos/tasks/:id/spawn',
  'POST /api/cos/agents/:id/resume',
  'POST /api/cos/agents/:id/relaunch',
  'POST /api/cos/agents/:id/btw',
  'POST /api/cos/jobs',
  'PUT /api/cos/jobs/:id',
  // Toggle arms an existing job, shell jobs included, for its next run.
  'POST /api/cos/jobs/:id/toggle',
  'POST /api/cos/jobs/:id/trigger',
  'PUT /api/cos/schedule/task/:taskType',
  'POST /api/cos/schedule/trigger',
  'POST /api/cos/schedule/maintenance-runs',
  'POST /api/cos/schedule/maintenance-runs/:id/resume',
  'POST /api/cos/tools/call',

  // Git in a caller-named directory. Every POST is gated, reads included: git
  // runs repository-configured programs (hooks, fsmonitor) even for `status`.
  'POST /api/git/*rest',

  // Scaffolding writes a new repo and runs git/npm in it.
  'POST /api/scaffold',
  'POST /api/scaffold/templates/create',

  // HTTP twins of the gated `app:standardize` / `standardize:start` events.
  'POST /api/standardize/apply',
  'POST /api/standardize/backup',

  // Feature agents and loops (#8721): create/edit set the prompt, working
  // directory and provider an agent runs with; the rest start one.
  'POST /api/feature-agents',
  'PUT /api/feature-agents/:id',
  'POST /api/feature-agents/:id/start',
  'POST /api/feature-agents/:id/resume',
  'POST /api/feature-agents/:id/trigger',
  'POST /api/loops',
  'PUT /api/loops/:id',
  'POST /api/loops/:id/resume',
  'POST /api/loops/:id/trigger',

  // GSD: queue CoS agent work against an app, or write into its repo.
  'POST /api/cos/gsd/projects/:appId/concerns/tasks',
  'POST /api/cos/gsd/projects/:appId/phases/:phaseId/action',
  'PUT /api/cos/gsd/projects/:appId/documents/:docName',

  // Runs the configured local or provider reviewer on a caller-supplied diff.
  'POST /api/code-review/local',

  // Providers: which binary runs, with which args, against which endpoint and
  // credentials; installing or launching runtimes; signing a CLI in or out.
  // `PUT /api/providers/:id` also matches `/active` and `/bootstraps`.
  'POST /api/providers',
  'PUT /api/providers/:id',
  'POST /api/providers/:id/modes/tui',
  'PATCH /api/providers/routes/:providerId',
  'POST /api/providers/connections',
  'PATCH /api/providers/connections/:id',
  'POST /api/providers/services',
  'PATCH /api/providers/services/:slug',
  'POST /api/providers/bindings/:id/link',
  'PUT /api/providers/harnesses/:id',
  'POST /api/providers/presets',
  'POST /api/providers/codex/account/login',
  'POST /api/providers/codex/account/logout',
  'POST /api/providers/readiness/setup',
  'POST /api/providers/readiness/serve-model',
  'POST /api/providers/runtimes/install',
  'POST /api/providers/opencode/install',
  'POST /api/providers/fleet-host/setup',

  // Autopilots and support requests that queue CoS agents.
  'POST /api/pipeline/series/:id/autopilot/start',
  'POST /api/fableloom/:id/editorial/autopilot/start',
  'POST /api/image-video/models/support-request',

  // Eidoverse: clone and install a caller-named repo, or repoint it.
  'POST /api/settings/features/eidoverse/install',
  'PUT /api/settings/features/eidoverse/source',
]);

/**
 * `PUT /api/settings` slices that set what runs or the guardrails around it:
 * harness enablement and wrapper CLIs, the code-review chain, the untrusted
 * content screen in front of agent work, scheduled self-update, and scheduled
 * series autopilots. The store is polymorphic, so its other slices stay open.
 */
export const HOST_CONTROL_SETTINGS_SLICES = Object.freeze([
  'autoUpdate',
  'codeReview',
  'credentialBootstraps',
  'harnesses',
  'seriesAutopilot',
  'untrustedContent',
]);

/**
 * The only `PUT /api/cos/config` keys a remote caller on a password-free
 * install may change. Nearly all of CoS config is execution policy (autonomy,
 * concurrency, MCP server commands, the Persistent Mind's capabilities), so
 * this list is the inverse: an unlisted key, including one added later, is
 * gated.
 */
export const HOST_CONTROL_OPEN_COS_CONFIG_KEYS = Object.freeze([
  'avatarStyle',
  'dynamicAvatar',
  'embeddingModel',
  'embeddingProviderId',
]);

const compileSegment = (segment) => {
  if (segment.startsWith(':')) return '[^/]+';
  if (segment.startsWith('*')) return '.+';
  return escapeRegExp(segment);
};

const compileRoute = (route) => {
  const [method, path] = route.split(' ');
  const body = path.split('/').slice(1).map(compileSegment).join('/');
  return { route, method, pattern: new RegExp(`^/${body}/?$`, 'i') };
};

const COMPILED_ROUTES = HOST_CONTROL_ROUTES.map(compileRoute);

const bodyKeys = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []);

// The two polymorphic policy stores, gated per body key rather than per route.
// `hostControlBodyGate` in services/authGate.js applies these after the body
// parser, since `hostControlRouteGate` runs before it.
const COMPILED_BODY_ROUTES = [
  ['PUT /api/settings', (body) => bodyKeys(body).filter((key) => HOST_CONTROL_SETTINGS_SLICES.includes(key))],
  ['PUT /api/cos/config', (body) => bodyKeys(body).filter((key) => !HOST_CONTROL_OPEN_COS_CONFIG_KEYS.includes(key))],
].map(([route, pick]) => ({ ...compileRoute(route), pick }));

/** The host-control keys a request body names, for `method path` of a policy store; [] elsewhere. */
export const hostControlBodyKeys = (method, path, body) => {
  if (typeof method !== 'string' || typeof path !== 'string') return [];
  const verb = method.toUpperCase();
  return COMPILED_BODY_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.pick(body) ?? [];
};

/** The HOST_CONTROL_ROUTES entry that `method path` (an Express `req.method` / `req.path`) matches, or null. */
export const hostControlRouteFor = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const verb = method.toUpperCase();
  return COMPILED_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.route ?? null;
};

/** Whether `method path` executes on the host. */
export const isHostControlRoute = (method, path) => hostControlRouteFor(method, path) !== null;
