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
    return !testSources.some(({ path, source }) => (
      path !== fileURLToPath(import.meta.url)
      && (source.includes(`client/src/lib/${clientFile}`) || source.includes(`'./${clientFile}'`))
      && source.includes(serverName)
    ));
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
});
