// Allowlist of safe commands
export const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'node', 'deno',
  'git', 'gh',
  'pm2',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'pwd', 'which', 'echo',
  'curl', 'wget',
  'docker', 'docker-compose',
  'make', 'cargo', 'go', 'python', 'python3', 'pip', 'pip3',
  'brew'
]);

// Pre-sorted list for API responses
export const ALLOWED_COMMANDS_SORTED = Array.from(ALLOWED_COMMANDS).sort();

// Narrower allowlist for the UNATTENDED lane (Layered Intelligence `cmd` custom
// sources), which runs on a schedule with nobody watching. Read-only repository
// and tracker inspection is the entire documented purpose of a `cmd` source, so
// this list deliberately excludes every network-fetch and code-execution verb
// that ALLOWED_COMMANDS admits for the operator-driven runner (`npx`, `node`,
// `python`, `pip`, `curl`, `wget`, `go`, `cargo`, `make`, `brew`, `pm2`, …).
// `npx <pkg>` / `pip install <pkg>` / `curl -o <path> <url>` contain no shell
// metacharacter, so the metacharacter filter alone does NOT stop them.
//
// Scope: membership here is necessary but NOT sufficient. Four of these binaries
// are multi-purpose — `git`, `find`, `gh` and `glab` all accept destructive or
// mutating verbs (`git reset --hard`, `find . -delete`, `gh api -X POST`) that
// carry no shell metacharacter. Those are rejected a second time by the
// per-binary subcommand gate below (`UNATTENDED_SUBCOMMAND_VALIDATORS`, wired
// into `validateUnattendedCommand`). The remaining entries (`ls`, `cat`, `head`,
// `tail`, `grep`, `wc`, `pwd`, `echo`) have no write mode at all and stay
// binary-level.
export const UNATTENDED_READONLY_COMMANDS = new Set([
  'git', 'gh', 'glab',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'pwd', 'echo'
]);

const UNATTENDED_READONLY_COMMANDS_SORTED = Array.from(UNATTENDED_READONLY_COMMANDS).sort();

// Shell metacharacters that could be used for command injection
// Security: Reject any command containing these to prevent injection via pipes, chaining, etc.
export const DANGEROUS_SHELL_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;

/**
 * Parse command string into args, respecting quoted strings.
 * e.g. 'git commit -m "msg with spaces"' → ['git', 'commit', '-m', 'msg with spaces']
 */
export function parseCommandArgs(str) {
  const args = [];
  let current = '';
  let inQuote = null;
  let hasQuote = false;
  for (const ch of str) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = null; continue; }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasQuote = true;
    } else if (/\s/.test(ch)) {
      if (current || hasQuote) { args.push(current); current = ''; hasQuote = false; }
    } else {
      current += ch;
    }
  }
  if (inQuote) return str.split(/\s+/); // fallback on unmatched quotes
  if (current || hasQuote) args.push(current);
  return args;
}

// PM2 runs ONE shared daemon for every app on the machine. These subcommands
// take the whole daemon (and therefore every other app, including PortOS itself)
// down or rewrite system boot config — never legitimate for a single app's
// scoped management. Blocked regardless of who issues them. This list is mirrored
// in the agent PATH-shim (server/lib/agentGuard/bin/pm2) — keep them in sync.
export const PM2_BLOCKED_SUBCOMMANDS = new Set(['kill', 'startup', 'unstartup']);

// Daemon-wide verbs that are fine against a single named process but catastrophic
// with the `all` target (`pm2 stop all`, `pm2 delete all`, `pm2 restart all` —
// the unscoped form the user's AGENTS.md explicitly forbids). Blocked only when
// the target is `all`.
export const PM2_ALL_TARGET_VERBS = new Set([
  'stop', 'delete', 'del', 'restart', 'reload', 'gracefulreload', 'scale',
]);

/**
 * Reject pm2 invocations that would disrupt the shared PM2 daemon or other apps.
 * `args` is everything after the `pm2` base command.
 * Returns { valid, error? }.
 */
