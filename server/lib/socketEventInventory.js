/** Source-derived Socket.IO event inventory, cached once per server process. */

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
const SERVER_EMIT_RE = /\b(?:io|ioInstance)\??\.emit\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const SERVER_BROADCAST_RE = /\bbroadcastTo(?!Set\b)[A-Za-z]*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
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
  const source = await readFile(filePath, 'utf8');
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
}

export async function buildSocketEventInventory({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const byEvent = new Map();
  let sourceFileCount = 0;
  const files = await sourceFiles(repoRoot);
  const declarationSets = await mapWithConcurrency(
    files,
    FILE_READ_CONCURRENCY,
    (filePath) => scanSocketEventFile(filePath, repoRoot),
  );
  for (const declarations of declarationSets) {
    if (declarations.length) sourceFileCount += 1;
    for (const declaration of declarations) {
      const directions = byEvent.get(declaration.event) || new Set();
      directions.add(declaration.direction);
      byEvent.set(declaration.event, directions);
    }
  }

  const events = [...byEvent.entries()]
    .map(([event, directions]) => ({ event, directions: [...directions].sort() }))
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
