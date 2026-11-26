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
import { join } from 'node:path';
import { readText, REPO_ROOT, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const SEND_SYMBOLS = ['sendOutboxEntry', 'createOutboxEntry'];
const OUTBOX = 'services/beeper/beeperOutbox.js';
const CLIENT = 'services/beeper/beeperClient.js';
const SKIP_PATH = /(?:^|\/)(?:\.|node_modules(?:\/|$))/;
const OUTBOX_IMPORT = /from '\.{1,2}\/(?:services\/)?(?:beeper\/)?beeperOutbox\.js'/;
const CLIENT_IMPORT = /from '\.{1,2}\/(?:services\/)?(?:beeper\/)?beeperClient\.js'/;

function scanOutboxSources() {
  const paths = workingTreeFiles(SERVER_ROOT, ['*.js']).filter((path) => !SKIP_PATH.test(path));
  const production = paths.filter((path) => !path.endsWith('.test.js'));
  const importers = [];
  const callers = [];
  const senders = [];
  for (const path of production) {
    const source = readText(join(SERVER_ROOT, path));
    if (path !== OUTBOX) {
      if (source.includes('beeperOutbox.js') && OUTBOX_IMPORT.test(source)) importers.push(path);
      if (SEND_SYMBOLS.some((symbol) => source.includes(symbol))) callers.push(path);
    }
    if (path !== CLIENT && source.includes('beeperClient.js') && CLIENT_IMPORT.test(source)
      && /\bsendMessage\b/.test(source)) senders.push(path);
  }
  return { paths, production, importers: importers.sort(), callers, senders };
}

describe('beeper outbox has no agent-initiated send path (#36)', () => {
  let scan;
  const evidence = () => (scan ??= scanOutboxSources());

  it('scanned a recognizably complete server tree', () => {
    const { paths, production } = evidence();
    expect(paths.length).toBeGreaterThan(200);
    expect(production.length).toBeGreaterThan(100);
    expect(production).toContain(OUTBOX);
  });

  it('is imported for a send by exactly one production module: the human HTTP route', () => {
    // Two non-send importers ride alongside the route, and the test below is
    // what keeps them non-send: `beeperStatus.js` reads the breaker's state for
    // the settings card, and `bootstrap.js` calls the boot reconcile, whose two
    // arms are a state write and a re-armed LOOKUP — neither reaches
    // `sendMessage`, which is why a crash mid-send can never resend itself.
    expect(evidence().importers).toEqual(['routes/beeper.js', 'services/beeper/beeperStatus.js', 'services/bootstrap.js']);
  });

  it('names the send functions in no production module but the route', () => {
    expect(evidence().callers).toEqual(['routes/beeper.js']);
  });

  it('reaches the Beeper send API from the outbox service alone', () => {
    // Scoped to modules that import the Beeper CLIENT — `sendMessage` is a
    // common name (Telegram has its own), and this guard is about who can
    // reach `POST /v1/chats/{chatID}/messages`, not about the identifier.
    expect(evidence().senders).toEqual(['services/beeper/beeperOutbox.js']);
  });
});
