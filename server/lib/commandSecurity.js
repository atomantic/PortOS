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
// the unscoped form the user's CLAUDE.md explicitly forbids). Blocked only when
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

/**
 * Validate a command against the allowlist.
 * Returns { valid, error?, baseCommand?, args? }
 */
export function validateCommand(command) {
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
  if (!ALLOWED_COMMANDS.has(baseCommand)) {
    return { valid: false, error: `Command '${baseCommand}' is not in the allowlist. Allowed: ${ALLOWED_COMMANDS_SORTED.join(', ')}` };
  }
  const args = parts.slice(1);
  if (baseCommand === 'pm2') {
    const pm2Check = validatePm2Command(args);
    if (!pm2Check.valid) return pm2Check;
  }
  return { valid: true, baseCommand, args };
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
