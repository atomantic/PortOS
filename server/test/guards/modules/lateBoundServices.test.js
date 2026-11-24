/**
 * Rule: every `loadLateBoundService('<name>')` call names a loader in
 * `services/serviceLoaders.js`, every loader has a caller, and only `server/index.js`
 * (or a test) imports that composition root (#17896).
 * Why: an unregistered name fails only when its path runs, and a service that
 * imports the root links its importers to every late-bound module again.
 * Fix: add the loader to `SERVICE_LOADERS`; a test registers the loader it needs
 * with `registerLateBoundService`.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';
import { SERVICE_LOADERS } from '../../../services/serviceLoaders.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');
const SEAM = 'lib/lateBoundServices.js';
const ROOT = 'services/serviceLoaders.js';
const CALL_RE = /\bloadLateBoundService\(\s*([^)]*?)\s*\)/g;
const LITERAL_RE = /^'(\w+)'$/;
const ROOT_IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"][^'"]*\/serviceLoaders\.js['"]/;

const sources = trackedFiles(SERVER_ROOT, ['*.js', '*.mjs'])
  .filter((file) => file && !file.includes('.test.') && file !== SEAM && file !== ROOT)
  .map((file) => ({ file, text: readText(join(SERVER_ROOT, file)) }));
const calls = sources.flatMap(({ file, text }) => [...text.matchAll(CALL_RE)].map(([, argument]) => ({ file, argument })));

describe('late-bound service seams', () => {
  it('names a registered loader by literal at every call', () => {
    const offenders = calls.filter(({ argument }) => !Object.hasOwn(SERVICE_LOADERS, argument.match(LITERAL_RE)?.[1] ?? ''));
    expect(offenders).toEqual([]);
  });

  it('keeps no loader without a caller', () => {
    const named = new Set(calls.map(({ argument }) => argument.match(LITERAL_RE)?.[1]));
    expect(Object.keys(SERVICE_LOADERS).filter((name) => !named.has(name))).toEqual([]);
  });

  it('imports the composition root from the server entry point only', () => {
    expect(sources.filter(({ text }) => ROOT_IMPORT_RE.test(text)).map(({ file }) => file)).toEqual(['index.js']);
  });
});
