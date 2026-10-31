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
 * Voice and palette tools (services/voice/tools.js) reach some of these
 * operations without the route, so a tool whose route twin is listed here
 * carries `hostControl: true`, checked at dispatch.
 *
 * A route belongs here when it runs a process, git, npm, gh or a CoS agent on
 * the host, or when it sets what one will run (a repo path, a start command, a
 * task prompt, a shell job), or accesses live camera/microphone streams.
 * Ordinary read-only GETs stay open (a GET that only decodes media for some
 * callers checks `requestHasHostControl` in its handler instead, as the Music
 * Video shot, look and cleanup reads do for the song-master decode, #13156); raw backup archives require operator
 * authority because they export private records and credentials, and so does
 * the directory picker (GET /api/scaffold/directories), which enumerates any
 * readable host directory rather than a PortOS record. Mutating routes in the
 * same families that are deliberately left OUT:
 *   - apps: delete/archive/unarchive, scope-adherence — they
 *     change only PortOS's own records or read files; nothing runs.
 *   - CoS: stop/pause/kill/terminate/delete and feedback — they reduce or
 *     annotate execution, never start it; task reorder/refresh, templates and
 *     challenge — records and LLM text only. Task enhance is NOT in that
 *     group: it hands caller text to a stage-configured provider that may be a
 *     CLI/TUI agent (#10908). Goal-fidelity false-
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
 *   - A1111 compatibility (#11138): POST /sdapi/v1/txt2img gates in-handler
 *     when the resolved backend is Codex, Grok or Antigravity. External/local/
 *     Fal inference and discovery/progress retain their exposure/auth policy.
 *     The checked mode is pinned into dispatch; unclassified modes are refused.
 *   - pipeline and FableLoom: autopilot start is gated — with gap filing or
 *     self-improvement on it queues CoS agents — and so are the Pipeline
 *     text/visual generation operations listed under "Pipeline authoring"
 *     and "Pipeline authoring, remainder" below (#10068, #10907) and
 *     FableLoom authoring/production (#10668): callers choose the provider,
 *     and the staged runner can fall back to a CLI/TUI one, so they can
 *     launch a tool-capable agent against stored creative text. Ordinary
 *     record CRUD, reads, cancellation and SSE progress stay open, as do the
 *     deterministic Pipeline routes (series merge preview/apply, arc
 *     derive-from-manuscript/commit, manuscript cuts preview/apply, comic
 *     extract-pages, audio extract-lines, scene video, TTS and music
 *     rendering): none reaches the staged runner.
 *   - Caller-prompted AI outside Pipeline (#10908, #10989): game feedback,
 *     rounds generate/evaluate/derive-parts, personality generate,
 *     system-resource triage, mood-board style synthesis/compose/analyze, CoS
 *     task enhance, Music Video cover design/generation and promotion plans,
 *     and POST LLM scoring, rhetoric evaluation and drill-cache fill take
 *     caller text and/or a caller-chosen provider; gated whole-operation.
 *     POST /api/meatspace/post/drill is gated only when `type` is an LLM
 *     drill; math, memory and cognitive drills stay open. Cover compose,
 *     lettering saves and promotion reads stay open.
 *   - Storyboards (#12952): plot beat extraction, a panel node run and the
 *     make-empty batch hand caller text (the plot, or node prompts saved
 *     through the open recipe/node writes) to a caller-chosen provider that is
 *     not tool-free, or queue image renders; gated whole-operation like
 *     mood-board generate. Board, beat, panel and take CRUD, the recipe and
 *     node PATCH, beats/add, the recipe library and the plan/make reads only
 *     store or read records and stay open.
 *   - Pre-guard audit (#13055): the film-look bake (headless browser),
 *     video last-frame (ffmpeg), mood-board note render (image job), Suno
 *     song-revision generation (signed-in browser) and Eidoverse augment/say
 *     (acting as the CoS world identity) are gated whole. SynthID regenerate is
 *     gated unless `method` is `light`, and the code-animation prompt only when
 *     it names a `referenceVideo`. Left open: gallery image clean and
 *     watermark removal (in-process sharp), and the Messages, Tribe outreach,
 *     autobiography, identity-goal and insights AI routes, whose transports
 *     are tool-free (an HTTP chat completion or the sandboxed Codex text turn).
 *     The remainder of the audit gated the routes listed under "Pre-guard
 *     audit, remainder" below: ffmpeg/ffprobe over caller-supplied, uploaded,
 *     gallery or peer-pulled media, the headless composition browser, local
 *     Python/Docker/PM2 work, host data and secrets, the operator's signed-in
 *     browser, external account writes, agent and LLM work, resets that put
 *     held agent work back in rotation, and Eidoverse identity and controller
 *     configuration. Per request: the standalone image clean in GPU mode (the
 *     handler checks its query), Brain settings that arm or retarget the
 *     scheduled digest (the handler compares the stored value), Music Video
 *     document import and accept (the handler starts the browser overlay check
 *     only with host control), voice config (the runtime reconcile likewise),
 *     and the body splits in COMPILED_BODY_ROUTES. Left open with a specific
 *     reason in REVIEWED_OPEN_MUTATIONS (server/hostControlCoverage.test.js):
 *     fixed read-only probes (`ps`, `du`, `lsof`, `pm2 jlist`), the chiptune
 *     and waveform renders (a fixed ffmpeg encode of audio PortOS synthesized), TTS
 *     synthesis on an installed runtime (configured inference), and selection
 *     among already-configured providers that arms nothing.
 *   - Importer, Brain and analytics AI (#11036): classify/analyze/retry-issues,
 *     model-personality run, goal-scorecard narrative, Brain capture (it can
 *     dispatch classification or repository intake), inbox retry, digest/review
 *     runs and the daily-log draft hand caller text, stored reference data
 *     and/or a caller-chosen provider to a runner that is not tool-free. Brain
 *     daily-log digest-settings select the provider a scheduled digest uses and
 *     arm it. Importer commit is gated only when `cleanupFormatting` is true;
 *     the default deterministic commit stays open. Collateral restriction:
 *     remote password-free Brain capture is refused whole. Record reads/CRUD and
 *     the non-AI insights compute/refresh routes stay open.
 *   - Creative Director and Creative Commissions (#10867): project create/edit
 *     choose agent instructions and provider pins; start/resume/directive/
 *     replan/plan-step/auto-cast/smoke-test/review enqueue or re-arm writable
 *     treatment, planner and scene agents, and the plan/treatment/scene PATCHes
 *     are the agents' callbacks (authorized by their delegated
 *     PORTOS_API_TOKEN session). Commission create/edit/run/feedback steer and
 *     arm unattended agents. Left open: Creative Director pause, stop, delete
 *     and catalog-only auto-cast/suggest, and commission delete — they only
 *     reduce execution or remove records.
 *   - notes (#9007): vault add/repoint gated (chooses the host directory
 *     note CRUD reads/writes); note CRUD itself stays open.
 *   - Outbound endpoints and host data files: a setting that names a URL
 *     PortOS later sends data to, or a host file it reads and writes, needs
 *     operator authority to change. A remote caller choosing one could send
 *     private audio, text or a stored token to their own server, which can
 *     then redirect the request to PortOS's own loopback port, where it counts
 *     as a local operator. They could also read or write any JSON file the
 *     host user owns. Gated: the voice STT endpoint, the Image Gen external
 *     SD API URL (including its legacy top-level key), the Beeper base URL and
 *     its non-loopback opt-in, the MortalLoom store path (all change-gated,
 *     below) and `PUT /api/lmstudio/config` (base URL plus timeout, in
 *     memory, with no UI writer).
 *   - Caller-named host paths: a request body that names a host directory or
 *     file PortOS then reads, writes or runs against is the same choice as a
 *     stored host-file setting, made once. A remote password-free caller
 *     could otherwise point PortOS at any path the host user owns. Gated:
 *     reference-repo create (and a PATCH that names `repoUrl` or `branch`,
 *     which the scheduled reference-watch runs git in and hands to an
 *     analysis agent), share-bucket create (PortOS writes records into and
 *     imports manifests from the folder), the sprite source-tree import and
 *     the path-based Gmail mbox import. Rename/notes/mode PATCHes, bucket
 *     export into an operator-chosen bucket, and the upload-based importers
 *     stay open: they name no host path.
 *   - browser (#12488): the managed profile carries the operator's signed-in
 *     sessions and saves downloads silently, so navigate, the page list and
 *     the downloads list/file reads are gated (steering it or reading what it
 *     saved is operator work; the URL/IP guards only stop private-network
 *     targets). `GET /api/browser` stays open but omits page and download
 *     listings for a caller without host control. Downloads DELETE only
 *     removes data. Harness models/refresh re-reads the
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
 *     PortOS's own integrations or open a listener; the eidoverse and
 *     docker-containment toggles launch or tear down host executables and are
 *     gated by path), orchestration profiles,
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
 *   - voice config (#10990): `llm.systemPrompt`, `llm.personality`,
 *     `llm.tools.enabled` and `llm.codeAgent` are the voice agent's
 *     instructions or the switch that arms its coding-agent tool, and
 *     `stt.endpoint` receives microphone audio and returns the transcript
 *     the agent acts on. `enabled`, the STT/TTS engines, Core ML and the
 *     host model/voice paths are what the runtime reconcile starts, installs or
 *     reads (#13055). `PUT /api/voice/config` is gated only when one of those
 *     values would change (`HOST_CONTROL_VOICE_CONFIG_PATHS`), and it runs the
 *     reconcile (PM2, setup script) only for a caller with host control; a
 *     whole-config resend and every other voice setting stay open.
 *     Generic settings replaces the entire voice root, so even an empty
 *     replacement can reset protected policy and requires operator authority.
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
 * The notifications inbox (#12952) follows the same rule: thread actions,
 * audit apply and both undo routes write to the account with `gh`; the
 * automation schedule arms a CoS System task (the same change as the gated
 * CoS job routes); account create/edit choose the identity `gh` acts as, arm
 * Assist/Autopilot, or widen provider exposure, so they are gated whole.
 * `POST /api/github/notifications/sync` stays open as a refresh, but a caller
 * without host control gets fetch and metadata triage only — the handler
 * skips Assist/Autopilot for that request. Account and learned-rule DELETEs,
 * the read-only audit run (`POST /api/github/audit/:accountId`, a `gh` GET)
 * and every GET stay open.
 *
 * Every mounted mutating route is classified: it is in HOST_CONTROL_ROUTES,
 * gated per body (COMPILED_BODY_ROUTES), or recorded with a reason in REVIEWED_OPEN_MUTATIONS
 * (server/hostControlCoverage.test.js), which fails CI on a new, stale or
 * double-listed route. Classify a new route when you add it, using the
 * family notes above.
 *
 * GET routes are covered by a static trace instead (#13097): the same guard
 * follows each mounted GET handler through the module-scope bindings it names,
 * lazy `import()`s, barrels and namespace imports included, to child_process,
 * node-pty, playwright/puppeteer, ws, keytar, a DevTools endpoint, a computed
 * import or an injected router dependency (server/test/processReachScan.js).
 * A GET whose trace reaches one is gated here or listed in
 * REVIEWED_PROCESS_GETS with a reason; a fixed probe that many GETs share
 * (sysctl, nvidia-smi, `--version`, `brctl download`) is reviewed once in
 * REVIEWED_PROCESS_SITES and ends the trace. The trace over-approximates —
 * a reached binding counts whole — so a reason may say that the traced
 * executor sits in a table the handler only reads. Gated GETs: the dependency
 * impact preview (an ffmpeg decode of the song master) and the YouTube setup
 * check (it opens and reads a tab in the signed-in browser); the client shows
 * a refused preview as unavailable. Open with a reason: version, status and
 * import probes, PM2 and git/forge reads, ffprobe of stored media, and the
 * actionable-insights PM2 sweep, which runs only for a caller with host
 * control (POST /api/cos/health/check is its gated twin). A callback stored at
 * runtime or an EventEmitter listener is not followed, so read for those.
 */

import { canonicalStringify, isPlainObject, POLLUTING_KEYS } from './objects.js';
import { LLM_DRILL_TYPES } from './postDrillTypes.js';
import { escapeRegExp } from './textUtils.js';

export const HOST_CONTROL_ROUTES = Object.freeze([
  // Stacker News review authorizes a later saved-key publication or browser
  // handoff; both the decision and execution require operator authority.
  'POST /api/stacker-news/actions/:id/review',
  'POST /api/stacker-news/actions/:id/execute',
  // Signed-in browser reads, including caller-selected verification transport.
  'POST /api/stacker-news/accounts/:id/sync',
  'POST /api/stacker-news/accounts/:id/browser-identity',
  'POST /api/stacker-news/accounts/:id/verify',

  // X (Twitter) draft review authorizes a later browser compose handoff, and
  // opening approved drafts, opening account destinations or syncing accounts
  // executes CDP browser automation on the host. Reads, account CRUD and draft
  // creation remain data-only operations.
  'POST /api/x/drafts/:id/review',
  'POST /api/x/drafts/:id/open',
  'POST /api/x/accounts/:id/open',
  'POST /api/x/accounts/:id/sync',

  // Telegram bot configuration, testing and bridge lifecycle execute host
  // processes, register bots, or authorize remote command execution and
  // notification forwarding (#11431). Reads remain open.
  'PUT /api/telegram/config',
  'DELETE /api/telegram/config',
  'PUT /api/telegram/method',
  'POST /api/telegram/test',
  'PUT /api/telegram/forward-types',
  'POST /api/telegram/bridge/reload',

  // Sending a draft performs an external mail side effect as the operator (#11273).
  'POST /api/messages/drafts/:id/send',
  // Provider launch opens Teams/Outlook tabs in the host CDP browser, and the
  // Gmail enable helper navigates it to Google Cloud Console (#11433).
  'POST /api/messages/launch/:accountId',
  'POST /api/messages/gmail/enable-api',
  // Archive and delete act on mail items in the external account (#11434).
  'POST /api/messages/:accountId/:messageId/action',
  // Selector tests drive the host CDP browser against live Outlook/Teams tabs,
  // selector edits change that automation, and token extraction intercepts
  // bearer tokens from those sessions (#11449).
  'POST /api/messages/selectors/:provider/test',
  'PUT /api/messages/selectors/:provider',
  'POST /api/messages/debug/test-token',

  // Capture activation and existing live feeds require operator authority (#11272).
  // HEAD inherits the GET policy because Express invokes the same handler.
  'POST /api/media/start',
  'GET /api/media/video',
  'GET /api/media/audio',

  // Rigging and retargeting spawn Blender/Python workers on the host for up to
  // 20 minutes each (#10922).
  'POST /api/rigging/models/:id',
  'POST /api/rigging/models/:id/retarget',

  // A remote desktop session token proxies interactive mouse/keyboard/screen
  // control of the host desktop; a peer's Basic credential must not mint one (#10923).
  'POST /api/remote-desktop/sessions',

  // Force-kills whatever host PID the caller names, not only a detected agent
  // CLI — the same host-process control as the gated PM2 process action in
  // routes/commands.js. CoS agent stop/kill by agent id stays open.
  'DELETE /api/agents/:pid',

  // Universe Builder authoring (#10669) can dispatch tool-capable text/vision
  // providers or image agents, including API-first CLI/TUI fallback. Authorize
  // the whole operation before image resolution, stores, runs or queue writes.
  // Record CRUD, reviewed proposal application, merge preview/commit, locks,
  // description backfill, deletions and reads remain data-only operations.
  'POST /api/universe-builder/expand',
  'POST /api/universe-builder/generate-variations',
  'POST /api/universe-builder/refine-prompts',
  'POST /api/universe-builder/:id/promote-variation',
  'POST /api/universe-builder/:id/auto-sort',
  'POST /api/universe-builder/:id/extract-canon',
  'POST /api/universe-builder/:id/characters/:entryId/refine',
  'POST /api/universe-builder/:id/characters/:entryId/expand',
  'POST /api/universe-builder/:id/characters/integrity/review',
  'POST /api/universe-builder/:id/characters/:entryId/augment',
  'POST /api/universe-builder/:id/characters/differentiate-cast',
  'POST /api/universe-builder/merge/ai-resolve',
  'POST /api/universe-builder/describe-from-images',
  'POST /api/universe-builder/:id/characters/:entryId/expand-from-images',
  'POST /api/universe-builder/:id/canon/:kind/:entryId/correct-from-image',
  'POST /api/universe-builder/analyze-style-reference',
  'POST /api/universe-builder/:id/render',
  'POST /api/universe-builder/:id/characters/:entryId/render-reference-sheet',

  // Story Builder queues agent-capable generation before returning SSE progress (#10670).
  'POST /api/story-builder/:id/steps/:stepId/generate',
  'POST /api/story-builder/:id/steps/:stepId/refine',
  'POST /api/story-builder/:id/issues/generate',

  // Creative Director and Creative Commissions (#10867): the legacy flow
  // enqueues writable, auto-approved treatment/planner/scene agents, and
  // commissions arm the same sink on a schedule or via Run Now. Authorize
  // before any store write, starter, queue or schedule effect. Pause, stop,
  // delete, catalog-only /auto-cast/suggest and commission delete stay open.
  'POST /api/creative-director',
  'PATCH /api/creative-director/:id',
  'POST /api/creative-director/:id/start',
  'POST /api/creative-director/:id/resume',
  'POST /api/creative-director/:id/directive',
  'POST /api/creative-director/:id/replan',
  'POST /api/creative-director/:id/plan/step/:stepId',
  'POST /api/creative-director/:id/auto-cast',
  'POST /api/creative-director/smoke-test',
  'POST /api/creative-director/:id/review',
  'PATCH /api/creative-director/:id/plan',
  'PATCH /api/creative-director/:id/treatment',
  'PATCH /api/creative-director/:id/scene/:sceneId',
  'POST /api/creative-commission',
  'PATCH /api/creative-commission/:id',
  'POST /api/creative-commission/:id/run',
  'POST /api/creative-commission/:id/feedback',

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
  // The agent API key writes an operator session token to the host user's
  // home directory (services/agentKey.js); enabling and rotating mint it.
  'PUT /api/auth/agent-key',
  'POST /api/auth/agent-key/rotate',

  // Generic runs accept arbitrary prompts/workspaces, including API-to-CLI fallback.
  'POST /api/runs',
  // Operator chat forwards prompts through configured tool-capable runtime credentials.
  'POST /api/openclaw/sessions/:id/messages',
  'POST /api/openclaw/sessions/:id/messages/stream',
  'POST /api/system/maintenance',
  'POST /api/system/maintenance/resume',
  'POST /api/voice/studio/setup',
  // Voice fine-tune start spawns a Python trainer on the host (#11074).
  'POST /api/voice/profiles/:id/fine-tune/start',

  // Instances: runs the Tailscale CLI and writes a TLS certificate and private
  // key into the install's cert directory.
  'POST /api/instances/provision-cert',
  // Tailcat: installs the binary (brew / go install) and starts the relay
  // processes; serve opens the remote ingress and reveals its bearer address.
  // Serve capabilities and device trust management require operator authority.
  'POST /api/instances/peers/tailcat',
  'POST /api/instances/peers/tailcat/forwards/:id/retry',
  'POST /api/instances/peers/tailcat/serve',
  'POST /api/instances/peers/tailcat/serve/retry',
  'GET /api/instances/peers/tailcat/serve',
  'GET /api/instances/peers/tailcat/devices',
  'POST /api/instances/peers/tailcat/devices',
  'PATCH /api/instances/peers/tailcat/devices/enforcement',
  'DELETE /api/instances/peers/tailcat/devices/:id',

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
  'POST /api/apps/:id/forge-auth/refresh',
  'GET /api/apps/:id/forge-auth/refresh/:jobId/events',
  'POST /api/apps/:id/forge-auth/refresh/:jobId/cancel',
  // Enable or queue CoS agent work against an app.
  'POST /api/apps/:id/launch-videos',
  'POST /api/apps/:id/launch-videos/publish',
  'POST /api/apps/:id/quality-schedule/apply',
  'PUT /api/apps/bulk-task-type/:taskType',
  'PUT /api/apps/:id/task-types/all',
  'PUT /api/apps/:id/task-types/:taskType',

  // CoS: queue, release or steer an agent that runs shell commands in a
  // worktree, or a job that runs a shell command directly.
  'POST /api/cos/merge-admission/external',
  'POST /api/cos/merge-handoff',
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
  'POST /api/cos/agents/:id/recheck-cleanup',
  'POST /api/cos/agents/:id/btw',
  'POST /api/cos/agents/:id/security-scan',
  'POST /api/cos/agents/:id/release-publication',
  'POST /api/cos/agents/:id/release-candidate',
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
  'POST /api/cos/schedule/branch-reconcile/refresh',
  'POST /api/cos/schedule/release-synchronization/operator-reset',
  // Removes a checkout and its merged branch under a scoped release.
  'POST /api/cos/schedule/branch-reconcile/checkouts/retire',
  'POST /api/cos/schedule/branch-reconcile/checkouts/review',
  'POST /api/cos/schedule/maintenance-runs',
  // Editing a pending stage changes the provider used by deferred host work.
  'PATCH /api/cos/schedule/maintenance-runs/:id/steps/:stepId',
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

  // Digital Twin AI actions (#10671) reach the shared CLI/TUI-capable runner,
  // directly or via imported-data analysis. Gate API-first requests too: their
  // configured fallback can execute a process. Authorize before private reads,
  // document writes or behavioral batches; reference CRUD, bounded API-only
  // taste/vision calls and deterministic recomputation remain open.
  'POST /api/digital-twin/enrich/question',
  'POST /api/digital-twin/enrich/answer',
  'POST /api/digital-twin/enrich/analyze-list',
  'POST /api/digital-twin/validate/contradictions',
  'POST /api/digital-twin/analyze-writing',
  'POST /api/digital-twin/style/spoken-written',
  'POST /api/digital-twin/traits/analyze',
  'POST /api/digital-twin/confidence/calculate',
  'POST /api/digital-twin/interview/analyze',
  'POST /api/digital-twin/tests/run',
  'POST /api/digital-twin/tests/run-multi',
  'POST /api/digital-twin/tests/generate',
  'POST /api/digital-twin/values-tests/run',
  'POST /api/digital-twin/adversarial-tests/run',
  'POST /api/digital-twin/multi-turn-tests/run',
  'POST /api/digital-twin/avatar-bio/polish',
  'POST /api/digital-twin/import/analyze',
  'POST /api/digital-twin/import/spotify/browser/import',
  'POST /api/digital-twin/twin-evidence/interpret',

  // Git in a caller-named directory. Every POST is gated, reads included: git
  // runs repository-configured programs (hooks, fsmonitor) even for `status`.
  'POST /api/git/*rest',

  // Notes vaults: add/repoint chooses which host directory the note CRUD
  // routes read from and write into (#9007). Note CRUD itself stays open —
  // it is only safe once the root is operator-chosen.
  'POST /api/notes/vaults',
  'PUT /api/notes/vaults/:id',

  // Backups contain private records and credentials, not a bounded read-only
  // projection. Creating/exporting/deleting them and resuming a restore need
  // the same operator authority as restore previews/execution (#8772).
  // Status and snapshot inventory stay open; backup policy is body-gated below.
  'POST /api/backup/run',
  'GET /api/backup/snapshots/:snapshotId/download',
  'DELETE /api/backup/snapshots/:snapshotId',
  'POST /api/backup/restore-db/recover',
  'POST /api/backup/restore',
  'POST /api/backup/restore-db',

  // Scaffolding writes a new repo and runs git/npm in it. The picker lists
  // directory and file names anywhere on the host (not only under the
  // workspace roots: the same component browses /Applications for a Chrome
  // binary), so it is operator-only too; the template catalog stays open.
  'GET /api/scaffold/directories',
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
  // Docker containment pulls an image and runs repository code in a container
  // (#12844); the status GET stays open.
  'POST /api/docker-containment/pull',
  'POST /api/docker-containment/run',

  // Image-to-3D (TRELLIS.2 / Pixal3D) installers git-clone and build engines,
  // the MuScriptor installer builds a venv via the setup script, and the
  // yt-dlp update replaces a package-managed host binary (#9555). Status GETs
  // stay open.
  'POST /api/image-to-3d/targets/:targetId/install',
  'POST /api/image-to-3d/trellis2/install',
  // 3D generation and re-generation run host Python/GPU adapters (#11075).
  'POST /api/image-to-3d/models',
  'POST /api/image-to-3d/models/:id/generate',
  'POST /api/midi-runtime/install',
  'POST /api/devtools/video-download/yt-dlp/update',

  // Video and audio downloads shell out to yt-dlp and ffmpeg on the host.
  'POST /api/devtools/video-download',
  'POST /api/tracks/import/youtube',
  'POST /api/rounds/reference-audio/import',

  // Audio-to-MIDI transcription runs the local MuScriptor Python sidecar on the host.
  'POST /api/music-video/:id/transcribe-midi',
  'POST /api/rounds/reference-audio/transcribe-midi',

  // Vocal stem separation provisions a demucs venv and runs neural separation on the host.
  'POST /api/music-video/:id/vocal-stem/separate',
  // Lyric alignment downloads models and spawns whisper or neural CTC on the host.
  'POST /api/music-video/:id/lyrics/align',

  // LoRA effect probe spawns Python on the host to analyze adapter tensors.
  'POST /api/loras/:filename/effect',

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
  // Local music generation spawns neural-audio Python on the host (#11077).
  'POST /api/music/generate',
  'POST /api/code-animation/:id/soundtrack',
  'POST /api/tracks/:id/waveform/draw',
  'POST /api/music-video/autonomous',
  'POST /api/music-video/:id/autonomous/resume',
  // Music Video planning, authoring and review may dispatch CLI/TUI agents
  // directly, by fallback or after a checkpoint (#9869). Gate each operation
  // uniformly, including deterministic plan/compile options. Creative approval
  // and toolFree authoring flags do not grant network execution authority.
  // Revision entry points reach the same authoring runners, including fallback.
  // Song-revision /scenes gates only action=replan in the body registry; remove and
  // dismiss remain record-only operations.
  'POST /api/music-video/:id/production-review/revise',
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
  // Song revision drives the signed-in PortOS Browser to submit the song to
  // Suno, spending the operator's account credits (#13055).
  'POST /api/music-video/:id/song-revision/generate',

  // Media agents retain host tools; scratch cwd and output validation are not
  // execution containment (#9667). Gate before uploads, stores or queue writes,
  // including inference-first requests that can fall back to CLI/TUI.
  'POST /api/image-gen/generate',
  'POST /api/image-gen/avatar',
  // Film-look bake launches a headless composition browser on the host (#13055).
  'POST /api/image-gen/:filename/film-look',
  'POST /api/video-gen',
  // Last-frame extraction runs ffmpeg over a gallery clip (#13055).
  'POST /api/video-gen/last-frame/:id',
  // Upscale (LTX subprocess / ffmpeg) and stitch (ffmpeg) run on the host (#11076).
  'POST /api/video-gen/upscale/:id',
  'POST /api/video-gen/upscale/:id/topaz/quote',
  'POST /api/video-gen/upscale/:id/topaz',
  'GET /api/video-gen/upscale/topaz/jobs/:jobId/status',
  'POST /api/video-gen/upscale/topaz/jobs/:jobId/cancel',
  'POST /api/video-gen/upscale/topaz/jobs/:jobId/recover',
  'POST /api/video-gen/stitch',
  // Start trim probes/transcodes a new gallery clip with ffprobe/ffmpeg (#11418).
  'POST /api/video-gen/history/:id/trim-start',
  'POST /api/video-gen/metal-buffer-profiles/clear',
  // Timeline render spawns ffmpeg/ffprobe on the host for segments and audio (#11432).
  'POST /api/video-timeline/projects/:id/render',
  // Music Video ffmpeg renders: final render, per-shot segments, shot preview
  // concat with the song, the cold open's sound mix, excerpt encode, and
  // platform encodes/thumbnails (#12514).
  'POST /api/music-video/:id/render',
  'POST /api/music-video/:id/shots/:sceneId/render',
  'POST /api/music-video/:id/shot-renders/preview',
  'POST /api/music-video/:id/cold-open/audio',
  'POST /api/music-video/:id/excerpt',
  'POST /api/music-video/:id/publish-kit/build',
  'POST /api/music-video/:id/dcp/readiness',
  'POST /api/music-video/:id/dcp/build',
  'POST /api/music-video/dcp/:jobId/cancel',
  'GET /api/music-video/dcp/:jobId/events',
  'GET /api/music-video/:id/dcp/:artifactId/report',
  'GET /api/music-video/:id/dcp/:artifactId/location',
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

  // Deck authoring/rendering and chiptune generation hand editable text to a
  // provider that may fall back to a CLI/TUI, or enqueue an agent-backed image
  // job; chiptune publication writes into a managed app repo (#10893). Gate the
  // whole operation, API-first variants included. Deck/track CRUD, progress
  // reads and the deterministic chiptune library render stay open (its fixed
  // ffmpeg encode only reads audio PortOS synthesized, #13055).
  'POST /api/decks/:id/analyze-sample',
  'POST /api/decks/:id/generate-prompts',
  'POST /api/decks/:id/render',
  'POST /api/decks/:id/cards/:cardId/render',
  'POST /api/tracks/:id/chiptune/generate',
  'POST /api/tracks/:id/chiptune/publish',

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
  // LoRA training start/resume spawn detached trainer processes on the host GPU (#11073).
  'POST /api/lora-training/runs',
  'POST /api/lora-training/runs/:id/resume',

  // Code Animation contained execution (#9388): choosing the installed tool a
  // worker runs, and the containment check that spawns sandboxed processes.
  'PUT /api/code-animation/execution/tools',
  'POST /api/code-animation/execution/probe',

  // Providers: which binary runs, with which args, against which endpoint and
  // credentials; installing or launching runtimes; signing a CLI in or out.
  // `PUT /api/providers/:id` also matches `/active` and `/bootstraps`.
  'GET /api/providers/:id/execution-options',
  'POST /api/providers/:id/execution-options/selection',
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
  'POST /api/browser/navigate',
  'GET /api/browser/pages',
  'GET /api/browser/downloads',
  'GET /api/browser/downloads/:name',
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
  // Base URL every LM Studio completion, embedding and Persistent Mind call
  // sends user text to; no UI writes it.
  'PUT /api/lmstudio/config',
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

  // Pipeline authoring, remainder (#10907): series/arc planning, analysis,
  // manuscript, editorial and cover generation. Every entry below reaches
  // `runStagedLLM` (or the cover render queue) with a caller-chosen
  // providerId/model and no tool-free restriction, so a CLI/TUI provider or
  // runtime fallback runs as an approval-bypass agent over stored prose. Gate
  // the whole operation, including API-first requests, before any run, store
  // write, checkpoint, SSE attach or queue effect. Autopilot, resume and retry
  // reach the same services directly (not over HTTP) and are unaffected.
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

  // Caller-prompted AI outside Pipeline (#10908): each route hands free text
  // and/or a caller-chosen provider to `runPromptThroughProvider` with no
  // tool-free restriction, so a CLI/TUI provider (or a fallback to one) runs as
  // an approval-bypass agent. Gate the whole operation, before any provider
  // call, run record or file read. Record CRUD and reads in these families stay
  // open, and the neighbouring tool-free API-only routes are unaffected.
  'POST /api/games/:id/feedback',
  'POST /api/rounds/generate',
  'POST /api/rounds/:id/generate',
  'POST /api/rounds/:id/evaluate',
  'POST /api/rounds/:id/derive-parts',
  'POST /api/agents/personalities/generate',

  // Social-bot publication uses stored platform credentials (#11419). Guard
  // direct writes and the stores that arm or steer later scheduled writes.
  // Accounts/schedules are shared with Moltworld. Reads, private drafts and
  // deletions stay open; dedicated toggles gate only re-enabling in-handler.
  'POST /api/agents/tools/moltworld/join',
  'POST /api/agents/tools/moltworld/build',
  'POST /api/agents/tools/moltworld/explore',
  'POST /api/agents/tools/moltworld/think',
  'POST /api/agents/tools/moltworld/say',
  'POST /api/agents/tools/moltworld/queue',
  'POST /api/agents/tools/moltworld/ws/connect',
  'POST /api/agents/tools/moltworld/ws/move',
  'POST /api/agents/tools/moltworld/ws/think',
  'POST /api/agents/tools/moltworld/ws/nearby',
  'POST /api/agents/tools/moltworld/ws/interact',
  'POST /api/agents/tools/publish-post',
  'POST /api/agents/tools/publish-comment',
  'POST /api/agents/tools/engage',
  'POST /api/agents/tools/check-posts',
  'POST /api/agents/schedules',
  'PUT /api/agents/schedules/:id',
  'POST /api/agents/schedules/:id/run',
  'PUT /api/agents/personalities/:id',
  'POST /api/agents/accounts',
  'POST /api/agents/accounts/:id/claim',
  // Testing an account can promote it to active, admitting scheduled writes.
  'POST /api/agents/accounts/:id/test',

  'POST /api/system-resources/triage',
  'POST /api/mood-boards/:id/synthesize-style',
  'POST /api/mood-boards/:id/compose-prompt',
  'POST /api/mood-boards/:id/analyze',
  'POST /api/mood-boards/:id/generate',
  // A text note's render queues an image job on the caller-chosen backend,
  // including local Python (#13055), like generate above.
  'POST /api/mood-boards/:id/items/:itemId/render',
  // Storyboards (#12952): the plot and saved node prompts reach a
  // caller-chosen, non-tool-free provider; node runs, frame corrections, panel
  // draws and make-empty also queue image renders.
  'POST /api/storyboards/:id/beats/extract',
  'POST /api/storyboards/:id/panels/:panelId/make/:nodeId/run',
  'POST /api/storyboards/:id/panels/:panelId/correct',
  'POST /api/storyboards/:id/panels/:panelId/draw',
  'POST /api/storyboards/:id/make-empty',
  'POST /api/cos/tasks/enhance',
  // Music Video cover design/generation and promotion planning, and POST LLM
  // drills (#10989). Each hands free text and/or a caller-chosen provider to
  // the prompt runner (or an image job a CLI/TUI agent can run) with no
  // tool-free restriction. Cover compose, lettering PUT, thumbnail selection
  // and promotion GET only record or read. POST /api/meatspace/post/drill is
  // body-gated below so deterministic drills stay open.
  'POST /api/music-video/:id/publish-kit/cover-art/design',
  'POST /api/music-video/:id/publish-kit/cover-art/generate',
  'POST /api/music-video/:id/publish/promotion-plan',
  // Cover font upload copies the file into a host-wide font folder that every
  // application loads (macOS Library/Fonts/PortOS), so it is host control, not
  // a data upload. Listing, serving and deleting cover fonts stay open.
  'POST /api/music-video/publish/cover-fonts',
  'POST /api/meatspace/post/score-llm',
  'POST /api/meatspace/post/rhetoric/evaluate',
  'POST /api/meatspace/post/drill-cache/fill',

  // Calendar MCP sync/discovery (#11051) can launch a tool-capable CLI with
  // stored subcalendar text. Configuring that provider does not authorize a
  // network caller to run it. Direct API sync, push ingestion and CRUD stay open.
  'POST /api/calendar/sync/:accountId/google',
  'POST /api/calendar/sync/:accountId/discover',
  // Google OAuth auto-configure drives the operator's signed-in host browser
  // through Google Cloud Console and captures the client secret it creates;
  // the token test intercepts an Outlook bearer token. Same class as the gated
  // Messages Gmail enable helper and token test (#11433, #11449; #12952).
  'POST /api/calendar/google/auto-configure/start',
  'POST /api/calendar/google/auto-configure/capture',
  'POST /api/calendar/google/auto-configure/run',
  'POST /api/calendar/debug/test-token',

  // Writers Room authoring reaches the staged runner, including CLI/TUI
  // fallback. Stored prose and live cursor text are caller-controlled; a
  // configured provider or live-mode budget does not grant host authority.
  'POST /api/writers-room/works/:id/analysis',
  'POST /api/writers-room/works/:id/polish/start',
  'POST /api/writers-room/works/:id/live-suggest',
  'POST /api/writers-room/works/:id/cd-bridge/suggest',
  'POST /api/writers-room/works/:id/characters/:characterId/augment',

  // Autopilots and support requests that queue CoS agents.
  'POST /api/pipeline/series/:id/autopilot/start',
  'POST /api/fableloom/:id/editorial/autopilot/start',
  // Export preparation decodes authored media; download releases the resulting
  // private package. Both preserve authenticated delegated agent authority.
  'POST /api/fableloom/:id/export',
  'DELETE /api/fableloom/:id/export/:jobId',
  'GET /api/fableloom/:id/export/:jobId/download',
  'POST /api/image-video/models/support-request',

  // FableLoom authoring and production (#10668) can dispatch CLI/TUI agents,
  // including API-first fallback and deferred batch resume. Authorize before
  // service reads/writes, run creation or queues. Deterministic CRUD, validation,
  // shot application, continuity/production planning and cancellation remain
  // open under their existing contracts. fal.ai scene video drives the signed-in
  // browser and is gated with the pre-guard audit remainder (#13055).
  'POST /api/fableloom/:id/plan/generate',
  'POST /api/fableloom/:id/plan/review',
  'POST /api/fableloom/:id/plan/feedback',
  'POST /api/fableloom/:id/review-teleplay',
  'POST /api/fableloom/:id/editorial/remediate',
  'POST /api/fableloom/:id/playtest',
  'POST /api/fableloom/:id/episodes/:episodeId/weave',
  'POST /api/fableloom/:id/episodes/:episodeId/shots/plan',
  'POST /api/fableloom/:id/episodes/:episodeId/shots/start',
  'POST /api/fableloom/:id/episodes/:episodeId/outline/generate',
  'POST /api/fableloom/:id/episodes/:episodeId/outline/review',
  'POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/branch',
  'POST /api/fableloom/:id/episodes/:episodeId/review',
  'POST /api/fableloom/:id/episodes/:episodeId/feedback',
  'POST /api/fableloom/:id/episodes/:episodeId/play',
  'POST /api/fableloom/:id/episodes/:episodeId/reformat',
  'POST /api/fableloom/:id/episodes/:episodeId/production/batch',
  'POST /api/fableloom/:id/episodes/:episodeId/production/batch/:runId/resume',

  // Catalog generation (#10891): extraction, pruning and URL/file/voice/Brain
  // ingest hand caller-supplied text to a caller-chosen provider, which may be
  // a tool-capable CLI/TUI harness. Authorize the whole operation before the
  // scrap write, STT/network fetch, run creation or provider dispatch. Scrap and
  // ingredient CRUD, draft commit and reads stay open (data-only).
  'POST /api/catalog/scraps/:id/extract',
  'POST /api/catalog/scraps/:id/prune',
  'POST /api/catalog/ingest/url',
  'POST /api/catalog/ingest/file',
  'POST /api/catalog/ingest/voice',
  'POST /api/catalog/ingest/brain',
  // A catalog reference sheet queues the same image render as the universe
  // sheet route above, whose backend may be an agent harness (Codex). The
  // preview only builds text and stays open.
  'POST /api/catalog/ingredients/:id/sheets',
  // Greybox draft hands the place and the user's instruction to a caller-chosen
  // provider (possibly a tool-capable harness). Save and capture are data-only.
  'POST /api/catalog/ingredients/:id/greybox/draft',
  // New from prompt hands the user's prompt and the story's context to a
  // caller-chosen provider (possibly a tool-capable harness). Joining is data-only.
  'POST /api/catalog/stories/draft',
  'POST /api/catalog/ingredients/:id/refine',
  'POST /api/catalog/ingredients/:id/media/refine',
  // Design rounds: a caller-chosen provider writes face lines; renders queue
  // the same image backend as refinement.
  'POST /api/catalog/ingredients/:id/design/spread',
  'POST /api/catalog/ingredients/:id/design/render',

  // Importer, Brain and analytics AI (#11036): caller text, stored reference
  // data and a caller-chosen provider reach a non-tool-free runner. Authorize
  // before stores, run creation, queueing or dispatch. `POST /api/importer/commit`
  // is gated per body (cleanupFormatting) in COMPILED_BODY_ROUTES.
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

  // Eidoverse: clone and install a caller-named repo, or repoint it.
  'POST /api/settings/features/eidoverse/install',
  'PUT /api/settings/features/eidoverse/source',
  // Explicit local gameplay can speak in this machine's private world. Scoped
  // peer reachability does not grant it; operator/agent sessions retain access.
  'POST /api/eidoverse/world/controllers/:id/riddle',
  // Augment and say act in the private world as the owner-granted CoS
  // identity (#13055), the same authority as a riddle round.
  'POST /api/eidoverse/world/augment',
  'POST /api/eidoverse/world/say',

  // GitHub actions (#9013): mutating routes run `gh` with the user's GitHub
  // account and change external state. Syncing repos is read-only.
  'PUT /api/github/repos/:fullName',
  'POST /api/github/repos/:fullName/archive',
  'POST /api/github/repos/:fullName/unarchive',
  'PUT /api/github/secrets/:name',
  'POST /api/github/secrets/:name/sync',
  // Resolve with agent queues CoS agent work against the thread's app.
  'POST /api/github/notifications/:accountId/:threadId/agent',
  'POST /api/github/notifications/:accountId/:threadId/pull-request',
  // Notifications inbox (#12952): thread actions (and the learned rules an
  // operator action trains), audit apply and the undo routes write to the
  // account with `gh`; the schedule arms a CoS System task; account
  // create/edit pick the `gh` identity, mode, trust and allowed providers.
  'POST /api/github/notifications/:accountId/:threadId',
  'POST /api/github/notifications/clear-finished',
  // Approving a deployment can ship to production (#13198).
  'POST /api/github/notifications/:accountId/:threadId/deployment',
  'POST /api/github/audit/:accountId/apply',
  'POST /api/github/audit-changes/:id/undo',
  'POST /api/github/automations/activity/:id/undo',
  'PUT /api/github/automations/schedule',
  'POST /api/github/accounts',
  'PUT /api/github/accounts/:id',

  // Beeper outbox creation records approved send intent; send spends the
  // operator's saved connection, and breaker reset re-arms that capability.
  // First-contact confirmation and approved state do not establish caller
  // authority. History, discard and delivery reconciliation never send.
  'POST /api/beeper/outbox',
  'POST /api/beeper/outbox/:id/send',
  'POST /api/beeper/outbox/breaker/clear',

  // Jira instance updates can retain a saved API token while changing its
  // destination, so require operator authority before persisting the URL.
  'POST /api/jira/instances',

  // Jira writes act on the external tracker with the operator's saved account.
  // Gate before dispatch, including create's epic-link retry and sprint move.
  // Reads and local report generation retain their existing access policy.
  'POST /api/jira/instances/:id/tickets',
  'PUT /api/jira/instances/:instanceId/tickets/:ticketId',
  'POST /api/jira/instances/:instanceId/tickets/:ticketId/labels',
  'POST /api/jira/instances/:instanceId/tickets/:ticketId/comments',
  'POST /api/jira/instances/:instanceId/tickets/:ticketId/transition',
  'POST /api/jira/instances/:instanceId/sprints/:sprintId/issues',

  // Datadog instance updates can retain both saved keys while changing their
  // destination, so require operator authority before persisting the hostname.
  'POST /api/datadog/instances',

  // Self-update (#8742): runs git + npm and restarts the process, or `gh repo
  // sync` against the fork. `check` and `ignore`/DELETE-`ignore` only read or
  // record a preference — left open.
  'POST /api/update/execute',
  'POST /api/update/sync-fork',
  // Node runtime (nvm install + global pm2 + restart) and pm2 alignment.
  'POST /api/update/node-runtime',
  'POST /api/update/node-runtime/startup',
  'POST /api/update/pm2',

  // Brain links (#8742): git clone/pull in the linked repo, opening a host
  // app, or queuing a CoS malware-scan/repo-study agent. `buckets` CRUD,
  // `scan-report` and link CRUD only read or record; nothing runs. The one
  // exception is a repository URL that auto-clones: POST /api/brain/links
  // (unless `autoClone: false`) and a bare-repo-URL POST /api/brain/capture
  // start a clone and may arm post-clone scan/study agents. Links are gated per
  // request in their handler (`assertHostControl`, #11037) so a plain bookmark
  // stays open; capture is listed below whole (#11036) because it can also
  // dispatch classification.
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
  // Create names the repo — a local path is a host directory the weekly
  // reference-watch task runs git in and hands to that agent unattended, so
  // choosing it is operator work; a PATCH gates per body (repoUrl/branch).
  'POST /api/apps/:appId/reference-repos',
  'POST /api/apps/:appId/reference-repos/:refId/check',

  // Caller-named host paths (rationale in the header): the folder, source
  // tree or mailbox file each body names. Their record-only and upload-based
  // neighbours stay open.
  'POST /api/sharing/buckets',
  'POST /api/sprites/import',
  'POST /api/music-video/:id/composition/document/directory',
  'POST /api/timeline/import/gmail',

  // Persistent Mind lifecycle (#8742): starting/waking/resuming the mind arms
  // its own agentic loop, which can queue CoS tasks on its own initiative
  // (services/persistentMindTaskCapability.js) without further user action —
  // the same "arms unattended execution" reasoning as autopilot start.
  // `pause`/`stop` only reduce execution — left open.
  'POST /api/cos/mind/start',
  'POST /api/cos/mind/wake',
  'POST /api/cos/mind/resume',

  // Pre-guard audit, remainder (#13055): routes that were open when the
  // coverage guard landed and turned out to run host work when traced.
  //
  // ffmpeg/ffprobe over caller-supplied, uploaded, gallery or peer-pulled
  // media (the parser surface), like video last-frame and upscale/stitch.
  'POST /api/music-video/:id/analyze',
  'POST /api/music-video/:id/analyze/manual',
  'POST /api/music-video/:id/audio-timing/preview',
  'POST /api/music-video/:id/audio-timing/apply',
  'POST /api/music-video/:id/dependency-repairs',
  'POST /api/music-video/:id/production-review/proof',
  'POST /api/music-video/:id/revisions/:revisionId/resume',
  'POST /api/music-video/:id/scenes/:sceneId/continue-from-previous',
  'POST /api/music-video/:id/scenes/:sceneId/performance-repair',
  'POST /api/music-video/:id/sharing-copy',
  // Festival preview probes the selected master with ffprobe. Packet CRUD only stores text.
  'POST /api/music-video/:id/festival-packet/preview',
  'POST /api/music-video/:id/vocal-stem',
  // Song prepare and choosing a revised song also run Demucs separation and
  // lyric alignment in Python.
  'POST /api/music-video/:id/song/prepare',
  'POST /api/music-video/:id/song-revision/select',
  'POST /api/music-video/:id/song-revision/track',
  'POST /api/tracks/:id/audio/upload',
  'POST /api/tracks/:id/code/render',
  // The take's WAV comes from a container running caller SuperCollider code;
  // the chiptune and waveform renders encode audio PortOS synthesized itself.
  'POST /api/tracks/:id/supercollider/take',
  'POST /api/media/collections/:id/localize',
  'POST /api/mood-boards/:id/collage',
  'POST /api/mood-boards/:id/items/:itemId/extract-frames',
  'POST /api/sprites/:id/walk/postprocess',
  'POST /api/sprites/:id/walk/runs/:runId/source-frames/extract',
  'POST /api/sprites/:id/walk/trim',
  'PATCH /api/video-gen/history/:id/poster',
  'POST /api/video-gen/upload',
  // Headless composition browser (and ffmpeg encode), like the film-look bake.
  // Document zip import and accept stay open; their handler starts the
  // background overlay check only for a caller with host control.
  'POST /api/music-video/:id/production-review/text-check',
  'POST /api/code-animation/:id/export',
  'POST /api/code-animation/jobs/:id/poster',
  'POST /api/html-composition/render',
  // Local Python, Docker or PM2 work: a continuous-video episode's clip
  // renders and stitching, a checkpoint preview render, caller SuperCollider
  // source in a container, re-armed local video dispatch, the piper setup
  // script (it can brew install), and the PM2 health sweep, which restarts
  // errored processes. TTS synthesis on an installed runtime stays open as
  // configured inference, like local-llm test and Pipeline TTS.
  'POST /api/continuous-video',
  'POST /api/lora-training/runs/:id/promote-checkpoint',
  // Explicit retired-data removal uses the same operator authority as host maintenance.
  'POST /api/data-maintenance/preview',
  'POST /api/data-maintenance/execute',
  'POST /api/music/supercollider/render',
  'POST /api/media-jobs/holds/:holdId/resume',
  'POST /api/voice/piper/fetch',
  'POST /api/cos/health/check',
  // Host data and secrets: `tar` over the data directory (removing the archived
  // day files), the Signal Safe Storage keychain secret and the database it
  // decrypts (the GET setup check reads them too), and project files under a
  // caller-named directory.
  'POST /api/data/:category/archive',
  'POST /api/signal/sync',
  'GET /api/signal/setup-check',
  'POST /api/detect/repo',
  // Game publication writes asset bytes into the bound managed app's repo,
  // like chiptune and sprite atlas publication.
  'POST /api/games/:id/artwork/:bindingId/publish',
  'POST /api/games/:id/music/:bindingId/publish',
  // The operator's signed-in browser (#12488 rule): Suno, Pinterest, YouTube,
  // Spotify, fal.ai, Outlook/Teams token capture and scraping, and the broker
  // probes that put a privacy subject's details into broker pages.
  'POST /api/music-video/:id/song-style/suno',
  'POST /api/tracks/import/suno',
  'POST /api/mood-boards/:id/pinterest/import',
  'POST /api/youtube/sync',
  'POST /api/youtube/playlists/sync',
  'POST /api/digital-twin/import/spotify/browser/open',
  'POST /api/fableloom/:id/episodes/:episodeId/nodes/:nodeId/fal-video',
  'POST /api/calendar/sync/:accountId',
  'POST /api/messages/sync/:accountId',
  'POST /api/messages/:accountId/:messageId/refresh',
  'POST /api/messages/fetch-full/:accountId',
  'POST /api/privacy/scan',
  'POST /api/privacy/optout',
  'POST /api/privacy/optout/verify',
  // External account writes as the operator: Beeper chats, Google Calendar
  // goal time blocks, and approving a mail draft (the send intent the gated
  // send checks, like Beeper outbox create and X/Stacker News review).
  'POST /api/beeper/conversations',
  'POST /api/beeper/conversations/:id/archive',
  'POST /api/beeper/conversations/:id/low-priority',
  'POST /api/digital-twin/identity/goals/:id/schedule',
  'POST /api/digital-twin/identity/goals/:id/reschedule',
  'POST /api/messages/drafts/:id/approve',
  // Agent and LLM work: granted agent-context MCP tools (their HTTP twins are
  // gated), the Cast & Sets check-in that releases a waiting production run,
  // review prepare (direction and the shot planner), thumbnail paint (an image
  // job), custom editorial check instructions sent to a CLI/TUI-capable
  // runner, and the Writers Room handoff, which writes a Creative Director
  // project and treatment.
  'POST /api/agent-context/mcp',
  'POST /api/music-video/:id/cast-and-sets/approve',
  'POST /api/music-video/:id/cast-and-sets/skip',
  'POST /api/music-video/:id/production-review/prepare',
  'POST /api/music-video/:id/publish-kit/youtube-thumbnail/paint',
  'POST /api/pipeline/editorial/custom-checks',
  'PATCH /api/pipeline/editorial/custom-checks/:id',
  'POST /api/writers-room/works/:id/cd-bridge/send',
  // Execution policy: a social persona and its provider pins (its PUT twin is
  // gated), and resets that put held agent work back into rotation — the review
  // cooldown, task-type learning (reset returns a type to the auto-approved
  // tier, backfill re-records every run) and schedule failure/drain parks.
  // A manual sync snapshot apply can replace Digital Twin personas.
  'POST /api/agents/personalities',
  'POST /api/cos/app-activity/:appId/clear-cooldown',
  'POST /api/cos/learning/reset/:taskType',
  'POST /api/cos/learning/backfill',
  'POST /api/cos/schedule/reset',
  'POST /api/sync/:category/apply',
  // Eidoverse: travel spends this install's pair credential to admit the
  // owner as a guest elsewhere; world config chooses who the CoS presence
  // grants ownership to and what it publishes; controller config is what an
  // armed controller says or builds unattended, as the CoS identity.
  'POST /api/eidoverse/travel/depart',
  'PUT /api/eidoverse/world/config',
  'PATCH /api/eidoverse/world/controllers/:id/config',

  // GET routes the process-reach trace found starting host work (#13097): the
  // dependency-impact preview decodes the current song master with ffmpeg to
  // compare sung windows, and the YouTube setup check opens or reuses a tab in
  // the signed-in managed browser and reads it (#12488 rule); the sharing
  // download re-encodes the video with ffmpeg on every request (it keeps no
  // cached copy, #13156).
  'GET /api/music-video/:id/dependency-impact',
  'GET /api/video-gen/history/:id/sharing-download',
  'GET /api/youtube/setup-check',
]);

/**
 * `PUT /api/settings` slices that set what runs or the guardrails around it:
 * Autofixer repair policy, Docker containment images/egress, harness enablement and wrapper CLIs, the Code Animation worker tools, the
 * code-review chain, the untrusted content screen in front of agent work,
 * scheduled self-update, scheduled series autopilots, and backup destination/
 * recovery policy, and whole-root voice policy replacement. The store is
 * polymorphic, so its other slices stay open.
 */
export const HOST_CONTROL_SETTINGS_SLICES = Object.freeze([
  // The semantic actions (Brain capture, Eidoverse augment/say, tool
  // recipes) the agent-context MCP may run for local agents (#13055).
  'agentContext',
  'autoUpdate',
  // Deferred repair policy: verifyCommand runs a shell and autoPromote can
  // apply the repair to the live checkout. Provider pins also select its agent.
  'autofixer',
  // Destination, schedule, exclusions and retention control private copies
  // and recovery durability, including writes consumed later by the scheduler.
  'backup',
  'codeAnimationExecution',
  'codeReview',
  'credentialBootstraps',
  // Image overrides pick what untrusted code runs in; extra hosts widen install egress.
  'dockerContainment',
  'harnesses',
  // `privacy.recheck` arms the scheduled broker passes and their autonomy,
  // the same change as the gated PUT /api/privacy/optout/schedule (#13055).
  'privacy',
  'seriesAutopilot',
  'telegram',
  'untrustedContent',
  'voice',
]);

/**
 * Nested settings mutation keys, as dotted paths, that choose a binary
 * PortOS spawns (the image-gen CLIs and the Python interpreter every local
 * media lane runs), turn the Layered Intelligence `cmd` sources into a
 * full shell (#8751), pick an outbound endpoint PortOS sends prompts or a
 * stored token to, or pick the host file a store reads and rewrites. Their parent slices stay open, so each is gated per
 * CHANGED value rather than per presence: the Image Gen tab resends the whole
 * slice, stored paths included, on every save, and a remote caller changing
 * only an aspect ratio must still be able to save it. A body that omits or
 * clears one (`''`, `null`, `false`) reverts it to the built-in default —
 * the shallow settings merge drops an omitted key, and every reader treats a
 * cleared value as unset — so neither is gated.
 */
export const HOST_CONTROL_SETTINGS_PATHS = Object.freeze([
  'beeper.allowNonLoopbackBaseUrl',
  'beeper.baseUrl',
  'imageGen.agy.agyPath',
  'imageGen.codex.codexPath',
  'imageGen.external.sdapiUrl',
  'imageGen.grok.grokPath',
  'imageGen.local.pythonPath',
  'imageGen.sdapiUrl',
  'layeredIntelligence.trustShellSources',
  'mortalloom.path',
]);

/**
 * `PUT /api/voice/config` fields that become the voice agent's instructions,
 * arm its coding-agent tool (#10990), or choose the endpoint that receives the
 * operator's microphone audio and supplies the transcript the agent acts on. The Voice settings tab resends the
 * whole config on every save, so these are gated per CHANGED value: a remote
 * caller who only changes the TTS rate must still be able to save.
 * `llm.personality` and `llm.codeAgent` compare as whole objects.
 */
export const HOST_CONTROL_VOICE_CONFIG_PATHS = Object.freeze([
  'llm.systemPrompt',
  'llm.personality',
  'llm.tools.enabled',
  'llm.codeAgent',
  'stt.endpoint',
  // What the voice runtime reconcile starts, installs or reads (#13055): the
  // PM2 whisper-server and its engine, the setup script's Core ML and piper
  // installs, and the host model and voice paths. The handler reconciles only
  // for a caller with host control, so every other key stays a record.
  'enabled',
  'stt.engine',
  'stt.coreml',
  'stt.modelPath',
  'tts.engine',
  'tts.piper.voicePath',
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
  // Song revision replanning uses the tool-capable shot planner. The other
  // actions (remove/dismiss) edit records without dispatching a provider.
  ['POST /api/music-video/:id/song-revision/scenes', (body) => body?.action === 'replan' ? ['action'] : []],
  // Enabling this feature now launches its registered host executable.
  ['PUT /api/settings/features/eidoverse', (body) => bodyKeys(body)],
  ['POST /api/local-llm/capability-tests/run', (body) => body?.testId === 'sandbox-repair' ? ['testId'] : []],
  ['PATCH /api/settings/slice', (body) => HOST_CONTROL_SETTINGS_SLICES.includes(body?.slicePath) ? [body.slicePath] : []],
  ['PUT /api/settings', (body) => bodyKeys(body).filter((key) => HOST_CONTROL_SETTINGS_SLICES.includes(key)
    || (key === 'instanceFeatures' && body.instanceFeatures?.eidoverse !== undefined))],
  ['PUT /api/cos/config', (body) => bodyKeys(body).filter((key) => !HOST_CONTROL_OPEN_COS_CONFIG_KEYS.includes(key))],
  // Review facade (#10890): the `cos:` source approves a CoS task under any
  // operation spelling, including the omitted legacy default; Ask promotion to
  // `task` queues a user task. Both match their gated direct routes. Other
  // sources, triage and Brain/Goal promotion stay data-only and open.
  // A `drafts:` row approves a message draft, the gated draft approve (#13055).
  ['POST /api/review/queue/resolve', (body) => /^\s*(cos|drafts):/i.test(body?.id) ? ['id'] : []],
  ['POST /api/review/queue/promote-ask', (body) => body?.target === 'task' ? ['target'] : []],
  // LLM drill types reach a caller-chosen provider (#10989). Math, memory and
  // cognitive types stay open, including a missing or unknown type.
  ['POST /api/meatspace/post/drill', (body) => LLM_DRILL_TYPES.includes(body?.type) ? ['type'] : []],
  // Importer commit runs one LLM reformat call per excerpt only when asked to
  // (#11036); the default deterministic commit stays open.
  ['POST /api/importer/commit', (body) => body?.cleanupFormatting === true ? ['cleanupFormatting'] : []],
  // A reference-repo PATCH that re-points the repo or branch chooses what the
  // scheduled reference-watch runs git in; name, notes and the reviewed SHA
  // are records.
  ['PATCH /api/apps/:appId/reference-repos/:refId', (body) => ['repoUrl', 'branch'].filter((key) => body?.[key] !== undefined)],
  // SynthID regen (#13055): the default flux method queues a local Python
  // img2img job; the light method is an in-process sharp pass and stays open.
  ['POST /api/image-gen/:filename/regenerate', (body) => body?.method === 'light' ? [] : ['method']],
  // A code-animation prompt that studies a reference video runs ffmpeg over
  // it (#13055); a prompt without one only reads records.
  ['POST /api/code-animation/prompt', (body) => body?.referenceVideo ? ['referenceVideo'] : []],
  // Pre-guard audit, remainder (#13055). Each gates only the named value; the
  // rest of the body is records, and disarming or disabling stays open except
  // where disabling itself tears down host executables (Docker containment
  // here, and the voice runtime through HOST_CONTROL_VOICE_CONFIG_PATHS).
  // Toggling Docker containment either way runs the docker CLI and removes
  // containers, networks and volumes, like the eidoverse toggle above.
  ['PUT /api/settings/features/docker-containment', (body) => bodyKeys(body)],
  // Enabling a subscription family re-enables its provider records, the gated
  // provider-edit change.
  ['PUT /api/usage/subscriptions/enabled', (body) => body?.enabled === true ? ['enabled'] : []],
  // The automation brief (agent guidance, LLM pins, image tools, Cast & Sets
  // auto-approval) steers unattended Music Video runs.
  ['POST /api/music-video', (body) => body?.automation != null ? ['automation'] : []],
  ['PATCH /api/music-video/:id', (body) => body?.automation != null ? ['automation'] : []],
  // Approving the Cast & Sets sheet is the check-in's Approve & continue.
  ['POST /api/music-video/:id/dev-artifacts/:artifactId/review', (body) => body?.status === 'approved' ? ['status'] : []],
  // A restore re-applies archived Creative Director instructions and provider
  // pins, or a commission whose kept schedule re-arms its runs; discard only
  // removes the snapshot.
  ['POST /api/conflict-journal/:id/resolve', (body) => body?.action === 'discard' ? [] : ['action']],
  // Whisper start launches whisper-server under PM2.
  ['POST /api/voice/whisper', (body) => body?.action === 'start' ? ['action'] : []],
  // Approval records send intent for the gated send; content edits drop it.
  ['PUT /api/messages/drafts/:id', (body) => body?.status === 'approved' ? ['status'] : []],
  // Arming the privacy recheck, changing its cron, or turning on autonomous
  // opt-out email approval or web-form submission.
  ['PUT /api/privacy/optout/schedule', (body) => ['enabled', 'autoApproveOptOutEmails', 'autoSubmitWebForms']
    .filter((key) => body?.[key] === true)
    .concat(typeof body?.cronExpression === 'string' ? ['cronExpression'] : [])],
  // A broker scan or opt-out purpose adds the subject to the armed broker
  // passes and authorizes disclosing their details to brokers.
  ['POST /api/privacy/subjects/:id/consents', (body) => ['broker_scan', 'broker_optout'].includes(body?.scope) ? ['scope'] : []],
  // A delivering controller speaks or builds in the private world as the CoS
  // identity on its own schedule, like say/augment; re-arming resumes that.
  ['POST /api/eidoverse/world/controllers', (body) => body?.deliverEffects === true ? ['deliverEffects'] : []],
  ['PATCH /api/eidoverse/world/controllers/:id', (body) => body?.armed === true ? ['armed'] : []],
].map(([route, pick]) => ({ ...compileRoute(route), pick }));

const bodyRouteEntry = (method, path) => (
  typeof method === 'string' && typeof path === 'string'
    ? COMPILED_BODY_ROUTES.find((entry) => entry.method === method.toUpperCase() && entry.pattern.test(path))
    : undefined
);

/** The per-body gated route that `method path` matches, or null. */
export const hostControlBodyRouteFor = (method, path) => bodyRouteEntry(method, path)?.route ?? null;

/** The host-control keys a request body names, for `method path` of a policy store; [] elsewhere. */
export const hostControlBodyKeys = (method, path, body) => bodyRouteEntry(method, path)?.pick(body) ?? [];

const valueAt = (object, path) => path.split('.').reduce(
  (node, key) => (isPlainObject(node) && Object.hasOwn(node, key) ? node[key] : undefined),
  object,
);

// Each listed key's readers fall back to the built-in default on any of these.
const isUnset = (value) => value === undefined || value === null || value === '' || value === false;

const SETTINGS_WRITE = compileRoute('PUT /api/settings');
const SETTINGS_SLICE_WRITE = compileRoute('PATCH /api/settings/slice');

// Project the allowlisted one/two-segment slice payload into the same shape
// the legacy PUT gate compares. Invalid paths are rejected by route validation.
const settingsBody = (method, path, body) => {
  if (method?.toUpperCase() !== SETTINGS_SLICE_WRITE.method || !SETTINGS_SLICE_WRITE.pattern.test(path)) return body;
  if (typeof body?.slicePath !== 'string') return {};
  const segments = body.slicePath.split('.');
  if (segments.length > 2 || segments.some((key) => !key || POLLUTING_KEYS.has(key))) return {};
  return segments.reduceRight((value, key) => ({ [key]: value }), body.partial);
};

/** The executable settings paths set by PUT or a slice PATCH; [] elsewhere. */
export const hostControlSettingsPathsIn = (method, path, body) => (
  typeof method === 'string' && typeof path === 'string'
  && [SETTINGS_WRITE, SETTINGS_SLICE_WRITE].some((entry) => method.toUpperCase() === entry.method && entry.pattern.test(path))
    ? HOST_CONTROL_SETTINGS_PATHS.filter((key) => !isUnset(valueAt(settingsBody(method, path, body), key)))
    : []
);

/** Of `paths`, the ones whose value in `body` differs from the stored `current` settings. */
export const changedHostControlSettingsPaths = (paths, body, current, method = 'PUT', path = '/api/settings') => (
  paths.filter((key) => !Object.is(valueAt(settingsBody(method, path, body), key), valueAt(current, key)))
);

const VOICE_CONFIG_WRITE = compileRoute('PUT /api/voice/config');
const VOICE_CONFIG_DEEP_PATHS = new Set(['llm.personality', 'llm.codeAgent']);

/** The HOST_CONTROL_VOICE_CONFIG_PATHS present on a `PUT /api/voice/config` body; [] elsewhere. */
export const voiceConfigHostControlPathsIn = (method, path, body) => (
  typeof method === 'string' && typeof path === 'string'
  && method.toUpperCase() === VOICE_CONFIG_WRITE.method && VOICE_CONFIG_WRITE.pattern.test(path)
    ? HOST_CONTROL_VOICE_CONFIG_PATHS.filter((key) => valueAt(body, key) !== undefined)
    : []
);

/** Of `paths`, the ones whose voice-config value in `body` differs from stored `current`. Objects compare structurally. */
export const changedVoiceConfigHostControlPaths = (paths, body, current) => (
  paths.filter((key) => {
    const next = valueAt(body, key);
    const prev = valueAt(current, key);
    return VOICE_CONFIG_DEEP_PATHS.has(key)
      ? canonicalStringify(next) !== canonicalStringify(prev)
      : !Object.is(next, prev);
  })
);

/** The HOST_CONTROL_ROUTES entry that `method path` (an Express `req.method` / `req.path`) matches, or null. */
export const hostControlRouteFor = (method, path) => {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return COMPILED_ROUTES.find((entry) => entry.method === verb && entry.pattern.test(path))?.route ?? null;
};

/** Whether `method path` executes on the host. */
export const isHostControlRoute = (method, path) => hostControlRouteFor(method, path) !== null;
