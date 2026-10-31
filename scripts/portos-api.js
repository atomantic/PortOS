#!/usr/bin/env node
/**
 * portos-api — call this machine's PortOS API from an agent PortOS did not
 * spawn (a Claude Code or Codex session in a terminal), without the password.
 *
 *   node scripts/portos-api.js whoami
 *   node scripts/portos-api.js get /api/cos/tasks
 *   node scripts/portos-api.js post /api/image-gen/generate '{"prompt":"a lighthouse at dusk"}'
 *   node scripts/portos-api.js post /api/music-video/autonomous @brief.json
 *   echo '{"description":"…"}' | node scripts/portos-api.js post /api/cos/tasks -
 *   node scripts/portos-api.js task "Fix the flaky upload test" --app portos --priority HIGH
 *
 * Credentials, first match wins:
 *   1. `PORTOS_API_TOKEN` — what PortOS injects into the agents it spawns
 *   2. the agent API key file the server keeps when Settings > Security >
 *      Agent API key is on (`~/.portos/agent-key.json`, or
 *      `$PORTOS_AGENT_KEY_FILE`; see lib/agentKeyFile.js)
 * The base URL is `$PORTOS_URL`, else the key file's `url`, else
 * the configured local HTTP listener (the loopback mirror when TLS is usable).
 * A path without a leading `/api/` or `/data/` gets
 * `/api` prepended. The response body goes to stdout (JSON pretty-printed);
 * a non-2xx status exits 1 with the body on stderr.
 *
 * Builtins only, so it runs from any checkout without `npm install`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from '../server/lib/ports.js';
import { resolveInstallRoot } from '../server/lib/dataRoot.js';
import { certPaths } from '../lib/certPaths.js';
import { hasTailscaleCert } from '../lib/tailscale-https.js';
import { parseEnvFile, resolveHttpMirrorPort } from './lib/envFile.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveAgentKeyFile } from '../lib/agentKeyFile.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const localConnection = (env) => {
  const root = resolveInstallRoot(ROOT);
  const { PORTOS_HTTP_PORT } = parseEnvFile(join(root, '.env'));
  const apiPort = PORTS.API;
  const mirrorPort = resolveHttpMirrorPort({ env, dotenv: { PORTOS_HTTP_PORT } });
  const tls = hasTailscaleCert(certPaths(join(root, 'data')).dir);
  return { apiPort, mirrorPort, tls, url: `http://127.0.0.1:${tls ? mirrorPort : apiPort}` };
};
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const USAGE = `Usage:
  portos-api whoami [--timeout <seconds>]
  portos-api <get|post|put|patch|delete> <path> [json | @file | -] [--timeout <seconds>]
  portos-api fableloom-export <preflight|start|status|watch|download> <loom-id> [job-id] [--episodes id1,id2] [--player true|false] [--characters true|false] [--voice true|false] [--allow-draft true|false] [--profile source|web-720p|web-1080p] [--webm true|false] [--output file.zip] [--timeout seconds]
  portos-api task "<description>" [--app <id>] [--priority LOW|MEDIUM|HIGH|CRITICAL] [--context "<note>"] [--timeout <seconds>]

Requests wait up to 30 minutes by default, including the response body.
Discover endpoints: portos-api get /api/api-docs/catalog.json`;

/** `/cos/tasks` → `/api/cos/tasks`; `/api/...` and `/data/...` pass through. */
export const normalizePath = (path) => {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return /^\/(api|data)(\/|$)/.test(withSlash) ? withSlash : `/api${withSlash}`;
};

/** Pull `--flag value` pairs out of argv; everything else stays positional. */
const splitFlags = (args) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
};

/**
 * argv (after `node script`) → `{ method, path, body }`, where `body` is a JSON
 * string, `{ file }`, `{ stdin: true }`, or null. Throws on anything it cannot
 * read.
 */
