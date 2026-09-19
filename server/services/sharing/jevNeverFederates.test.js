/**
 * Guard: trained jev heads, their corpora and their cached embeddings must
 * NEVER federate (#7689).
 *
 * `data/jev/` is a DERIVED RECORD OF PRIVATE DATA. A corpus is this install's
 * merged pull requests and closed issues rendered as premises; a trained head
 * is a few thousand floats fit on exactly that, plus the operator's own
 * judgement calls about which of them were worth shipping. The machine-local
 * ADR (`docs/decisions/2026-08-08-privacy-records-machine-local.md`) covers the
 * path, and the issue that introduced heads names pooling corpora across peers
 * as refused rather than unimplemented.
 *
 * Blunt on purpose, the same way `privacyNeverFederates.test.js` and
 * `beeperNeverFederates.test.js` are: it matches `jev` and `head` broadly
 * across each federation surface, so a future `jevHead`, `jevCorpus` or
 * `trainedHead` kind trips it whatever it ends up being called.
 *
 * Every filter is paired with a floor on the list it filters. A federation
 * surface that collapsed to `[]` — a renamed export, a registry read too early
 * — would satisfy a bare `.filter(...).toEqual([])` while guarding nothing.
 */

import { describe, it, expect } from 'vitest';
import { basename } from 'path';
import { PEER_SUBSCRIBABLE_KINDS } from './peerSyncShared.js';
import { NON_RECORD_SCHEMA_CATEGORIES, PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { mediaLibraryDirs } from './peerMediaLibrarySync.js';

// `jev` alone would miss a kind called `trainedHead`; `head` alone would fire
// on an unrelated `headshot`. Both, anchored on a word-ish boundary.
const JEV_TERMS = /jev|trained_?head|head_?weights|scope_?adherence/i;
const mentionsJev = (value) => JEV_TERMS.test(String(value));

/**
 * A media-library walk entry that would carry `data/jev/` to a peer.
 *
 * Matched on the BASENAME only, for the reason the Beeper guard states: entries
 * are always `<installRoot>/data/<kind>`, so matching any path segment would
 * also fire on an ancestor directory that merely happens to be called `jev`.
 */
const namesJevMedia = ({ kind, dir }) => mentionsJev(kind) || /^jev/i.test(basename(String(dir)));

describe('trained jev heads and their corpora never federate (#7689)', () => {
  it('exposes no jev kind to peer-sync subscriptions', () => {
    expect(PEER_SUBSCRIBABLE_KINDS.length).toBeGreaterThan(10);
    expect(PEER_SUBSCRIBABLE_KINDS.filter(mentionsJev)).toEqual([]);
  });

  it('declares no jev wire-schema category', () => {
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).length).toBeGreaterThan(15);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].length).toBeGreaterThan(1);
    expect(Object.keys(PORTOS_SCHEMA_VERSIONS).filter(mentionsJev)).toEqual([]);
    expect([...NON_RECORD_SCHEMA_CATEGORIES].filter(mentionsJev)).toEqual([]);
  });

  // Explicit timeout: the lazy import resolves the whole dataSync service graph
  // inside the test body (see privacyNeverFederates.test.js for why that cost
  // is paid here rather than at module load).
  it('declares no jev dataSync snapshot category', async () => {
    const { getSupportedCategories } = await import('../dataSync.js');
    expect(getSupportedCategories().length).toBeGreaterThan(5);
    expect(getSupportedCategories().filter(mentionsJev)).toEqual([]);
  }, 30000);

  // The media-library manifest is the OTHER way `data/` bytes reach a peer: it
  // walks whole directories rather than record kinds, so no schema-version or
  // subscription guard above covers it.
  it('carries no jev directory into the media-library federation walk', () => {
    const dirs = mediaLibraryDirs();
    // Non-vacuity pin: image, video, audio, music.
    expect(dirs).toHaveLength(4);
    expect(dirs.filter(namesJevMedia)).toEqual([]);
  });

  // The BACKUP tier, which is the other decision `data/jev/` needed making
  // explicitly. Corpora and cached embeddings are regenerable bulk and are
  // excluded; a trained head is NOT regenerable once its corpus is stale, so it
  // must NOT be. Every pattern is anchored with a leading `/` — an unanchored
  // rsync filter matches at any depth and silently drops unrelated user data,
  // which is a data-loss bug (AGENTS.md, "Backup excludes").
  it('excludes jev corpora and embeddings from backups, and retains trained heads', async () => {
    const { DEFAULT_EXCLUDES } = await import('../backup.js');
    const jevEntries = DEFAULT_EXCLUDES.filter((entry) => /^\/jev\//.test(entry.path));
    expect(jevEntries.map((entry) => entry.path).sort()).toEqual(['/jev/corpora/', '/jev/embeddings/']);
    expect(jevEntries.every((entry) => entry.path.startsWith('/'))).toBe(true);
    // The retention half, stated as an assertion rather than an absence: no
    // exclude may match the heads directory.
    expect(DEFAULT_EXCLUDES.filter((entry) => entry.path.includes('/jev/heads'))).toEqual([]);
  }, 30000);

  // Bypass probe — proves the assertions above actually fire.
  it('the guard predicates reject a planted violation', () => {
    expect(['universe', 'jevHead', 'trainedHead'].filter(mentionsJev)).toEqual(['jevHead', 'trainedHead']);
    // The planted dir entry carries a NON-jev kind, so only the basename branch
    // can catch it; the trailing entry pins that an ancestor named `jev` is not
    // itself a violation.
    expect(
      [
        { kind: 'image', dir: '/data/images' },
        { kind: 'weights', dir: '/data/jev' },
        { kind: 'image', dir: '/jev/checkout/data/images' },
      ].filter(namesJevMedia),
    ).toEqual([{ kind: 'weights', dir: '/data/jev' }]);
  });
});
