#!/usr/bin/env node
/** Generate a deterministic Socket.IO event inventory from server and client call sites. */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const MANIFEST_RELATIVE_PATH = 'server/lib/socketEventCatalog.generated.json';
export const REGENERATE_COMMAND = 'node scripts/generate-socket-event-catalog.js';

const SERVER_ROOT = 'server';
const CLIENT_ROOT = 'client/src';
const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', 'coverage', 'dist']);
const EXCLUDED_SERVER_PREFIXES = Object.freeze(['server/cos-runner/']);
const SOCKET_CALL_RE = /\bsocket\??\.(on|once|emit)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const SERVER_EMIT_RE = /\b(?:io|ioInstance)\??\.emit\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const SERVER_BROADCAST_RE = /\bbroadcastTo(?!Set\b)[A-Za-z]*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const REGISTER_SUBSCRIBER_RE = /\bregisterSubscriber\(\s*socket\s*,\s*(['"])([^'"\n]+)\1/g;

const toPosix = (path) => path.split(sep).join('/');
const sourceLineFor = (source, index) => source.slice(0, index).split('\n').length;

const walk = (path) => statSync(path).isDirectory()
  ? readdirSync(path)
    .filter((name) => !EXCLUDED_DIRECTORY_NAMES.has(name))
    .flatMap((name) => walk(join(path, name)))
  : [path];

const sourceFiles = (repoRoot) => [
  ...walk(join(repoRoot, SERVER_ROOT)),
  ...walk(join(repoRoot, CLIENT_ROOT)),
].filter((path) => {
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

export function scanSocketEventFile(filePath, repoRoot = REPO_ROOT) {
  const source = readFileSync(filePath, 'utf8');
  const path = toPosix(relative(repoRoot, filePath));
  const side = path.startsWith('server/') ? 'server' : 'client';
  const evidence = [];
  const record = (match, method, expression = match[2]) => {
    const event = parseEventExpression(expression);
    if (!event) return;
    evidence.push({ event, direction: directionFor({ side, method }), source: path, line: sourceLineFor(source, match.index) });
  };

  for (const match of source.matchAll(SOCKET_CALL_RE)) record(match, match[1]);
  if (side === 'server') {
    for (const match of source.matchAll(SERVER_EMIT_RE)) record(match, 'emit', match[1]);
    for (const match of source.matchAll(SERVER_BROADCAST_RE)) record(match, 'emit', match[1]);
    for (const match of source.matchAll(REGISTER_SUBSCRIBER_RE)) {
      for (const suffix of ['subscribe', 'unsubscribe']) {
        evidence.push({ event: `${match[2]}:${suffix}`, direction: 'client-to-server', source: path, line: sourceLineFor(source, match.index) });
      }
      for (const suffix of ['subscribed', 'unsubscribed']) {
        evidence.push({ event: `${match[2]}:${suffix}`, direction: 'server-to-client', source: path, line: sourceLineFor(source, match.index) });
      }
    }
  }
  return evidence;
}

export function buildSocketEventCatalog({ repoRoot = REPO_ROOT } = {}) {
  const byEvent = new Map();
  for (const filePath of sourceFiles(repoRoot)) {
    for (const evidence of scanSocketEventFile(filePath, repoRoot)) {
      const entry = byEvent.get(evidence.event) || { event: evidence.event, directions: new Set(), sources: new Map() };
      entry.directions.add(evidence.direction);
      entry.sources.set(`${evidence.direction}:${evidence.source}:${evidence.line}`, {
        direction: evidence.direction,
        source: evidence.source,
        line: evidence.line,
      });
      byEvent.set(evidence.event, entry);
    }
  }

  const events = [...byEvent.values()].map((entry) => ({
    event: entry.event,
    directions: [...entry.directions].sort(),
    sources: [...entry.sources.values()].sort((a, b) =>
      a.source.localeCompare(b.source) || a.line - b.line || a.direction.localeCompare(b.direction)),
  })).sort((a, b) => a.event.localeCompare(b.event));
  const sourceCount = new Set(events.flatMap((event) => event.sources.map((source) => source.source))).size;
  return {
    schemaVersion: 1,
    generatedFrom: ['server/**/*.js', '!server/cos-runner/**', 'client/src/**/*.{js,jsx}'],
    events,
    stats: {
      events: events.length,
      clientToServer: events.filter((event) => event.directions.includes('client-to-server')).length,
      serverToClient: events.filter((event) => event.directions.includes('server-to-client')).length,
      bidirectional: events.filter((event) => event.directions.length > 1).length,
      sourceFiles: sourceCount,
    },
  };
}

export const serializeSocketEventCatalog = (catalog) => `${JSON.stringify(catalog, null, 2)}\n`;
export const readSocketEventCatalog = (repoRoot = REPO_ROOT) => JSON.parse(
  readFileSync(join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf8'),
);

function main() {
  const catalog = buildSocketEventCatalog();
  writeFileSync(join(REPO_ROOT, MANIFEST_RELATIVE_PATH), serializeSocketEventCatalog(catalog), 'utf8');
  console.log(`🔌 Wrote ${MANIFEST_RELATIVE_PATH}: ${catalog.stats.events} Socket.IO events across ${catalog.stats.sourceFiles} source files`);
}

if (isDirectlyInvoked(import.meta.url)) main();
