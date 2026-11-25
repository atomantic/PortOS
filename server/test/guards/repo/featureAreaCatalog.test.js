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
} from '../../../lib/featureAreas.js';

const files = trackedFiles(REPO_ROOT);
// Independent of the catalog's ownership index: retain every tracked path under each literal prefix.
const filesByPrefix = new Map();
const filesUnder = (prefix) => {
  if (!filesByPrefix.has(prefix)) filesByPrefix.set(prefix, files.filter((file) => file.startsWith(prefix)));
  return filesByPrefix.get(prefix);
};
const foldsGlobCase = process.platform === 'darwin' || process.platform === 'win32';
const startsWithGlobPrefix = (prefix) => {
  if (!foldsGlobCase) return (file) => file.startsWith(prefix);
  // A wildcard segment can match a differently cased literal prefix. Folding the
  // directory too keeps either matcher's case rules from hiding a disagreement.
  const start = new RegExp(`^${RegExp.escape(prefix)}`, 'iu');
  return (file) => start.test(file);
};
const equivalencePrefix = (pattern, directory) => {
  // Escapes and path normalization can change the apparent literal directory.
  if (/\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/.test(pattern)) return '';
  // Brackets and extglobs keep their full directory bucket. In simple patterns,
  // everything before the first star or question mark is literal.
  if (!/^[A-Za-z0-9_./*?-]+$/.test(pattern)) return directory;
  const wildcard = pattern.search(/[*?]/);
  return wildcard === -1 ? pattern : pattern.slice(0, wildcard);
};
const equivalenceBuckets = new Map();
const equivalenceCandidates = (pattern, directory) => {
  const prefix = equivalencePrefix(pattern, directory);
  if (!foldsGlobCase) return filesUnder(prefix);
  if (!equivalenceBuckets.has(prefix)) {
    equivalenceBuckets.set(prefix, files.filter(startsWithGlobPrefix(prefix)));
  }
  return equivalenceBuckets.get(prefix);
};
// Ownership of the whole tree is computed once; each guard below reads it.
let ownersByFile;
const owners = () => ownersByFile ??= new Map(files.map((file) => [file, areasForFile(file)]));
const globMatches = (glob) => expandCodeGlob(glob).flatMap(({ glob: pattern, prefix }) => filesUnder(prefix)
  .filter((file) => matchesCodeGlob(file, pattern)));
const isLive = (glob) => expandCodeGlob(glob).some(({ glob: pattern, prefix }) => filesUnder(prefix)
  .some((file) => matchesCodeGlob(file, pattern)));

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
      .flatMap((glob) => expandCodeGlob(glob).flatMap(({ glob: pattern, prefix }) => equivalenceCandidates(pattern, prefix)
        .filter((file) => matchesCodeGlob(file, pattern) !== posix.matchesGlob(file, pattern))
        .map((file) => `${entry.id}: ${pattern} vs ${file}`))));
    expect(disagreements.slice(0, 20)).toEqual([]);
    expect(globMatches('server/lib/featureAreas.js')).toEqual(['server/lib/featureAreas.js']);
  });

  it('keeps platform matches when narrowing simple wildcard buckets', () => {
    const paths = ['src/Clip.js', 'src/clip.js', 'Src/Clip.js', 'src/Other.js', 'src/nested/Clip.js'];
    for (const [glob, expectedPrefix] of [
      ['src/Clip.js', 'src/Clip.js'],
      ['src/Clip*.js', 'src/Clip'],
      ['src/Cl?p.js', 'src/Cl'],
      ['src/**/Clip*.js', 'src/'],
      ['src/Clip[.-]*', 'src/'],
      ['src/Clip!(Test)*', 'src/'],
      ['src//Clip*.js', ''],
    ]) {
      const [{ prefix }] = expandCodeGlob(glob);
      const candidatePrefix = equivalencePrefix(glob, prefix);
      const candidates = paths.filter(startsWithGlobPrefix(candidatePrefix));
      expect(candidatePrefix, glob).toBe(expectedPrefix);
      for (const matcher of [posix.matchesGlob, matchesCodeGlob]) {
        const matches = (file) => matcher(file, glob);
        expect(candidates.filter(matches), glob).toEqual(paths.filter(matches));
      }
    }
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

  // An audit drops a dormant area by subtracting its globs from the inventory (auditQuality.js) and from the
  // complexity shortlist (`complexity-report.js --exclude`). That subtraction is exact only while no other area
  // claims the same file: a shared file would leave a P1 area's code unaudited.
  it('gives every file at most one owning area', () => {
    const shared = [...owners()]
      .filter(([, areas]) => areas.length > 1)
      .map(([file, areas]) => `${file}: ${areas.map((owner) => owner.id).join(', ')}`);
    expect(shared).toEqual([]);
  });

});
