/**
 * The feature-area catalog (server/lib/featureAreas.js) must stay total and live as the tree changes.
 *
 * Every nav page resolves to one area (or is listed as owned by none), every instance feature has an area,
 * and every code glob still matches a tracked file, so renaming a directory fails here instead of silently
 * emptying an area and demoting its files to shared code.
 */
import { describe, it, expect } from 'vitest';
import { posix } from 'node:path';
import { REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';
import { NAV_COMMANDS, getNavCommandForPath } from '../../../lib/navManifest.js';
import { INSTANCE_FEATURE_IDS } from '../../../lib/instanceFeatureRegistry.js';
import {
  FEATURE_AREAS,
  INSTANCE_FEATURES_WITHOUT_AREA,
  NAV_PATHS_WITHOUT_AREA,
  areaForNavPath,
  expandCodeGlob,
  matchesCodeGlob,
  areasForFile,
  isOptionalFeatureArea,
} from '../../../lib/featureAreas.js';

const files = trackedFiles(REPO_ROOT);
// Ownership of the whole tree is computed once; each guard below reads it.
let ownersByFile;
const owners = () => ownersByFile ??= new Map(files.map((file) => [file, areasForFile(file)]));
const globMatches = (glob) => expandCodeGlob(glob).flatMap(({ glob: pattern, prefix }) => files
  .filter((file) => file.startsWith(prefix) && matchesCodeGlob(file, pattern)));
const isLive = (glob) => expandCodeGlob(glob).some(({ glob: pattern, prefix }) => files
  .some((file) => file.startsWith(prefix) && matchesCodeGlob(file, pattern)));

describe('feature area catalog', () => {
  it('has unique kebab-case ids and one owner per nav path prefix', () => {
    const ids = FEATURE_AREAS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    const prefixes = FEATURE_AREAS.flatMap((entry) => entry.navPathPrefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) expect(prefix).toMatch(/^\/[^?#]*[^/]$/);
  });

  it('resolves every nav command path to an area, or lists it as owned by none', () => {
    const unresolved = NAV_COMMANDS
      .map((command) => command.path)
      .filter((path) => !areaForNavPath(path) && !NAV_PATHS_WITHOUT_AREA.includes(path));
    expect(unresolved).toEqual([]);
    for (const path of NAV_PATHS_WITHOUT_AREA) expect(areaForNavPath(path)).toBeNull();
  });

  it('puts a feature-gated page in its own feature area unless a prefix or a twin command at the same path claims it', () => {
    const misplaced = NAV_COMMANDS
      .filter((command) => command.feature && getNavCommandForPath(command.path)?.id === command.id)
      .filter((command) => areaForNavPath(command.path)?.instanceFeatureId !== command.feature)
      .map((command) => `${command.path} -> ${areaForNavPath(command.path)?.id}`);
    expect(misplaced).toEqual([]);
  });

  it('covers every instance feature exactly once and references only registered features', () => {
    const owned = FEATURE_AREAS.map((entry) => entry.instanceFeatureId).filter(Boolean);
    expect(new Set(owned).size).toBe(owned.length);
    for (const id of owned) expect(INSTANCE_FEATURE_IDS).toContain(id);
    for (const id of INSTANCE_FEATURE_IDS) {
      expect(owned.includes(id) || INSTANCE_FEATURES_WITHOUT_AREA.includes(id), id).toBe(true);
    }
    for (const id of INSTANCE_FEATURES_WITHOUT_AREA) {
      expect(INSTANCE_FEATURE_IDS).toContain(id);
      expect(owned).not.toContain(id);
    }
  });

  it('keeps every code glob live so a rename fails here instead of emptying an area', () => {
    const dead = FEATURE_AREAS.flatMap((entry) => entry.codeGlobs
      .filter((glob) => !isLive(glob))
      .map((glob) => `${entry.id}: ${glob}`));
    expect(dead).toEqual([]);
  });

  it('compiles globs to the same matches the platform matchesGlob finds across the tracked tree', () => {
    const disagreements = FEATURE_AREAS.flatMap((entry) => entry.codeGlobs
      .flatMap((glob) => expandCodeGlob(glob).flatMap(({ glob: pattern, prefix }) => files
        .filter((file) => file.startsWith(prefix) && matchesCodeGlob(file, pattern) !== posix.matchesGlob(file, pattern))
        .map((file) => `${entry.id}: ${pattern} vs ${file}`))));
    expect(disagreements.slice(0, 20)).toEqual([]);
    expect(globMatches('server/lib/featureAreas.js')).toEqual(['server/lib/featureAreas.js']);
  });

  it('writes globs that match the same files on case-insensitive and case-sensitive platforms', () => {
    const risky = FEATURE_AREAS.flatMap((entry) => entry.codeGlobs
      .filter((glob) => /\[[^\]]*[A-Za-z]-[A-Za-z]/.test(glob))
      .map((glob) => `${entry.id}: ${glob}`));
    expect(risky).toEqual([]);
  });

  it('owns the contents of every directory an area claims, not just the directory entry', () => {
    const directoryOwners = new Map();
    const orphaned = new Set();
    for (const [file, fileOwners] of owners()) {
      const parts = file.split('/');
      for (let depth = 2; depth < parts.length; depth += 1) {
        const dir = parts.slice(0, depth).join('/');
        if (!directoryOwners.has(dir)) directoryOwners.set(dir, areasForFile(dir));
        for (const entry of directoryOwners.get(dir)) {
          if (!fileOwners.includes(entry)) orphaned.add(`${entry.id}: claims directory ${dir} but not ${file}`);
        }
      }
    }
    expect([...orphaned].slice(0, 20)).toEqual([]);
  });

  it('never lets a core area claim a file an optional area owns', () => {
    const shared = [...owners()]
      .filter(([, areas]) => areas.some(isOptionalFeatureArea) && areas.length > 1)
      .map(([file, areas]) => `${file}: ${areas.map((owner) => owner.id).join(', ')}`);
    expect(shared).toEqual([]);
  });

});
