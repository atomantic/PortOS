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
 *   - notes (#9007): vault add/repoint gated (chooses the host directory
 *     note CRUD reads/writes); note CRUD itself stays open.
 *   - browser: navigate uses the configured browser with its URL/IP guards;
 *     downloads DELETE removes data. Harness models/refresh re-reads the
 *     configured harness catalog; neither selects or installs an executable.
 *   - local-llm (#8798): install/delete/migrate and llama-server download-model
 *     (including cancel/remove), mtplx models/pull/remove and slotstream
 *     models/download (including cancel) manage model data, not executables.
 *     download-preflight only reads. switch selects a built-in backend and
 *     enables its existing fixed provider. unload and jev/unload release weights;
 *     security-guard/install/cancel and jev/install/cancel cancel work.
 *     laya-mlx/score, jev/score, test (including stream), compare,
 *     assessments/run/sweep (including sweep/cancel) and capability-tests/run
 *     except sandbox-repair use configured runtimes for inference; sandbox-repair
 *     runs a tool-enabled agent and is gated by testId after body parsing.
 *     assessments/delete and capability-tests/delete remove result records.
 *     In contrast, installers, explicit service lifecycle/startup persistence,
 *     persistent-mind setup, agent-benchmark and JEV policy/head mutations
 *     require operator authority. Head training reads git/forge history;
 *     adoption/discard changes the classifier admitting agent work.
 *   - settings: feature toggles and the Eidoverse host bridge (they arm
 *     PortOS's own integrations or open a listener), orchestration profiles,
 *     AI assignments and credentials (they choose among configured providers
 *     or store a key). The `PUT /api/settings` and `PUT /api/cos/config`
 *     slices that change execution policy are gated per request body — see
 *     HOST_CONTROL_SETTINGS_SLICES and HOST_CONTROL_OPEN_COS_CONFIG_KEYS —
 *     and so are the nested settings keys that pick an executable or disarm
 *     a shell guard (HOST_CONTROL_SETTINGS_PATHS), but only when the body
 *     CHANGES the stored value (#8751).
 *
 * Patterns are `METHOD /path`, with Express-style `:param` (one segment) and
 * `*name` (the rest of the path). Matching is case-insensitive and ignores one
 * trailing slash, exactly as Express routing does, so a request cannot reach a
 * listed handler by a spelling this list does not match.
 */

import { isPlainObject } from './objects.js';
import { escapeRegExp } from './textUtils.js';

export const HOST_CONTROL_ROUTES = Object.freeze([
  // Database cutover stops/restarts PortOS under PM2 and rewrites .env (#8851).
  'POST /api/database/maintenance/cutover',
  'POST /api/database/maintenance/recover',

  // Database admin routes: lifecycle, data integrity, and migration (#8897).
  'POST /api/database/start',
  'POST /api/database/stop',
  'POST /api/database/destroy',
  'POST /api/database/setup-native',
  'POST /api/database/export',
  'POST /api/database/sync',
  'POST /api/database/fix',
  'POST /api/database/switch',

  // Setting a password mints an operator session: bootstrap must be local,
  // and rotation must already hold operator authority (#8771).
  'POST /api/auth/password',

  // Generic runs accept arbitrary prompts/workspaces, including API-to-CLI fallback.
  'POST /api/runs',
  'POST /api/voice/studio/setup',

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
  'POST /api/apps/:id/launch-videos/publish',
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
  // A job skill template IS the prompt a scheduled job's agent runs (#8762).
  'PUT /api/prompts/skills/jobs/:name',
  'PUT /api/cos/schedule/task/:taskType',
  'POST /api/cos/schedule/trigger',
  'POST /api/cos/schedule/maintenance-runs',
  'POST /api/cos/schedule/maintenance-runs/:id/resume',
  'POST /api/cos/tools/call',

  // Git in a caller-named directory. Every POST is gated, reads included: git
  // runs repository-configured programs (hooks, fsmonitor) even for `status`.
  'POST /api/git/*rest',

  // Notes vaults: add/repoint chooses which host directory the note CRUD
  // routes read from and write into (#9007). Note CRUD itself stays open —
  // it is only safe once the root is operator-chosen.
  'POST /api/notes/vaults',
  'PUT /api/notes/vaults/:id',

  // Restores replace records and machine-local execution policy; previews
  // require the same operator authority as execution (#8772).
  'POST /api/backup/restore',
  'POST /api/backup/restore-db',

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

  // Browser executable/profile selection and process lifecycle; harness
  // install/update/uninstall; local-runtime installation, service lifecycle,
  // agent execution and execution-policy writes (#8798).
  'PUT /api/browser/config',
  'POST /api/browser/launch',
  'POST /api/browser/restart',
  'POST /api/browser/stop',
  'POST /api/harnesses/action',
  'POST /api/local-llm/laya-mlx/install',
  'POST /api/local-llm/security-guard/install',
  'POST /api/local-llm/jev/install',
  'POST /api/local-llm/jev/heads/train',
  'POST /api/local-llm/jev/heads/adopt',
  'POST /api/local-llm/jev/heads/discard',
  'POST /api/local-llm/install-backend',
  'POST /api/local-llm/upgrade-backend',
  'POST /api/local-llm/ollama-service',
  'POST /api/local-llm/lmstudio-service',
  'POST /api/local-llm/llama-server/install',
  'POST /api/local-llm/llama-server/upgrade',
  'POST /api/local-llm/llama-server/start',
  'POST /api/local-llm/llama-server/stop',
  'POST /api/local-llm/mtplx/install',
  'POST /api/local-llm/mtplx/start',
  'POST /api/local-llm/mtplx/stop',
  'POST /api/local-llm/slotstream/install',
  'POST /api/local-llm/slotstream/start',
  'POST /api/local-llm/slotstream/stop',
  'POST /api/local-llm/save-startup',
  'POST /api/local-llm/persistent-mind-setup/apply',
  'POST /api/local-llm/assessments/agent-benchmark',
  'PUT /api/local-llm/jev/policy',

  // Autopilots and support requests that queue CoS agents.
  'POST /api/pipeline/series/:id/autopilot/start',
  'POST /api/fableloom/:id/editorial/autopilot/start',
  'POST /api/image-video/models/support-request',

  // Eidoverse: clone and install a caller-named repo, or repoint it.
  'POST /api/settings/features/eidoverse/install',
  'PUT /api/settings/features/eidoverse/source',

  // Self-update (#8742): runs git + npm and restarts the process, or `gh repo
  // sync` against the fork. `check` and `ignore`/DELETE-`ignore` only read or
  // record a preference — left open.
  'POST /api/update/execute',
  'POST /api/update/sync-fork',

  // Brain links (#8742): git clone/pull in the linked repo, opening a host
  // app, or queuing a CoS malware-scan/repo-study agent. `links`/`buckets`
  // CRUD and `scan-report` only read or record; nothing runs.
  'POST /api/brain/links/:id/clone',
  'POST /api/brain/links/:id/pull',
  'POST /api/brain/links/:id/open-folder',
  'POST /api/brain/links/:id/scan',
  'POST /api/brain/links/:id/study',

  // Brain YouTube ingest (#8742): a non-empty `agentPrompt` queues a CoS task
  // against the transcript once ingest finishes.
  'POST /api/brain/youtube/ingest',

  // Ask (#8742): promoting a turn into a Brain note/CoS task/Goal entry can
  // queue a CoS task (`target: 'task'`). The conversation-level `/promote`
  // only flips a 30-day-expiry exemption flag — left open.
  'POST /api/ask/:id/turns/:turnId/promote',

  // Reference repos (#8742): a check that finds new commits queues a CoS
  // analysis agent against them. `reviewed` only advances a recorded SHA.
  'POST /api/apps/:appId/reference-repos/:refId/check',

  // Persistent Mind lifecycle (#8742): starting/waking/resuming the mind arms
  // its own agentic loop, which can queue CoS tasks on its own initiative
  // (services/persistentMindTaskCapability.js) without further user action —
  // the same "arms unattended execution" reasoning as autopilot start.
  // `pause`/`stop` only reduce execution — left open.
  'POST /api/cos/mind/start',
  'POST /api/cos/mind/wake',
  'POST /api/cos/mind/resume',
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
 * Nested `PUT /api/settings` keys, as dotted paths, that choose a binary
 * PortOS spawns (the image-gen CLIs and the Python interpreter every local
 * media lane runs) or turn the Layered Intelligence `cmd` sources into a
 * full shell (#8751). Their parent slices stay open, so each is gated per
 * CHANGED value rather than per presence: the Image Gen tab resends the whole
 * slice, stored paths included, on every save, and a remote caller changing
 * only an aspect ratio must still be able to save it. A body that omits or
 * clears one (`''`, `null`, `false`) reverts it to the built-in default —
 * the shallow settings merge drops an omitted key, and every reader treats a
 * cleared value as unset — so neither is gated.
 */
export const HOST_CONTROL_SETTINGS_PATHS = Object.freeze([
  'imageGen.agy.agyPath',
  'imageGen.codex.codexPath',
  'imageGen.grok.grokPath',
  'imageGen.local.pythonPath',
  'layeredIntelligence.trustShellSources',
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
  // A mount can consume one slash before its root handler accepts another.
  // Match trailing runs conservatively without rewriting request identifiers.
  return { route, method, pattern: new RegExp(`^/${body}/*$`, 'i') };
};

const COMPILED_ROUTES = HOST_CONTROL_ROUTES.map(compileRoute);

const bodyKeys = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : []);

// Polymorphic policy stores and the capability runner, gated per body rather than per route.
// `hostControlBodyGate` in services/authGate.js applies these after the body
// parser, since `hostControlRouteGate` runs before it.
const COMPILED_BODY_ROUTES = [
  ['POST /api/local-llm/capability-tests/run', (body) => body?.testId === 'sandbox-repair' ? ['testId'] : []],
  ['PUT /api/settings', (body) => bodyKeys(body).filter((key) => HOST_CONTROL_SETTINGS_SLICES.includes(key))],
  ['PUT /api/cos/config', (body) => bodyKeys(body).filter((key) => !HOST_CONTROL_OPEN_COS_CONFIG_KEYS.includes(key))],
].map(([route, pick]) => ({ ...compileRoute(route), pick }));

/** The host-control keys a request body names, for `method path` of a policy store; [] elsewhere. */
export const hostControlBodyKeys = (method, path, body) => {
  if (typeof method !== 'string' || typeof path !== 'string') return [];
  const verb = method.toUpperCase();
  return COMPILED_BODY_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.pick(body) ?? [];
};

const valueAt = (object, path) => path.split('.').reduce(
  (node, key) => (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined),
  object,
);

// Each listed key's readers fall back to the built-in default on any of these.
const isUnset = (value) => value === undefined || value === null || value === '' || value === false;

const SETTINGS_WRITE = compileRoute('PUT /api/settings');

/** The HOST_CONTROL_SETTINGS_PATHS a `method path` body sets to a non-default value, for `PUT /api/settings`; [] elsewhere. */
export const hostControlSettingsPathsIn = (method, path, body) => (
  typeof method === 'string' && typeof path === 'string'
  && method.toUpperCase() === SETTINGS_WRITE.method && SETTINGS_WRITE.pattern.test(path)
    ? HOST_CONTROL_SETTINGS_PATHS.filter((key) => !isUnset(valueAt(body, key)))
    : []
);

/** Of `paths`, the ones whose value in `body` differs from the stored `current` settings. */
export const changedHostControlSettingsPaths = (paths, body, current) => (
  paths.filter((key) => !Object.is(valueAt(body, key), valueAt(current, key)))
);

/** The HOST_CONTROL_ROUTES entry that `method path` (an Express `req.method` / `req.path`) matches, or null. */
export const hostControlRouteFor = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const verb = method.toUpperCase();
  return COMPILED_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.route ?? null;
};

/** Whether `method path` executes on the host. */
export const isHostControlRoute = (method, path) => hostControlRouteFor(method, path) !== null;
