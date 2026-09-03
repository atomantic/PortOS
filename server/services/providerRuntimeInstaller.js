/**
 * Provider runtime (CLI) availability, installation, update and removal — the
 * registry behind **Models → Harnesses** (`services/harnesses.js` composes this
 * with the provider records that point at each one).
 *
 * A CLI/TUI provider is only as usable as the binary it shells out to, so the
 * AI Providers page asks this module "is `codex` runnable, and can PortOS
 * install it for you?" per provider card. Generalized from the OpenCode-only
 * installer (#4143 follow-up) so every provider whose runtime PortOS can
 * install gets the same small status + Install affordance instead of one
 * hard-coded banner for OpenCode.
 *
 * The Providers page owns the user gesture; this module exposes only a fixed
 * per-runtime invocation from the table below, never a user-supplied package,
 * URL, or command. A request names a runtime *id* — anything not in the table
 * is rejected before a child is spawned — which keeps the install surface as
 * narrow as the agent runner's command allowlist while letting a missing CLI
 * become self-service.
 *
 * The binary each row installs comes from `PROVIDER_VENDORS` rather than a
 * second hand-typed list of CLI names (#3618's rule — one vendor row, not N
 * copies); `providerRuntimeInstaller.test.js` fails if a vendor ever lands
 * there without an install row here.
 *
 * Install kinds:
 *   - `npm`    — one fixed `npm install --global <package>`.
 *   - `script` — the vendor's own published POSIX install script, piped to bash
 *                (the same shape `localLlm.js` uses for Ollama on Linux). This
 *                *is* remote code by design: it's the install path these two
 *                vendors publish, and no request value reaches the command. Not
 *                offered on Windows, where they ship a separate PowerShell
 *                script PortOS deliberately does not run for the user.
 *
 * Ollama and LM Studio are deliberately absent: the Models → LLMs page owns
 * their install (it also starts the service afterwards, and knows that a macOS
 * app bundle with no `lms` shim still counts as installed). The Providers page
 * links there for those two instead of re-probing them here.
 */

