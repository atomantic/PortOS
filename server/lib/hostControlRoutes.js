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
 *
 * Patterns are `METHOD /path`, with Express-style `:param` (one segment) and
 * `*name` (the rest of the path). Matching is case-insensitive and ignores one
 * trailing slash, exactly as Express routing does, so a request cannot reach a
 * listed handler by a spelling this list does not match.
 */

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
]);

const escapeRegExp = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

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

/** The HOST_CONTROL_ROUTES entry that `method path` (an Express `req.method` / `req.path`) matches, or null. */
export const hostControlRouteFor = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const verb = method.toUpperCase();
  return COMPILED_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.route ?? null;
};

/** Whether `method path` executes on the host. */
export const isHostControlRoute = (method, path) => hostControlRouteFor(method, path) !== null;
