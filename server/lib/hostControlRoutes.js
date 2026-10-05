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
 *   - apps: delete/archive/unarchive, scope-adherence — they
 *     change only PortOS's own records or read files; nothing runs.
 *   - CoS: stop/pause/kill/terminate/delete and feedback — they reduce or
 *     annotate execution, never start it; task reorder/refresh/enhance,
 *     templates and challenge — records and LLM text only. Goal-fidelity false-
 *     positive reports are gated because they can queue investigation agents.
 *   - tools (#9014): create/edit set trusted agent prompt text; DELETE only
 *     removes a tool from that context and stays open.
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
 *   - The "already-configured provider" exemptions here hold only for
 *     tool-free execution (#9008). POST /api/ask and POST /api/detect/ai hand
 *     caller text to a caller-chosen provider, so they gate per request
 *     instead: a provider that cannot run tool-free (`toolFreeOneShotArgs` in
 *     lib/providerVendors.js) needs host control.
 *   - pipeline and FableLoom: autopilot start is gated — with gap filing or
 *     self-improvement on it queues CoS agents — and so are the Pipeline
 *     text/visual generation operations listed under "Pipeline authoring"
 *     below (#10068): callers choose the provider, and the staged runner can
 *     fall back to a CLI/TUI one, so they can launch a tool-capable agent
 *     against stored creative text. Ordinary record CRUD, reads and
 *     cancellation stay open.
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
 *   - settings: other feature toggles and the Eidoverse host bridge (they arm
 *     PortOS's own integrations or open a listener), orchestration profiles,
 *     AI assignments and credentials (they choose among configured providers
 *     or store a key). The `PUT /api/settings` and `PUT /api/cos/config`
 *     slices that change execution policy are gated per request body — see
 *     HOST_CONTROL_SETTINGS_SLICES and HOST_CONTROL_OPEN_COS_CONFIG_KEYS —
 *     and so are the nested settings keys that pick an executable or disarm
 *     a shell guard (HOST_CONTROL_SETTINGS_PATHS), but only when the body
 *     CHANGES the stored value (#8751).
 *
 * Prompt-feeding stores (#9040):
 *   - prompts: stage templates and shared variables direct agents; writes are
 *     gated. DELETE removes stored text; preview and reload only read — open.
 *   - mind bundle/apply replaces execution policy; export/preview only read.
 *   - mind recipes define tool instructions and arguments; create/edit/restore
 *     are gated, archive/validate only remove or inspect recipes.
 *   - mind messages, annotations, journal corrections and attachments speak
 *     as the operator and steer unattended work, so their writes are gated.
 *   - goal-fidelity false-positive reports can queue an investigation agent.
 *   - twin persona create/edit/selection directs agents. Settings changes to
 *     injection, privacy inclusion or active persona require operator authority
 *     in the settings handler; unchanged values and other settings stay open.
 *   - memory, mind curated memories, twin documents/traits and enrichment
 *     remain writable reference data, fenced at prompt assembly. Deletes,
 *     previews, inference and mind stop/pause do not arm execution.
 *   - tools create/edit supplies agent prompt hints (#9014); delete removes
 *     a tool. The mind maintainer watchdog queues remediation and is gated.
 *
 * Patterns are `METHOD /path`, with Express-style `:param` (one segment) and
 * `*name` (the rest of the path). Matching is case-insensitive and ignores one
 * trailing slash, exactly as Express routing does, so a request cannot reach a
 * listed handler by a spelling this list does not match.
 *
 * GitHub routes (#9013): `POST /api/github/repos/sync` is left open — it runs
 * a read-only `gh repo list`, caching the result locally the same as every
 * other read-only GET route. Mutable routes (`PUT` flags/secrets, `POST`
 * archive/unarchive, `POST` secret sync) execute `gh` with the user's GitHub
 * account and change external state; they require operator authority.
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
  'POST /api/system/maintenance',
  'POST /api/system/maintenance/resume',
  'POST /api/voice/studio/setup',

  // Instances: runs the Tailscale CLI and writes a TLS certificate and private
  // key into the install's cert directory.
  'POST /api/instances/provision-cert',

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
  'POST /api/cos/merge-admission',
  'POST /api/cos/claim-ownership',
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
  // Tool descriptions and hints become trusted context for CoS agents (#9014).
  'POST /api/tools',
  'PUT /api/tools/:id',
  'PUT /api/cos/schedule/task/:taskType',
  'POST /api/cos/schedule/trigger',
  'POST /api/cos/schedule/maintenance-runs',
  'POST /api/cos/schedule/maintenance-runs/:id/resume',
  'POST /api/cos/tools/call',

  // Quota Burn (#9030): PUT accepts the legacy agent-prompt compatibility shape
  // and converts it into an enabled, autonomyLevel-yolo custom CoS job — the
  // same "arbitrary prompt becomes unattended work" shape as `POST /api/cos/jobs`
  // above, just reached through a different entry point. `run` dispatches a
  // family or a named job immediately, past the master switch and (with
  // `force`) the family's own quota gates. `rearm` re-arms an already-configured
  // one-shot step for another cycle — it queues no new prompt, but it puts spent
  // work back into rotation the operator meant to run once.
  'PUT /api/quota-burn',
  'POST /api/quota-burn/run',
  'POST /api/quota-burn/rearm',

  // Shell image drop (#9030): the HTTP twin of the gated `shell:input` socket
  // event (HOST_CONTROL_SOCKET_EVENTS in services/socket.js) — it pastes the
  // caller's message into a live PTY and submits it, driving whatever agent or
  // shell that session is running.
  'POST /api/shell/sessions/:sessionId/image',

  // Instruction stores and operator messages consumed by unattended agents.
  'POST /api/prompts',
  'PUT /api/prompts/:stage',
  'POST /api/prompts/variables',
  'PUT /api/prompts/variables/:key',
  'POST /api/cos/mind/bundle/apply',
  // The maintainer watchdog can queue forge remediation agents.
  'POST /api/cos/mind/maintainer/watchdog',
  'POST /api/cos/mind/recipes',
  'PUT /api/cos/mind/recipes/:recipeId',
  'POST /api/cos/mind/recipes/:recipeId/restore',
  'POST /api/cos/mind/messages',
  'POST /api/cos/mind/annotations',
  'POST /api/cos/mind/journal/:journalEventId/correct',
  'POST /api/cos/mind/attachments',
  'POST /api/cos/goal-fidelity/false-positive',
  'POST /api/digital-twin/personas',
  'PUT /api/digital-twin/personas/:id',
  // /personas/:id also covers /personas/active.
  'POST /api/tools',
  'PUT /api/tools/:id',

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

  // Motion toolkit: executes the downloaded installer and writes agent skills user-wide.
  'POST /api/html-composition/toolkit/skills/install',

  // Media runtime setup installs executable dependencies or builds a Docker
  // image; authorize before opening SSE or probing runtime readiness.
  'POST /api/music/setup/runtime-install',
  'POST /api/video-gen/setup/runtime-install',
  'POST /api/music/supercollider/setup',

  // Image-to-3D (TRELLIS.2 / Pixal3D) installers git-clone and build engines,
  // the MuScriptor installer builds a venv via the setup script, and the
  // yt-dlp update replaces a package-managed host binary (#9555). Status GETs
  // stay open.
  'POST /api/image-to-3d/targets/:targetId/install',
  'POST /api/image-to-3d/trellis2/install',
  'POST /api/midi-runtime/install',
  'POST /api/devtools/video-download/yt-dlp/update',

  // Media authoring can launch a coding CLI/TUI agent, including via provider
  // fallback. Gate the whole operation even when the initial provider is API;
  // runtime-data cwd and later render containment do not sandbox authoring.
  'POST /api/code-animation/brief',
  'POST /api/code-animation/generate',
  'POST /api/code-animation/projects/:id/stage-runs',
  'POST /api/music/describe',
  'POST /api/music/lyrics',
  'POST /api/music/waveform',
  'POST /api/music/code',
  'POST /api/tracks/:id/waveform/draw',
  'POST /api/music-video/autonomous',
  'POST /api/music-video/:id/autonomous/resume',
  // Music Video planning, authoring and review may dispatch CLI/TUI agents
  // directly, by fallback or after a checkpoint (#9869). Gate each operation
  // uniformly, including deterministic plan/compile options. Creative approval
  // and toolFree authoring flags do not grant network execution authority.
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

  // Media agents retain host tools; scratch cwd and output validation are not
  // execution containment (#9667). Gate before uploads, stores or queue writes,
  // including inference-first requests that can fall back to CLI/TUI.
  'POST /api/image-gen/generate',
  'POST /api/image-gen/avatar',
  'POST /api/video-gen',
  'POST /api/sprites/:id/reference/generate',
  // Fork creates a record and immediately queues reference generation too.
  'POST /api/sprites/:id/fork',
  'POST /api/sprites/:id/walk/generate',
  'POST /api/sprites/:id/tracks/:trackId/generate',
  'POST /api/threejs-models',
  'POST /api/threejs-models/:id/generate',
  // Publication chooses and rewrites managed-app source.
  'PUT /api/sprites/:id/publish-binding',
  'POST /api/sprites/:id/atlas/publish',

  // Auxiliary media entry points reach the same tool-capable agents (#9672):
  // prompt refinement and image-to-prompt hand caller text/images to a provider
  // that may fall back to a CLI/TUI; retry and run-now (re)dispatch an
  // agent-backed queue job (retry merges caller prompt overrides); dataset
  // generate/caption/slice use a cloud-agent render target or a CLI vision
  // provider. Cancel, reads, dataset CRUD/uploads and strip-shared-fragments
  // stay open.
  'POST /api/media-jobs/refine-prompt',
  'POST /api/media-jobs/prompt-from-media',
  'POST /api/media-jobs/:id/retry',
  'POST /api/media-jobs/:id/run-now',
  'POST /api/lora-datasets/:id/generate',
  'POST /api/lora-datasets/:id/caption',
  'POST /api/lora-datasets/:id/slice-reference-sheet',

  // Code Animation contained execution (#9388): choosing the installed tool a
  // worker runs, and the containment check that spawns sandboxed processes.
  'PUT /api/code-animation/execution/tools',
  'POST /api/code-animation/execution/probe',

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

  // Pipeline authoring (#10068): text, prompt-refinement and visual generation
  // hand stored creative text to a caller-selected provider that may be, or
  // fall back to, a CLI/TUI agent, or submit a cloud-agent render job directly.
  // Gate the whole operation, including API-first requests, before any store
  // write, run creation, checkpoint or queue submission.
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

  // Autopilots and support requests that queue CoS agents.
  'POST /api/pipeline/series/:id/autopilot/start',
  'POST /api/fableloom/:id/editorial/autopilot/start',
  'POST /api/image-video/models/support-request',

  // Eidoverse: clone and install a caller-named repo, or repoint it.
  'POST /api/settings/features/eidoverse/install',
  'PUT /api/settings/features/eidoverse/source',

  // GitHub actions (#9013): mutating routes run `gh` with the user's GitHub
  // account and change external state. Syncing repos is read-only.
  'PUT /api/github/repos/:fullName',
  'POST /api/github/repos/:fullName/archive',
  'POST /api/github/repos/:fullName/unarchive',
  'PUT /api/github/secrets/:name',
  'POST /api/github/secrets/:name/sync',

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
 * harness enablement and wrapper CLIs, the Code Animation worker tools, the
 * code-review chain, the untrusted content screen in front of agent work,
 * scheduled self-update, and scheduled series autopilots. The store is polymorphic, so its other slices stay open.
 */
export const HOST_CONTROL_SETTINGS_SLICES = Object.freeze([
  'autoUpdate',
  'codeAnimationExecution',
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
  // Enabling this feature now launches its registered host executable.
  ['PUT /api/settings/features/eidoverse', (body) => bodyKeys(body)],
  ['POST /api/local-llm/capability-tests/run', (body) => body?.testId === 'sandbox-repair' ? ['testId'] : []],
  ['PUT /api/settings', (body) => bodyKeys(body).filter((key) => HOST_CONTROL_SETTINGS_SLICES.includes(key)
    || (key === 'instanceFeatures' && body.instanceFeatures?.eidoverse !== undefined))],
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