export const parseArgs = (argv) => {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { help: true };
  const { flags, positional: rest } = splitFlags(args);
  const timeout = {};
  if (flags.timeout !== undefined) {
    const seconds = Number(flags.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2 ** 31 - 1) throw new Error('--timeout must be positive seconds within the timer limit');
    timeout.timeoutMs = seconds * 1000;
  }
  if (command === 'fableloom-export') {
    const [action, loomId, jobId] = rest;
    if (!['preflight', 'start', 'status', 'watch', 'download'].includes(action) || !loomId) throw new Error('fableloom-export needs an action and loom ID');
    const allowed = new Set(['timeout', 'episodes', 'player', 'characters', 'voice', 'allow-draft', 'profile', 'webm', 'output']);
    if (Object.keys(flags).some(key => !allowed.has(key))) throw new Error('Unknown fableloom-export flag');
    const options = {};
    for (const [flag, key] of Object.entries({ player: 'includePlayer', characters: 'includeCharacters', voice: 'includeVoice', 'allow-draft': 'allowDraft', webm: 'includeWebm' })) {
      if (flags[flag] === undefined) continue;
      if (!['true', 'false'].includes(flags[flag])) throw new Error(`--${flag} must be true or false`);
      options[key] = flags[flag] === 'true';
    }
    if (options.includeVoice && !options.includeCharacters) throw new Error('--voice true needs --characters true');
    if (flags.episodes !== undefined) options.episodeIds = flags.episodes.split(',');
    if (flags.profile !== undefined) {
      if (!['source', 'web-720p', 'web-1080p'].includes(flags.profile)) throw new Error('--profile must be source, web-720p or web-1080p');
      options.mediaProfile = flags.profile;
    }
    const starts = ['preflight', 'start'].includes(action);
    if (rest.length !== (starts ? 2 : 3)) throw new Error('Unexpected fableloom-export arguments');
    if (flags.output && action !== 'download') throw new Error('--output must be used with download');
    if (!starts && !jobId) throw new Error(`${action} needs a job ID`);
    if (action === 'download' && !flags.output) throw new Error('download needs --output file.zip');
    if (!starts && Object.keys(options).length) throw new Error('Export options must be supplied to preflight or start');
    const path = `/api/fableloom/${encodeURIComponent(loomId)}/export`;
    return { method: starts ? 'POST' : 'GET', path: starts ? `${path}${action === 'preflight' ? '/preflight' : ''}`
      : `${path}/${encodeURIComponent(jobId)}${action === 'download' ? '/download' : ''}`,
      body: starts ? JSON.stringify(options) : null, ...(action === 'download' ? { output: flags.output } : {}),
      ...(action === 'watch' ? { watch: true } : {}), ...timeout };
  }
  if (command === 'whoami') return { method: 'GET', path: '/api/auth/whoami', body: null, ...timeout };
  if (command === 'task') {
    const description = rest.join(' ').trim();
    if (!description) throw new Error('task needs a description');
    const task = { description };
    if (flags.app) task.app = flags.app;
    if (flags.context) task.context = flags.context;
    if (flags.priority) {
      const priority = flags.priority.toUpperCase();
      if (!PRIORITIES.has(priority)) throw new Error(`--priority must be one of ${[...PRIORITIES].join(', ')}`);
      task.priority = priority;
    }
    return { method: 'POST', path: '/api/cos/tasks', body: JSON.stringify(task), ...timeout };
  }
  if (!METHODS.has(command.toLowerCase())) throw new Error(`Unknown command: ${command}`);
  const [path, payload] = rest;
  if (!path) throw new Error(`${command} needs a path`);
  let body = null;
  if (payload === '-') body = { stdin: true };
  else if (payload?.startsWith('@')) body = { file: payload.slice(1) };
  else if (payload !== undefined) body = payload;
  return { method: command.toUpperCase(), path: normalizePath(path), body, ...timeout };
};

/** `{ url, token }` from the environment and the key file (see header). */
export const resolveCredentials = async (env = process.env) => {
  const keyFile = await readFile(resolveAgentKeyFile(env), 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const url = (env.PORTOS_URL || keyFile?.url || localConnection(env).url).replace(/\/+$/, '');
  const token = env.PORTOS_API_TOKEN || (typeof keyFile?.token === 'string' ? keyFile.token : null);
  return { url, token };
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const resolveBody = async (body) => {
  if (body === null) return null;
  const text = typeof body === 'string' ? body
    : body.stdin ? await readStdin()
      : await readFile(body.file, 'utf8');
  JSON.parse(text); // fail here with a clear message, not as a 400 from the server
  return text;
};

// Builtin HTTP has no hidden five-minute headers limit. One deadline covers
// connection, headers and body, and destroying the request also closes its socket.
export const requestApi = (url, { method, headers, body, timeoutMs }) => {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('PORTOS_URL must use HTTP or HTTPS');
  let timer;
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    timer = setTimeout(() => request.destroy(new Error(`Request timed out after ${timeoutMs / 1000} seconds; server work may still be running.`)), timeoutMs);
    request.end(body);
  }).finally(() => clearTimeout(timer));
};

export const main = async (argv = process.argv.slice(2), env = process.env) => {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { url, token } = await resolveCredentials(env);
  const body = await resolveBody(parsed.body);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Node's http client never chunks a DELETE body, so without a length the server
  // reads it as empty and the route rejects the request.
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const deadline = Date.now() + (parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let { status, text, bytes } = await requestApi(`${url}${parsed.path}`, { method: parsed.method, headers, body, timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS })
    .catch((error) => {
      const target = new URL(url);
      if (error.code === 'ECONNRESET' && target.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
        const local = localConnection(env);
        if (local.tls && Number(target.port || 80) === local.apiPort) {
          throw new Error(`Connection reset: this local API port is configured for HTTPS. Use PORTOS_URL=http://127.0.0.1:${local.mirrorPort} for its HTTP mirror.`, { cause: error });
        }
      }
      throw error;
    });
  if (parsed.watch) {
    while (status >= 200 && status < 300) {
      const job = JSON.parse(text);
      console.log(JSON.stringify(job, null, 2));
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job.status === 'completed' ? 0 : 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Export watch timed out; job may still be running.');
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining)));
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Export watch timed out; job may still be running.');
      ({ status, text } = await requestApi(`${url}${parsed.path}`, { method: 'GET', headers, body: null, timeoutMs: left }));
    }
  }
  if (parsed.output && status >= 200 && status < 300) {
    await writeFile(parsed.output, bytes, { flag: 'wx', mode: 0o600 });
    console.log(`Saved ZIP to ${parsed.output}`);
    return 0;
  }
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: print as-is */ }
  if (status >= 200 && status < 300) {
    if (out) console.log(out);
    return 0;
  }
  console.error(`❌ ${parsed.method} ${parsed.path} → ${status}`);
  if (out) console.error(out);
  if (status === 401 && !token) {
    console.error('No credential found. Turn on Settings > Security > Agent API key in PortOS, or set PORTOS_API_TOKEN.');
  }
  return 1;
};

if (isDirectlyInvoked(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`❌ ${err.message}`);
      if (/needs|Unknown command|must be/.test(err.message)) console.error(USAGE);
      process.exitCode = 1;
    });
}
