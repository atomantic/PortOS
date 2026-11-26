/**
 *  Source-derived Socket.IO event inventory, cached once per server process.
 *
 * Cached source-derived Socket.IO event inventory: event names and directions only, with no checked-in
 * manifest or positional source metadata.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapWithConcurrency } from './mapWithConcurrency.js';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_ROOT = 'server';
const CLIENT_ROOT = 'client/src';
const FILE_READ_CONCURRENCY = 32;
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'coverage', 'dist']);
const EXCLUDED_SERVER_PREFIXES = Object.freeze(['server/cos-runner/']);
const SOCKET_CALL_RE = /\bsocket\??\.(on|once|emit)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
// Server emit receivers: the `io` aliases the services bind, `getIo()`, and the
// `req.app.get('io')` route form. Room/namespace hops (`.to/.in/.except/.of`) may
// sit between the receiver and `.emit(` (one level of nested call parens allowed).
const SERVER_EMIT_RECEIVER = String.raw`(?:\b(?:io|ioInstance|boundIo|providersIo|ioRef|ns)|\bgetIo\(\)|\.get\(\s*['"]io['"]\s*\))`;
const SERVER_EMIT_HOPS = String.raw`(?:\??\.(?:to|in|except|of)\((?:[^()]|\([^()]*\))*\))*`;
const EVENT_NAME_SOURCE = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.source;
const SERVER_EMIT_RE = new RegExp(
  `${SERVER_EMIT_RECEIVER}\\??${SERVER_EMIT_HOPS}\\??\\.emit\\(\\s*${EVENT_NAME_SOURCE}`,
  'g',
);
const OPERATOR_EMIT_RE = new RegExp(String.raw`\b(?:emitToOperatorsOn\(\s*io\s*,|emitToOperators\()\s*${EVENT_NAME_SOURCE}`, 'g');
const SERVER_BROADCAST_RE = /\bbroadcastTo(?!Set\b)[A-Za-z]*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
// Quoted colon-namespaced names. Clients often listen through constant arrays
// (`const EVENTS = ['brain:changed']`) rather than a literal `socket.on(...)`, so
// "has a client listener" means "the client source names the event".
const CLIENT_EVENT_LITERAL_RE = /(['"`])([a-z][\w-]*(?::[\w-]+)+)\1/g;
const REGISTER_SUBSCRIBER_RE = /\bregisterSubscriber\(\s*socket\s*,\s*(['"])([^'"\n]+)\1/g;

const toPosix = (path) => path.split(sep).join('/');

const walk = async (path) => (await Promise.all(
  (await readdir(path, { withFileTypes: true }))
    .filter((entry) => !EXCLUDED_DIRECTORY_NAMES.has(entry.name))
    .map(async (entry) => {
      const target = join(path, entry.name);
      return entry.isDirectory() ? walk(target) : [target];
    }),
)).flat();

const sourceFiles = async (repoRoot) => (await Promise.all([
  walk(join(repoRoot, SERVER_ROOT)),
  walk(join(repoRoot, CLIENT_ROOT)),
])).flat().filter((path) => {
  const relativePath = toPosix(relative(repoRoot, path));
  return /\.(?:js|jsx)$/.test(path)
    && !path.endsWith('.test.js')
    && !path.endsWith('.test.jsx')
    && !EXCLUDED_SERVER_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
});

const parseEventExpression = (expression) => {
  const quote = expression[0];
  const body = expression.slice(1, -1);
  if (quote !== '`') return body;
  if (/\$\{(?![A-Za-z_$][\w$]*\})/.test(body)) return null;
  const normalized = body.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, '{$1}');
  // A leading placeholder is an internal helper pattern (for example
  // `${namespace}:subscribed`), not a callable address. Concrete call sites
  // and registerSubscriber expansion contribute the real event names.
  return normalized.startsWith('{') ? null : normalized;
};

const directionFor = ({ side, method }) => {
  if (side === 'server') return method === 'emit' ? 'server-to-client' : 'client-to-server';
  return method === 'emit' ? 'client-to-server' : 'server-to-client';
};

export async function scanSocketEventFile(filePath, repoRoot = DEFAULT_REPO_ROOT) {
  return scanSocketEventSource(await readFile(filePath, 'utf8'), filePath, repoRoot);
}

const scanSocketEventSource = (source, filePath, repoRoot) => {
  const path = toPosix(relative(repoRoot, filePath));
  const side = path.startsWith('server/') ? 'server' : 'client';
  const declarations = [];
  const record = (match, method, expression = match[2]) => {
    const event = parseEventExpression(expression);
    if (event) declarations.push({ event, direction: directionFor({ side, method }) });
  };

  for (const match of source.matchAll(SOCKET_CALL_RE)) record(match, match[1]);
  if (side === 'server') {
    for (const match of source.matchAll(SERVER_EMIT_RE)) record(match, 'emit', match[1]);
    for (const match of source.matchAll(OPERATOR_EMIT_RE)) record(match, 'emit', match[1]);
    for (const match of source.matchAll(SERVER_BROADCAST_RE)) record(match, 'emit', match[1]);
    for (const match of source.matchAll(REGISTER_SUBSCRIBER_RE)) {
      for (const suffix of ['subscribe', 'unsubscribe']) {
        declarations.push({ event: `${match[2]}:${suffix}`, direction: 'client-to-server' });
      }
      for (const suffix of ['subscribed', 'unsubscribed']) {
        declarations.push({ event: `${match[2]}:${suffix}`, direction: 'server-to-client' });
      }
    }
  }
  return declarations;
};

export async function buildSocketEventInventory({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const byEvent = new Map();
  const clientReferenced = new Set();
  const serverEmitted = new Set();
  let sourceFileCount = 0;
  const files = await sourceFiles(repoRoot);
  const scans = await mapWithConcurrency(files, FILE_READ_CONCURRENCY, async (filePath) => {
    const source = await readFile(filePath, 'utf8');
    const isClient = toPosix(relative(repoRoot, filePath)).startsWith(`${CLIENT_ROOT}/`);
    return {
      isClient,
      declarations: scanSocketEventSource(source, filePath, repoRoot),
      literals: isClient ? [...source.matchAll(CLIENT_EVENT_LITERAL_RE)].map((match) => match[2]) : [],
    };
  });
  for (const { isClient, declarations, literals } of scans) {
    if (declarations.length) sourceFileCount += 1;
    for (const event of literals) clientReferenced.add(event);
    for (const declaration of declarations) {
      const directions = byEvent.get(declaration.event) || new Set();
      directions.add(declaration.direction);
      byEvent.set(declaration.event, directions);
      // A server file only declares server-to-client through an emit/broadcast.
      if (!isClient && declaration.direction === 'server-to-client') serverEmitted.add(declaration.event);
    }
  }

  const events = [...byEvent.entries()]
    .map(([event, directions]) => ({
      event,
      directions: [...directions].sort(),
      serverEmitted: serverEmitted.has(event),
      clientReferenced: clientReferenced.has(event),
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
  return {
    derivedFrom: ['server/**/*.js', '!server/cos-runner/**', 'client/src/**/*.{js,jsx}'],
    events,
    stats: {
      events: events.length,
      clientToServer: events.filter((event) => event.directions.includes('client-to-server')).length,
      serverToClient: events.filter((event) => event.directions.includes('server-to-client')).length,
      bidirectional: events.filter((event) => event.directions.length > 1).length,
      sourceFiles: sourceFileCount,
    },
  };
}

let cachedInventoryPromise;

export const getSocketEventInventory = () => {
  cachedInventoryPromise ??= buildSocketEventInventory();
  return cachedInventoryPromise;
};
