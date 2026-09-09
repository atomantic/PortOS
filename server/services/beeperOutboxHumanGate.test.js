/**
 * Guard: the Beeper send path is reachable ONLY through a human HTTP route
 * (#36, decided on #8 decision 6).
 *
 * Upstream's posture is one send service with exactly one non-test caller — a
 * human route (`messageSender.sendDraft` ← `routes/messages.js`). Beeper is the
 * first chat channel where a programmatic send is technically possible at all,
 * so "no agent path" has to be asserted structurally rather than left to
 * convention: a `cosToolRegistry` entry, a voice tool, or a scheduler import
 * added later would each be a silent, real message to a real person.
 *
 * The assertion is deliberately blunt and source-level, in the shape of
 * `beeperNeverFederates.test.js`: it scans the whole server tree for importers
 * of `beeperOutbox.js` and for anything that names its send function, and pins
 * the importer set. Every filter is paired with a floor on the list it filters,
 * so a scan that silently found nothing (a moved directory, a renamed export)
 * fails instead of passing vacuously.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');

function collectSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    out.push({ path: relative(SERVER_ROOT, full), source: readFileSync(full, 'utf8') });
  }
  return out;
}

const SOURCES = collectSources(SERVER_ROOT);
const PRODUCTION_SOURCES = SOURCES.filter((file) => !file.path.endsWith('.test.js'));

// The send entry point, and the two service functions that reach it.
const SEND_SYMBOLS = ['sendOutboxEntry', 'createOutboxEntry'];

describe('beeper outbox has no agent-initiated send path (#36)', () => {
  it('scanned a recognizably complete server tree', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(PRODUCTION_SOURCES.length).toBeGreaterThan(100);
    expect(PRODUCTION_SOURCES.some((file) => file.path === 'services/beeperOutbox.js')).toBe(true);
  });

  it('is imported for a send by exactly one production module: the human HTTP route', () => {
    const importers = PRODUCTION_SOURCES
      .filter((file) => file.path !== 'services/beeperOutbox.js')
      .filter((file) => /from '\.{1,2}\/(?:services\/)?beeperOutbox\.js'/.test(file.source))
      .map((file) => file.path)
      .sort();
    // Two non-send importers ride alongside the route, and the test below is
    // what keeps them non-send: `beeperStatus.js` reads the breaker's state for
    // the settings card, and `bootstrap.js` calls the boot reconcile, whose two
    // arms are a state write and a re-armed LOOKUP — neither reaches
    // `sendMessage`, which is why a crash mid-send can never resend itself.
    expect(importers).toEqual(['routes/beeper.js', 'services/beeperStatus.js', 'services/bootstrap.js']);
  });

  it('names the send functions in no production module but the route', () => {
    const callers = PRODUCTION_SOURCES
      .filter((file) => file.path !== 'services/beeperOutbox.js')
      .filter((file) => SEND_SYMBOLS.some((symbol) => file.source.includes(symbol)))
      .map((file) => file.path);
    expect(callers).toEqual(['routes/beeper.js']);
  });

  it('exposes no beeper tool to the CoS catalog or the voice surface', async () => {
    const { getCosToolCatalog } = await import('./cosToolRegistry.js');
    const catalog = getCosToolCatalog({ scope: 'all' });
    const names = JSON.stringify(catalog);
    expect(catalog.length ?? Object.keys(catalog).length).toBeGreaterThan(3);
    expect(/beeper/i.test(names)).toBe(false);
  });

  it('keeps "no external messaging" in the persistent-mind boundaries', async () => {
    const { PERSISTENT_MIND_TOOL_BOUNDARIES } = await import('../lib/persistentMindCapabilities.js');
    expect(PERSISTENT_MIND_TOOL_BOUNDARIES.length).toBeGreaterThan(2);
    expect(PERSISTENT_MIND_TOOL_BOUNDARIES.join(' ')).toContain('external messaging');
  });

  it('reaches the Beeper send API from the outbox service alone', () => {
    // Scoped to modules that import the Beeper CLIENT — `sendMessage` is a
    // common name (Telegram has its own), and this guard is about who can
    // reach `POST /v1/chats/{chatID}/messages`, not about the identifier.
    const senders = PRODUCTION_SOURCES
      .filter((file) => file.path !== 'services/beeperClient.js')
      .filter((file) => /from '\.{1,2}\/(?:services\/)?beeperClient\.js'/.test(file.source))
      .filter((file) => /\bsendMessage\b/.test(file.source))
      .map((file) => file.path);
    expect(senders).toEqual(['services/beeperOutbox.js']);
  });
});
