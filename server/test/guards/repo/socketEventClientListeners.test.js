/**
 * Guard: every server-to-client event in SOCKET_EVENT_CONTRACTS has a client
 * reference (#17485). A server push nobody listens for leaves the UI stale
 * until a manual reload. Client-to-server commands are excluded by `direction`.
 * Add an event to SIDECAR_ONLY only when its consumer is not under client/src.
 */
import { describe, it, expect } from 'vitest';
import { SOCKET_EVENT_CONTRACTS } from '../../../lib/socketEventContracts.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SIDECAR_ONLY = new Set([]);
const SOURCE = /\.(?:jsx?|mjs)$/;
const TEST_FILE = /\.test\.[cm]?jsx?$/;

describe('socket event client listener coverage', () => {
  it('every server-to-client contract event is referenced by client source', () => {
    const clientSource = trackedFiles(REPO_ROOT, ['client/src'])
      .filter((f) => SOURCE.test(f) && !TEST_FILE.test(f))
      .map((f) => readText(`${REPO_ROOT}/${f}`))
      .join('\n');
    const orphaned = Object.entries(SOCKET_EVENT_CONTRACTS)
      .filter(([name, c]) => c.direction === 'server-to-client' && !SIDECAR_ONLY.has(name))
      .map(([name]) => name)
      .filter((name) => !['\'', '"', '`'].some((q) => clientSource.includes(`${q}${name}${q}`)));
    expect(orphaned).toEqual([]);
  });

  it('only allowlists events that exist and are server-to-client', () => {
    for (const name of SIDECAR_ONLY) {
      expect(SOCKET_EVENT_CONTRACTS[name]?.direction).toBe('server-to-client');
    }
  });
});
