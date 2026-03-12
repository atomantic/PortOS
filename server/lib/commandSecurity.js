// Allowlist of safe commands
export const ALLOWED_COMMANDS = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'node', 'deno',
  'git', 'gh',
  'pm2',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'pwd', 'which', 'echo', 'env',
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
function parseCommandArgs(str) {
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
  return { valid: true, baseCommand, args: parts.slice(1) };
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
