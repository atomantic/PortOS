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
 * http://127.0.0.1:5555. A path without a leading `/api/` or `/data/` gets
 * `/api` prepended. The response body goes to stdout (JSON pretty-printed);
 * a non-2xx status exits 1 with the body on stderr.
 *
 * Builtins only, so it runs from any checkout without `npm install`.
 */

import { readFile } from 'node:fs/promises';
import { resolveAgentKeyFile } from '../lib/agentKeyFile.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const DEFAULT_URL = 'http://127.0.0.1:5555';
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const USAGE = `Usage:
  portos-api whoami
  portos-api <get|post|put|patch|delete> <path> [json | @file | -]
  portos-api task "<description>" [--app <id>] [--priority LOW|MEDIUM|HIGH|CRITICAL] [--context "<note>"]

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
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { help: true };
  if (command === 'whoami') return { method: 'GET', path: '/api/auth/whoami', body: null };
  if (command === 'task') {
    const { flags, positional } = splitFlags(rest);
    const description = positional.join(' ').trim();
    if (!description) throw new Error('task needs a description');
    const task = { description };
    if (flags.app) task.app = flags.app;
    if (flags.context) task.context = flags.context;
    if (flags.priority) {
      const priority = flags.priority.toUpperCase();
      if (!PRIORITIES.has(priority)) throw new Error(`--priority must be one of ${[...PRIORITIES].join(', ')}`);
      task.priority = priority;
    }
    return { method: 'POST', path: '/api/cos/tasks', body: JSON.stringify(task) };
  }
  if (!METHODS.has(command.toLowerCase())) throw new Error(`Unknown command: ${command}`);
  const [path, payload] = rest;
  if (!path) throw new Error(`${command} needs a path`);
  let body = null;
  if (payload === '-') body = { stdin: true };
  else if (payload?.startsWith('@')) body = { file: payload.slice(1) };
  else if (payload !== undefined) body = payload;
  return { method: command.toUpperCase(), path: normalizePath(path), body };
};

/** `{ url, token }` from the environment and the key file (see header). */
export const resolveCredentials = async (env = process.env) => {
  const keyFile = await readFile(resolveAgentKeyFile(env), 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const url = (env.PORTOS_URL || keyFile?.url || DEFAULT_URL).replace(/\/+$/, '');
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

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  const { url, token } = await resolveCredentials();
  const body = await resolveBody(parsed.body);
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${url}${parsed.path}`, { method: parsed.method, headers, body });
  const text = await res.text();
  let out = text;
  try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON: print as-is */ }
  if (res.ok) {
    if (out) console.log(out);
    return 0;
  }
  console.error(`❌ ${parsed.method} ${parsed.path} → ${res.status}`);
  if (out) console.error(out);
  if (res.status === 401 && !token) {
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