import { spawn } from '../lib/childProcess.js';
import { killProcessTree, prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { commandOutput } from '../lib/commandExists.js';
import { parseHarnessVersion } from '../lib/harnessOutput.js';
import { adoptNpmGlobalBinDir } from '../lib/npmGlobalBin.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { PROVIDER_VENDORS } from '../lib/providerVendors.js';

const IS_WIN = process.platform === 'win32';

/**
 * Flags shared by every global npm runtime install.
 *
 * PortOS pins ignore-scripts=true in its project .npmrc, and these installs run
 * from the PortOS working directory. Every one of these CLIs ships its runnable
 * binary from a postinstall script, so opt in explicitly for these fixed,
 * user-triggered package installs — which is what the same command in the
 * user's own shell would do — rather than weakening the repo default for every
 * dependency.
 *
 * npm's carriage-return progress renderer can emit hundreds of repaint frames
 * per second, and the installer streams stdout to the browser — `--no-progress`
 * keeps the useful package messages without turning the modal into a re-render
 * storm.
 */
export const NPM_GLOBAL_INSTALL_FLAGS = Object.freeze([
  'install',
  '--global',
  '--ignore-scripts=false',
  '--no-progress',
]);

/** The host tool each install kind shells out through. */
const INSTALL_TOOL = Object.freeze({ npm: 'npm', script: 'curl' });

/**
 * How long a probed status stays good. Availability changes only when someone
 * installs, upgrades, or removes a CLI, and probing is expensive: each runtime
 * costs a PATH scan plus a `--version` child process, and the bundled-JS CLIs
 * take seconds to answer. The AI Providers page reloads its whole payload after
 * every provider mutation (enable, save, delete, add-sample), so without this a
 * single toggle re-spawns every CLI on the host. Same shape and reasoning as
 * `getReviewerCliInstalled()`'s cache in `codeReview.js`.
 */
const STATUS_TTL_MS = 60_000;

/**
 * Matches `codeReview.js`'s `REVIEWER_CLI_PROBE_TIMEOUT_MS` for these same
 * binaries: `commandOutput`'s 5s default is sized for lightweight tools like
 * `brew --version` and previously clocked the heavier agentic CLIs as falsely
 * uninstalled under a cold start — which here would offer an install for a CLI
 * that is already there.
 */
const PROBE_TIMEOUT_MS = 15_000;

/** One row per installable provider runtime, keyed by its vendor row. */
const RUNTIME_ROWS = [
  {
    vendor: 'claude',
    label: 'Claude Code CLI',
    install: { kind: 'npm', package: '@anthropic-ai/claude-code@latest' },
    selfUpdate: ['update'],
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  {
    vendor: 'codex',
    label: 'Codex CLI',
    install: { kind: 'npm', package: '@openai/codex@latest' },
    selfUpdate: ['update'],
    docsUrl: 'https://developers.openai.com/codex/cli',
  },
  {
    vendor: 'opencode',
    label: 'OpenCode CLI',
    install: { kind: 'npm', package: 'opencode-ai@latest' },
    selfUpdate: ['upgrade'],
    modelsArgs: ['models'],
    docsUrl: 'https://opencode.ai/docs',
  },
  {
    vendor: 'grok',
    label: 'Grok Build CLI',
    install: { kind: 'npm', package: '@xai-official/grok@latest' },
    selfUpdate: ['update'],
    modelsArgs: ['models'],
    docsUrl: 'https://x.ai/cli',
  },
  {
    vendor: 'kimi',
    label: 'Kimi Code CLI',
    install: { kind: 'npm', package: '@kimi-code/cli@latest' },
    selfUpdate: ['upgrade'],
    docsUrl: 'https://moonshotai.github.io/kimi-cli/',
  },
  {
    vendor: 'antigravity',
    label: 'Antigravity CLI',
    // `agy` is the canonical binary, but `isAntigravityCommand` also accepts a
    // provider configured as `antigravity` — publish that spelling too so such a
    // card still finds its runtime. Pinned by the alias test.
    aliases: ['antigravity'],
    // Antigravity ships a single compiled binary, not an npm package.
    install: { kind: 'script', url: 'https://antigravity.google/cli/install.sh' },
    selfUpdate: ['update'],
    modelsArgs: ['models'],
    docsUrl: 'https://antigravity.google/docs/cli/install',
  },
  {
    vendor: 'cursor',
    label: 'Cursor Agent CLI',
    install: { kind: 'script', url: 'https://cursor.com/install' },
    selfUpdate: ['update'],
    // `cursor-agent models` prints the authoritative catalog for THIS account —
    // the toolkit's provider-card refresh has read it for far longer than this
    // page has existed (`_fetchCursorModels`), so the parser was already there.
    modelsArgs: ['models'],
    docsUrl: 'https://cursor.com/docs/cli/installation',
  },
];

const vendorCommand = (vendorId) => {
  const command = PROVIDER_VENDORS.find((vendor) => vendor.id === vendorId)?.inferredCommand;
  // A renamed vendor row must fail loudly at boot, not silently drop a card's
  // install button.
  if (!command) throw new Error(`providerRuntimeInstaller: no PROVIDER_VENDORS row for "${vendorId}"`);
  return command;
};

/**
 * The runtime table the routes serve. `id` IS the binary name, so a provider
 * card looks its runtime up straight from its `command` with no second mapping.
 *
 * `selfUpdate`, `modelsArgs` and `npmPackage` are the harness-management half
 * (Models → Harnesses): `selfUpdate` is the vendor's OWN updater subcommand,
 * which is the only correct update path for a binary the user installed some
 * other way (Homebrew, the vendor script) — re-running `npm install --global`
 * would write a second copy that may not even win on PATH, which is exactly how
 * an install goes stale with no visible way to refresh it. `npmPackage` is
 * present only for `npm`-kind rows, and it is what makes a row REMOVABLE: a
 * script-installed binary has no vendor-published uninstall PortOS can run.
 */
export const PROVIDER_RUNTIMES = Object.freeze(RUNTIME_ROWS.map((row) => Object.freeze({
  aliases: [],
  selfUpdate: null,
  modelsArgs: null,
  ...row,
  // `@latest` is an install-time tag, not part of the package identity, and
  // `npm view`/`npm uninstall` both want it gone.
  npmPackage: row.install.kind === 'npm' ? row.install.package.replace(/@latest$/, '') : null,
  id: vendorCommand(row.vendor),
  command: vendorCommand(row.vendor),
})));

// Keyed by the canonical id AND by every accepted alias spelling of the same
// binary, so a provider configured as `antigravity` resolves the `agy` row.
const RUNTIMES_BY_ID = new Map(PROVIDER_RUNTIMES.flatMap((runtime) => [
  [runtime.id, runtime],
  ...runtime.aliases.map((alias) => [alias, runtime]),
]));

// id → { at, status }
const statusCache = new Map();

/** The runtime row for an id, or `null` for anything not in the table. */
export function getProviderRuntime(id) {
  return (typeof id === 'string' && RUNTIMES_BY_ID.get(id)) || null;
}

async function probeRuntimeStatus(runtime, findCommand, probeCommand) {
  const kind = runtime.install.kind;
  const tool = INSTALL_TOOL[kind];

  // Boot adopts this already; repeat it here because the install route probes
  // again straight after `npm install --global`, and on a first install the
  // prefix directory did not exist when boot looked. Cached and idempotent.
  await adoptNpmGlobalBinDir();

  const [resolved, toolPath] = await Promise.all([findCommand(runtime.command), findCommand(tool)]);

  // `where <cmd>` can select npm's extensionless POSIX shim before the working
  // `.cmd` wrapper on Windows. The filesystem resolver gives us the real
  // executable; prepareCliSpawn then probes that same safe launch shape.
  const versionProbe = resolved ? prepareCliSpawn(resolved, ['--version']) : null;
  // ONE probe contract: `commandOutput` answers the `--version` banner as a
  // STRING, or `null` when the binary could not run. Availability and version
  // both come from that single child — `parseHarnessVersion` already answers
  // `null` for a banner it cannot read, which is NOT-KNOWN rather than "out of
  // date". Keyed on `typeof === 'string'` rather than `!== null` so anything
  // outside the contract (an injected probe answering a bare boolean) fails
  // SAFE as not-installed instead of reporting a `false` as present.
  const probed = versionProbe
    ? await probeCommand(versionProbe.command, versionProbe.args, { timeoutMs: PROBE_TIMEOUT_MS })
    : null;
  const installed = typeof probed === 'string';
  const version = parseHarnessVersion(probed);

  // Windows-only gap: the script-installed vendors publish a PowerShell
  // installer there, which PortOS deliberately does not run for the user.
  const windowsScriptOnly = kind === 'script' && IS_WIN;
  const installable = Boolean(toolPath) && !windowsScriptOnly;
  const blockedReason = installable ? null
    : windowsScriptOnly
      ? `${runtime.label} installs from a PowerShell script on Windows. Follow the vendor instructions, then reload this page.`
      : `${tool} is not available on PortOS's PATH, so this host cannot install ${runtime.label} from this page.`;

  return {
    id: runtime.id,
    label: runtime.label,
    command: runtime.command,
    installed,
    // `null` = the banner did not parse (or the probe answered a bare boolean),
    // NOT "0.0.0". Every version comparison bails on it rather than reporting a
    // perfectly current harness as out of date.
    version,
    method: kind,
    installable,
    blockedReason,
    docsUrl: runtime.docsUrl,
    // Harness-management capabilities, published so the page can render a
    // button per row instead of keeping its own copy of this table.
    updatable: Boolean(runtime.selfUpdate) || (kind === 'npm' && Boolean(toolPath)),
    removable: Boolean(runtime.npmPackage) && Boolean(toolPath),
    listsModels: Boolean(runtime.modelsArgs),
  };
}

/**
 * Report only runnable availability, never the discovered absolute paths.
 * Paths can contain the machine account name and are not useful to the browser;
 * the booleans are the exact questions the Providers page needs answered.
 *
 * `installable` is "can PortOS run this install right now" — false when the
 * required tool is missing (npm, curl) or the platform has no supported script
 * — and `blockedReason` says why, so the card can explain a disabled button
 * instead of failing at click time.
 *
 * Pass `fresh: true` to bypass the TTL cache. The install route must, on both
 * sides of the install: a cached "installed" would skip an install the user
 * still needs, and a cached pre-install probe would fail the post-install
 * verification of a CLI that is now perfectly runnable.
 */
export async function getProviderRuntimeStatus(id, { findCommand, probeCommand, fresh = false } = {}) {
  const runtime = getProviderRuntime(id);
  if (!runtime) return null;
  // Keyed by the canonical id, so an alias spelling shares the same entry
  // instead of probing the same binary twice.
  const cached = statusCache.get(runtime.id);
  if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const status = await probeRuntimeStatus(runtime, findCommand || findCommandOnPath, probeCommand || commandOutput);
  statusCache.set(runtime.id, { at: Date.now(), status });
  return status;
}

/**
 * Every runtime's status, keyed by id — one round trip for the Providers page.
 * An aliased runtime appears under every accepted spelling of its command,
 * sharing one status object: the page looks a card's runtime up by the command
 * the provider is configured with, which may be an alias.
 */
export async function getProviderRuntimeStatuses(deps = {}) {
  // One PATH scan per distinct binary for the whole batch: five rows resolve
  // `npm` and two resolve `curl`, and the resolver hits the filesystem.
  const findCommand = memoizePerBatch(deps.findCommand || findCommandOnPath);
  const statuses = await Promise.all(
    PROVIDER_RUNTIMES.map((runtime) => getProviderRuntimeStatus(runtime.id, { ...deps, findCommand })),
  );
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return Object.fromEntries(PROVIDER_RUNTIMES.flatMap((runtime) => {
    const status = byId.get(runtime.id);
    return [[runtime.id, status], ...runtime.aliases.map((alias) => [alias, status])];
  }));
}

/**
 * The runtime statuses currently cached, read SYNCHRONOUSLY — no PATH scan, no
 * child process, no promise. For a caller that must answer "is this binary
 * here?" inside a synchronous decision (fallback-provider routing, via
 * `services/providerPrerequisites.js`) and cannot await the real probe.
 *
 * Returns `{}` when nothing is cached, and a per-id status object otherwise,
 * aliases included — so a caller that finds NO entry for its runtime reads "not
 * probed", never "not installed".
 *
 * Honors the same TTL as the async path, which matters in one direction
 * specifically: a cached `installed: false` that has aged out must stop being
 * an answer. Otherwise a user who installs the CLI from a terminal stays
 * skipped by routing until something else happens to re-probe — an expiry is
 * "we no longer know", and the caller's response to not-knowing is to route
 * normally and kick a refresh.
 */
export function peekProviderRuntimeStatuses() {
  const now = Date.now();
  const byId = {};
  for (const runtime of PROVIDER_RUNTIMES) {
    const cached = statusCache.get(runtime.id);
    if (!cached || now - cached.at >= STATUS_TTL_MS) continue;
    byId[runtime.id] = cached.status;
    for (const alias of runtime.aliases) byId[alias] = cached.status;
  }
  return byId;
}

function memoizePerBatch(findCommand) {
  const seen = new Map();
  return (command) => {
    if (!seen.has(command)) seen.set(command, findCommand(command));
    return seen.get(command);
  };
}

/** Test-only: drop cached statuses so the next read re-probes. */
export function __resetRuntimeStatusCache() {
  statusCache.clear();
}

/**
 * The one supported install invocation for a runtime, as an argv pair. Built
 * entirely from the table above — no request value reaches a shell word.
 */
export function buildRuntimeInstallCommand(id) {
  const runtime = getProviderRuntime(id);
  if (!runtime) return null;
  if (runtime.install.kind === 'npm') {
    return { command: 'npm', args: [...NPM_GLOBAL_INSTALL_FLAGS, runtime.install.package] };
  }
  // `-fsSL` keeps curl quiet on success and non-zero on an HTTP error, so a 404
  // page can't be piped into bash as a script. POSIX only — a Windows
  // enablement would need `resolveBashBinary()` (`server/lib/bashResolver.js`),
  // since a bare `bash` there resolves to WSL.
  return { command: 'bash', args: ['-c', `curl -fsSL ${runtime.install.url} | bash`] };
}

/**
 * The one supported UPDATE invocation for a runtime, as an argv pair, or `null`
 * for an id not in the table.
 *
 * The vendor's own updater wins whenever it ships one, because it is the only
 * path that refreshes the copy the user ACTUALLY has: PortOS can install
 * OpenCode from npm, but a user who installed it from Homebrew or the vendor
 * script has a binary npm has never heard of, and `npm install --global` would
 * write a second copy that may not even win on PATH — leaving the stale one
 * running and no visible way to refresh it (the gap this page exists to close).
 * `opencode upgrade` updates whichever copy is on PATH, whoever installed it.
 *
 * An npm-kind row with no self-updater falls back to re-running the pinned
 * `@latest` install, which IS an update for a package manager.
 */
export function buildRuntimeUpdateCommand(id) {
  const runtime = getProviderRuntime(id);
  if (!runtime) return null;
  if (runtime.selfUpdate) return { command: runtime.command, args: [...runtime.selfUpdate] };
  if (runtime.install.kind === 'npm') return buildRuntimeInstallCommand(id);
  return null;
}

/**
 * The one supported REMOVE invocation, or `null` when PortOS must not offer
 * one. Only npm-kind rows qualify: a script-installed binary (Antigravity,
 * Cursor) has no vendor-published uninstall PortOS could run, and guessing at
 * `rm` paths for a binary this module deliberately never discloses is not a
 * removal, it's a deletion of whatever happened to be at a path.
 */
export function buildRuntimeUninstallCommand(id) {
  const runtime = getProviderRuntime(id);
  if (!runtime?.npmPackage) return null;
  return { command: 'npm', args: ['uninstall', '--global', '--no-progress', runtime.npmPackage] };
}

/** The argv builder for each supported harness action. */
const ACTION_BUILDERS = Object.freeze({
  install: buildRuntimeInstallCommand,
  update: buildRuntimeUpdateCommand,
  uninstall: buildRuntimeUninstallCommand,
});

/** The harness actions the routes accept — anything else is rejected unspawned. */
export const RUNTIME_ACTIONS = Object.freeze(Object.keys(ACTION_BUILDERS));

/**
 * The fixed invocation for one runtime action, or `null` when the action is
 * unknown or this runtime does not support it. Every argv comes from the table
 * above; no request value reaches a shell word.
 */
export function buildRuntimeActionCommand(id, action = 'install') {
  const build = Object.hasOwn(ACTION_BUILDERS, action) ? ACTION_BUILDERS[action] : null;
  return build ? build(id) : null;
}

/** A human-readable one-liner for the install log ("Running npm install …"). */
export function describeRuntimeInstall(id, action = 'install') {
  const invocation = buildRuntimeActionCommand(id, action);
  return invocation ? `${invocation.command} ${invocation.args.join(' ')}` : null;
}

/**
 * Start a runtime's fixed install command with no request input in its argv.
 * `prepareCliSpawn` handles npm's Windows .cmd shim without falling back to
 * unsafe `shell: true`, and the returned child stays owned by the SSE route.
 *
 * `action` selects install / update / uninstall from the table; an unsupported
 * pairing returns `null` rather than falling back to a different action.
 */
export function spawnRuntimeInstaller(id, { spawnImpl = spawn, action = 'install' } = {}) {
  const invocation = buildRuntimeActionCommand(id, action);
  if (!invocation) return null;
  const env = safeChildProcessEnv();
  const { command, args } = prepareCliSpawn(invocation.command, invocation.args, env);
  return spawnImpl(command, args, safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    // npm and vendor install scripts both run lifecycle children. Give the
    // POSIX install its own group so closing the modal stops that entire
    // install, not just the parent.
    detached: !IS_WIN,
  }));
}

/** Terminate the installer child and descendants when the installer modal closes. */
export function stopRuntimeInstaller(child) {
  if (!child?.pid || child.killed) return;
  killProcessTree(child, 'SIGTERM', { processGroup: !IS_WIN });
}