export function validatePm2Command(args) {
  const sub = (args[0] || '').toLowerCase();
  if (PM2_BLOCKED_SUBCOMMANDS.has(sub)) {
    return { valid: false, error: `'pm2 ${sub}' is blocked — it would take down the shared PM2 daemon or every app on this machine (including PortOS). Use a scoped command like 'pm2 restart <process-name>'.` };
  }
  if (PM2_ALL_TARGET_VERBS.has(sub) && args.slice(1).some(a => a.toLowerCase() === 'all')) {
    return { valid: false, error: `'pm2 ${sub} all' is blocked — it affects every app on this shared server. Target a specific process by name instead.` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Unattended subcommand gate (#5808)
//
// `UNATTENDED_READONLY_COMMANDS` admits four multi-purpose binaries whose
// destructive verbs contain no shell metacharacter, so the allowlist and the
// metacharacter filter both wave them through. These validators run only on the
// unattended lane, keyed off the base command exactly the way `validateCommand`
// keys the pm2 check off its own base command. The operator lane is untouched:
// a human triggers and watches it, and `git commit` there is legitimate.
// ---------------------------------------------------------------------------

// Read-only git verbs. Allowlist, not denylist — git grows verbs, and an unknown
// verb must fail closed rather than inherit a permission nobody reviewed.
const UNATTENDED_GIT_SUBCOMMANDS = new Set([
  'log', 'show', 'status', 'diff', 'blame', 'describe', 'rev-parse',
  'branch', 'tag', 'remote', 'config', 'ls-files', 'shortlog',
]);

// `git config` only reads when asked to read; a bare `git config a.b c` writes.
const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);

// The three listing verbs above still expose a small mutating flag surface
// (`git branch -D`, `git tag -d`, `git remote remove`). Their listing forms stay
// allowed; these forms do not.
const GIT_BRANCH_MUTATING_FLAGS = new Set(['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '--set-upstream-to', '-u', '--unset-upstream', '--edit-description']);
const GIT_TAG_MUTATING_FLAGS = new Set(['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '--message', '-F', '--file']);
// `git branch <name>` / `git tag <name>` CREATE a ref; the same verbs only read
// when the positional is a filter for an explicit list mode. So a positional is
// admitted only alongside one of these.
const GIT_LIST_MODE_FLAGS = new Set(['-l', '--list', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged']);
const GIT_REMOTE_READ_VERBS = new Set(['show', 'get-url']);

// `find` action flags: `-delete` removes files and `-exec`/`-ok` family runs
// arbitrary binaries, which would defeat the allowlist entirely. `-f*print*`
// writes attacker-chosen files. Everything else (`-name`, `-type`, `-maxdepth`,
// `-print`) only inspects.
const FIND_ACTION_FLAGS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir',
  '-fls', '-fprint', '-fprint0', '-fprintf',
]);

// gh/glab write verbs are authenticated mutations against the tracker using the
// operator's own credentials, so only `<noun> list`, `<noun> view` and read-only
// `api` calls are admitted.
const GH_READ_VERBS = new Set(['list', 'view']);
const GH_METHOD_FLAGS = new Set(['-X', '--method']);
// gh/glab switch `api` to POST implicitly when a field flag is present, so a
// method check alone is not enough.
const GH_FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field', '--input']);

const deny = (error) => ({ valid: false, error });

// True when `git branch` / `git tag` args only list refs: no mutating flag, and
// no bare positional unless an explicit list-mode flag makes it a filter.
function isGitRefListing(sub, rest) {
  const mutating = sub === 'branch' ? GIT_BRANCH_MUTATING_FLAGS : GIT_TAG_MUTATING_FLAGS;
  if (rest.some(a => mutating.has(a))) return false;
  const hasPositional = rest.some(a => !a.startsWith('-'));
  return !hasPositional || rest.some(a => GIT_LIST_MODE_FLAGS.has(a));
}

function validateUnattendedGit(args) {
  const sub = args[0];
  if (!sub) return deny("'git' needs a read-only subcommand on the unattended lane.");
  if (!UNATTENDED_GIT_SUBCOMMANDS.has(sub)) {
    return deny(`'git ${sub}' is not allowed on the unattended lane — only read-only inspection subcommands are: ${[...UNATTENDED_GIT_SUBCOMMANDS].sort().join(', ')}.`);
  }
  const rest = args.slice(1);
  if (sub === 'config' && !rest.some(a => GIT_CONFIG_READ_FLAGS.has(a))) {
    return deny("'git config' is only allowed in its read form on the unattended lane (e.g. 'git config --get <key>').");
  }
  if ((sub === 'branch' || sub === 'tag') && !isGitRefListing(sub, rest)) {
    return deny(`'git ${sub}' is only allowed in its listing form on the unattended lane — naming a ref (or a delete/move flag) writes to the repo.`);
  }
  if (sub === 'remote' && rest.length && !GIT_REMOTE_READ_VERBS.has(rest[0]) && !rest[0].startsWith('-')) {
    return deny("'git remote' is only allowed in its listing form on the unattended lane (e.g. 'git remote -v', 'git remote show <name>').");
  }
  return { valid: true };
}

function validateUnattendedFind(args) {
  const action = args.find(a => FIND_ACTION_FLAGS.has(a));
  if (action) {
    return deny(`'find ${action}' is not allowed on the unattended lane — it deletes, writes, or executes. Use inspection predicates ('-name', '-type', '-maxdepth', '-print') instead.`);
  }
  return { valid: true };
}

function validateUnattendedGhLike(base, args) {
  const sub = args[0];
  if (!sub) return deny(`'${base}' needs a read-only subcommand on the unattended lane.`);
  if (sub === 'api') {
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      // `?? ''` keeps a trailing `-X` with no value from crashing here — and a
      // methodless `-X` is malformed anyway, so failing closed is correct.
      const method = GH_METHOD_FLAGS.has(arg) ? (rest[i + 1] ?? '')
        : arg.startsWith('--method=') ? arg.slice('--method='.length)
          : null;
      if (method !== null && method.toUpperCase() !== 'GET') {
        return deny(`'${base} api' is limited to GET on the unattended lane — '${method}' is an authenticated write.`);
      }
      if (GH_FIELD_FLAGS.has(arg) || arg.startsWith('--field=') || arg.startsWith('--raw-field=')) {
        return deny(`'${base} api ${arg}' is not allowed on the unattended lane — a field flag makes the request a POST.`);
      }
    }
    return { valid: true };
  }
  const verb = args[1];
  if (!GH_READ_VERBS.has(verb)) {
    return deny(`'${base} ${sub}${verb ? ` ${verb}` : ''}' is not allowed on the unattended lane — only '${base} <noun> list', '${base} <noun> view' and read-only '${base} api' are.`);
  }
  return { valid: true };
}

// Keyed by base command; a binary with no entry is accepted on membership alone.
// A Map, not an object literal — the key comes from the parsed command string,
// and a Map has no prototype chain for `constructor`/`__proto__` to resolve into.
const UNATTENDED_SUBCOMMAND_VALIDATORS = new Map([
  ['git', validateUnattendedGit],
  ['find', validateUnattendedFind],
  ['gh', (args) => validateUnattendedGhLike('gh', args)],
  ['glab', (args) => validateUnattendedGhLike('glab', args)],
]);

/**
 * Shared shape/metacharacter/allowlist gate. Both public validators route
 * through this so the two lanes can never disagree about parsing or about
 * which shell metacharacters are rejected — only the allowlist differs.
 * Returns { valid, error?, baseCommand?, args? }
 */
function validateAgainst(command, allowlist, allowlistSorted) {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command is required' };
  }
  const trimmed = command.trim();
  if (!trimmed) return { valid: false, error: 'Command cannot be empty' };
  if (DANGEROUS_SHELL_CHARS.test(trimmed)) {
    return { valid: false, error: 'Command contains disallowed shell characters' };
  }
  const parts = parseCommandArgs(trimmed);
  const baseCommand = parts[0];
  if (!allowlist.has(baseCommand)) {
    return { valid: false, error: `Command '${baseCommand}' is not in the allowlist. Allowed: ${allowlistSorted.join(', ')}` };
  }
  return { valid: true, baseCommand, args: parts.slice(1) };
}

/**
 * Validate a command against the operator-driven allowlist (the manual command
 * runner, POST /api/commands/execute — a human triggers and watches each run).
 * Returns { valid, error?, baseCommand?, args? }
 */
export function validateCommand(command) {
  const check = validateAgainst(command, ALLOWED_COMMANDS, ALLOWED_COMMANDS_SORTED);
  if (!check.valid) return check;
  if (check.baseCommand === 'pm2') {
    const pm2Check = validatePm2Command(check.args);
    if (!pm2Check.valid) return pm2Check;
  }
  return check;
}

/**
 * Validate a command for the UNATTENDED lane — a scheduled job executing a
 * string that lives in persistent, attacker-reachable config with no human in
 * the loop. Same parsing and metacharacter rules as `validateCommand`, but only
 * `UNATTENDED_READONLY_COMMANDS` are admitted, so a config that lands `npx`,
 * `curl` or `pip install` cannot reach a spawn. Multi-purpose binaries then get
 * a per-binary subcommand check (`git`, `find`, `gh`, `glab`), so `git reset
 * --hard`, `find . -delete` and `gh api -X POST` are rejected too. No pm2
 * sub-check is needed — pm2 is not on the list at all.
 * Returns { valid, error?, baseCommand?, args? }
 */
export function validateUnattendedCommand(command) {
  const check = validateAgainst(command, UNATTENDED_READONLY_COMMANDS, UNATTENDED_READONLY_COMMANDS_SORTED);
  if (!check.valid) return check;
  const subCheck = UNATTENDED_SUBCOMMAND_VALIDATORS.get(check.baseCommand)?.(check.args);
  if (subCheck && !subCheck.valid) return subCheck;
  return check;
}

// Patterns matching sensitive env var values in command output
const SENSITIVE_ENV_PATTERN = /("(?:[a-z0-9]+_)*(?:KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|MACAROON|CERT|CREDENTIAL|AUTH)(?:_[a-z0-9]+)*":\s*)"[^"]+"/gi;

/**
 * Redact sensitive env var values from command output before persisting.
 * Only redacts JSON key/value patterns (e.g. "SECRET_KEY": "value"). Shell-level
 * leaks (env expansion, command substitution) are not covered — acceptable for
 * PortOS's single-user, private-network deployment where the operator is the
 * only user and shell output is not exposed to external consumers.
 */
export function redactOutput(output) {
  if (!output) return output;
  return output.replace(SENSITIVE_ENV_PATTERN, '$1"[REDACTED]"');
}
