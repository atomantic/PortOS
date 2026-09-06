/** OS containment for the private, tool-free assessment harness (macOS). */
import { access, mkdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, delimiter, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { localRuntimeForProvider } from './localProviderRuntime.js';

export function privateSecurityScratchCwd(agentId) {
  if (!/^[a-zA-Z0-9-]+$/.test(agentId || '')) throw new Error('Invalid security assessment agent id');
  return join(tmpdir(), 'portos-private-security', agentId);
}

export function privateSecurityEndpoint(provider) {
  const runtime = localRuntimeForProvider(provider);
  if (!runtime || !['ollama', 'lmstudio'].includes(runtime.kind)) return null;
  const url = new URL(runtime.endpoint);
  // Keep the OS allowlist literal and narrow. No remote DNS, bind-all address,
  // credentials, hosted gateways or arbitrary sidecar namespaces.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) return null;
  return { port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), endpoint: url.href };
}

export function privateSecuritySeatbeltProfile({ cwd, executable, nodeExecutable, port }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local inference port');
  const quote = (value) => JSON.stringify(value);
  const roots = [...new Set([cwd, dirname(executable), dirname(nodeExecutable),
    '/private/var/db/dyld', '/private/var/db/timezone', '/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/opt/homebrew', '/dev'])];
  return `(version 1)
(deny default)
(allow process* sysctl-read mach-lookup file-read-metadata file-map-executable)
(allow file-read* (literal "/") ${roots.map((root) => `(subpath ${quote(root)})`).join(' ')}
  (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/etc/localtime"))
(allow file-write* (subpath ${quote(cwd)}) (literal "/dev/null"))
(allow network-outbound (remote tcp "localhost:${port}"))`;
}

async function executablePath(command, path) {
  const candidates = isAbsolute(command) ? [command] : String(path || '').split(delimiter).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return realpath(candidate);
  }
  throw new Error('Private assessment CLI executable is unavailable');
}

export async function preparePrivateSecuritySpawn({ command, args, env, cwd, provider }) {
  if (process.platform !== 'darwin') throw new Error('Private security assessments require the macOS Seatbelt sandbox on this release; no unsandboxed fallback');
  await access('/usr/bin/sandbox-exec', constants.X_OK);
  const local = privateSecurityEndpoint(provider);
  if (!local) throw new Error('Private assessments require a loopback Ollama or LM Studio provider');
  const sandboxCwd = await realpath(cwd);
  const executable = await executablePath(command, env.PATH);
  const nodeExecutable = await realpath(process.execPath);
  const home = join(sandboxCwd, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const profile = privateSecuritySeatbeltProfile({ cwd: sandboxCwd, executable, nodeExecutable, port: local.port });
  // The usual restricted-profile environment has already removed credentials.
  // Isolate native CLI state as well; project/user configs cannot be discovered.
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, ...args], env: {
    ...env, HOME: home, USERPROFILE: home, PWD: sandboxCwd,
    TMPDIR: home, TMP: home, TEMP: home,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
  } };
}
