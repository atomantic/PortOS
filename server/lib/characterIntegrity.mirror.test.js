/**
 * Parity guard: the client's integrity vocabulary must match the server's.
 *
 * `client/src/lib/characterIntegrity.js` cannot import the server module — it
 * reaches `storyBible.js` (crypto + fileUtils) through
 * `universeBibleCompleteness.js`, which has no place in the browser bundle — so
 * the two lists are mirrored by hand. A drift here is not cosmetic: the client
 * decides which findings offer an Augment button from its OWN kind list, so a
 * kind the server can emit but the client doesn't know renders as an unlabeled
 * badge with no repair path, and a status the client doesn't know silently
 * falls out of the "is this cast clean?" check.
 *
 * Reads the client file as TEXT rather than importing it: this suite runs in
 * the server (node) project, which has no React/JSX resolution.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  INTEGRITY_FINDING_KINDS,
  AUGMENTABLE_FINDING_KINDS,
  CHARACTER_REVIEW_STATUSES,
  INCOMPLETE_REVIEW_STATUSES,
  INTEGRITY_DEPTHS,
  INTEGRITY_DIMENSION_IDS,
} from './characterIntegrity.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIENT_LIB = join(REPO_ROOT, 'client', 'src', 'lib', 'characterIntegrity.js');

const source = readFileSync(CLIENT_LIB, 'utf8');

/** Pull `export const NAME = Object.freeze([...])` string members out of the client source. */
const mirroredList = (name) => {
  const match = source.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`client characterIntegrity.js has no ${name} array`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

/** Pull the keys of `export const NAME = Object.freeze({ key: ... })`. */
const mirroredKeys = (name) => {
  const start = source.indexOf(`export const ${name} = Object.freeze({`);
  if (start < 0) throw new Error(`client characterIntegrity.js has no ${name} object`);
  const body = source.slice(start, source.indexOf('\n});', start));
  return [...body.matchAll(/^ {2}'?([a-zA-Z][\w-]*)'?:/gm)].map((m) => m[1]);
};

describe('characterIntegrity client mirror', () => {
  it.each([
    ['INTEGRITY_FINDING_KINDS', INTEGRITY_FINDING_KINDS],
    ['AUGMENTABLE_FINDING_KINDS', AUGMENTABLE_FINDING_KINDS],
    ['CHARACTER_REVIEW_STATUSES', CHARACTER_REVIEW_STATUSES],
    ['INCOMPLETE_REVIEW_STATUSES', INCOMPLETE_REVIEW_STATUSES],
    ['INTEGRITY_DEPTHS', INTEGRITY_DEPTHS],
    ['INTEGRITY_DIMENSION_IDS', INTEGRITY_DIMENSION_IDS],
  ])('%s matches the server list exactly, in order', (name, expected) => {
    expect(mirroredList(name)).toEqual([...expected]);
  });

  it('has badge copy for every finding kind, review status and depth', () => {
    expect(mirroredKeys('FINDING_KIND_META').sort()).toEqual([...INTEGRITY_FINDING_KINDS].sort());
    expect(mirroredKeys('REVIEW_STATUS_META').sort()).toEqual([...CHARACTER_REVIEW_STATUSES].sort());
    expect(mirroredKeys('DEPTH_META').sort()).toEqual([...INTEGRITY_DEPTHS].sort());
  });

  it('labels every dimension the server can attribute a finding to', () => {
    expect(mirroredKeys('DIMENSION_LABELS').sort()).toEqual([...INTEGRITY_DIMENSION_IDS].sort());
  });

  it('marks exactly the augmentable kinds as repairable', () => {
    const repairable = [...INTEGRITY_FINDING_KINDS].filter((kind) => {
      const row = source.match(new RegExp(`\\b${kind}: Object\\.freeze\\(\\{[^}]*\\}\\)`));
      return row ? /repairable: true/.test(row[0]) : false;
    });
    expect(repairable).toEqual([...AUGMENTABLE_FINDING_KINDS]);
  });
});
