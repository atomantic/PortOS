import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT_LIB = join(here, '../../client/src/lib');
const CLIENT_README = join(CLIENT_LIB, 'README.md');
const SERVER_README = join(here, 'README.md');

function listTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTestFiles(path);
    return entry.name.endsWith('.test.js') ? [path] : [];
  });
}

// Both catalogs declare mirrors the same way — a backtick-fenced filename in
// column 1, a description in column 2 naming the counterpart path — differing
// only in which side is "this file" vs. "the other file it mirrors". One
// parameterized walker keeps that row-parsing logic from drifting between the
// two catalogs the way the mirrored declarations it guards must not drift.
function listedPairsFor(readme, otherPathRe) {
  const rows = [...readme.matchAll(/^\|\s+`([^`]+\.js)`\s+\|\s+(.+)\|$/gm)];
  return rows.flatMap(([, thisFile, description]) => {
    if (!/\bmirror/i.test(description)) return [];
    const otherMatch = description.match(otherPathRe);
    if (!otherMatch || otherMatch[1].includes('/') || thisFile !== basename(otherMatch[1])) return [];
    return [{ thisFile, otherFile: otherMatch[1] }];
  });
}

function listedMirrorPairs(readme) {
  return listedPairsFor(readme, /server\/lib\/([\w/-]+\.js)/)
    .map(({ thisFile, otherFile }) => ({ clientFile: thisFile, serverFile: otherFile }));
}

function listedServerMirrorPairs(readme) {
  return listedPairsFor(readme, /client\/src\/lib\/([\w/-]+\.js)/)
    .map(({ thisFile, otherFile }) => ({ clientFile: otherFile, serverFile: thisFile }));
}

function uniquePairs(pairs) {
  return [...new Map(pairs.map((pair) => [`${pair.serverFile}:${pair.clientFile}`, pair])).values()];
}

function missingParityPins(pairs, testSources) {
  return pairs.filter(({ clientFile, serverFile }) => {
    const serverName = basename(serverFile);
    // For a direct mirror, clientFile and serverName are the identical
    // string — so "reads the client copy" and "reads the server copy" can't
    // be proven by a plain substring check on each independently, or the
    // SAME occurrence satisfies both (a client-only test that only imports
    // its own module via `'./example.js'` would otherwise pass as a valid
    // parity pin, and symmetrically for a server-only test — see the two
    // bypass-probe tests below). Strip whichever string just proved
    // "reads the client copy" before checking for server-copy evidence, so
    // the two proofs must come from genuinely different occurrences.
    const clientPathRef = `client/src/lib/${clientFile}`;
    const bareRef = `'./${clientFile}'`;
    return !testSources.some(({ path, source }) => {
      if (path === fileURLToPath(import.meta.url)) return false;
      const inClientLib = path.startsWith(CLIENT_LIB);
      const readsClient = source.includes(clientPathRef) || (inClientLib && source.includes(bareRef));
      if (!readsClient) return false;
      let remainder = source.split(clientPathRef).join('');
      // Only strip the bare-import string when it was actually used as
      // client-copy evidence above (inClientLib) — outside client/src/lib
      // that same bare string is exactly what proves the SERVER copy was
      // read (see catalogTypes.parity.test.js: `from './catalogTypes.js'`
      // alongside the full client path), so stripping it unconditionally
      // would erase legitimate server-copy evidence.
      if (inClientLib) remainder = remainder.split(bareRef).join('');
      return remainder.includes(serverName) || (!inClientLib && remainder.includes(`'./${serverName}'`));
    });
  });
}

describe('declared server/client mirror coverage', () => {
  const readme = readFileSync(CLIENT_README, 'utf8');
  const pairs = uniquePairs([
    ...listedMirrorPairs(readme),
    ...listedServerMirrorPairs(readFileSync(SERVER_README, 'utf8')),
  ]);
  const testSources = [...listTestFiles(here), ...listTestFiles(CLIENT_LIB)].map((path) => ({
    path,
    source: readFileSync(path, 'utf8'),
  }));

  it('finds direct same-name mirror declarations in the client catalog', () => {
    expect(pairs).toContainEqual({ clientFile: 'seasonStructure.js', serverFile: 'seasonStructure.js' });
    expect(pairs).toContainEqual({ clientFile: 'shotGrammar.js', serverFile: 'shotGrammar.js' });
    expect(pairs).toContainEqual({ clientFile: 'appIdentity.js', serverFile: 'appIdentity.js' });
    expect(pairs).toContainEqual({ clientFile: 'issueLength.js', serverFile: 'issueLength.js' });
  });

  it('also includes direct same-name declarations from the server catalog', () => {
    expect(pairs).toContainEqual({ clientFile: 'catalogTypes.js', serverFile: 'catalogTypes.js' });
  });

  it('requires every declared direct mirror to have a test that reads both copies', () => {
    const missing = missingParityPins(pairs, testSources);
    expect(missing, `missing parity pins: ${missing.map(({ clientFile }) => clientFile).join(', ')}`).toEqual([]);
  });

  it('reports a synthetic declared mirror when no test reads both copies', () => {
    const synthetic = listedMirrorPairs('| `example.js` | Mirror of `server/lib/example.js`. |');
    expect(missingParityPins(synthetic, [])).toEqual([
      { clientFile: 'example.js', serverFile: 'example.js' },
    ]);
  });

  it('does not accept a same-name server-only unit test as a parity pin (bypass probe)', () => {
    // A direct mirror's clientFile and serverFile are the same string, so a
    // plain server-side unit test importing its own module via a bare
    // relative path (e.g. `bareUrl.test.js` doing `from './bareUrl.js'`)
    // trivially contains both `'./example.js'` and the server filename
    // without ever touching the client copy. Pin that this does NOT count.
    const synthetic = listedMirrorPairs('| `example.js` | Mirror of `server/lib/example.js`. |');
    const serverOnlyUnitTest = {
      path: join(here, 'example.test.js'),
      source: "import { thing } from './example.js';\n",
    };
    expect(missingParityPins(synthetic, [serverOnlyUnitTest])).toEqual([
      { clientFile: 'example.js', serverFile: 'example.js' },
    ]);
  });

  it('does not accept a same-name client-only unit test as a parity pin (bypass probe)', () => {
    // The mirror image of the probe above: a plain client-side unit test
    // importing its own module via a bare relative path (e.g.
    // client/src/lib/catalogTypes.test.js doing `from './catalogTypes.js'`)
    // never touches the server copy. Pin that this does NOT count either.
    const synthetic = listedMirrorPairs('| `example.js` | Mirror of `server/lib/example.js`. |');
    const clientOnlyUnitTest = {
      path: join(CLIENT_LIB, 'example.test.js'),
      source: "import { thing } from './example.js';\n",
    };
    expect(missingParityPins(synthetic, [clientOnlyUnitTest])).toEqual([
      { clientFile: 'example.js', serverFile: 'example.js' },
    ]);
  });
});
