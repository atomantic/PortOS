/**
 *  Shared slashdo rendering and immutable prompt bundles for CoS agents.
 *
 * Shared slashdo renderer adapter: `loadSlashdoBundle(cmd, {stripFrontmatter, skipIncludes, defer})`
 * returns an entrypoint and supporting files using the bundled transformer; `loadSlashdoFile` returns
 * a self-contained command; `loadSlashdoLib` expands explicit reads for legacy recipes without
 * traversing see-also links. `writeResolvedSlashdoBody(cmd, body, {files})` stages immutable
 * content-addressed bundles under `PATHS.slashdoResolved`, with relative library paths and the
 * entrypoint written last. Missing required references fail dispatch rather than silently removing
 * workflow gates.
 */
import { createHash } from 'crypto';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { atomicWrite } from './fileCore.js';
import { tryReadFile } from './jsonIo.js';
import { PATHS } from './paths.js';

const DEFAULT_SLASHDO_DIR = fileURLToPath(new URL('../../lib/slashdo', import.meta.url));
const commandCache = new Map();
const libCache = new Map();
const stagedBodies = new Set();
const isBareName = name => typeof name === 'string'
  && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
const normalizedSkips = names => [...new Set(Array.isArray(names)
  ? names.filter(name => typeof name === 'string' && name) : [])].sort();

async function renderBundle(content, options, slashdoDir = DEFAULT_SLASHDO_DIR) {
  // Load only when a command is requested; an uninitialized submodule must not
  // prevent unrelated server modules from loading. Slashdo owns reference and
  // conditional semantics for installed skills and embedded prompts alike.
  const { default: transformer } = await import(pathToFileURL(join(slashdoDir, 'src/transformer.js')).href);
  return transformer.buildPromptBundle(content, join(slashdoDir, 'lib'), options);
}

/**
 * Load a command and its supporting files. Deferred bodies reference lib/*.md;
 * children reference siblings. Read/staging failures propagate so a missing
 * required procedure cannot silently turn into an invocation-only dispatch.
 * Missing top-level commands return null, matching the existing loader contract.
 */
export async function loadSlashdoBundle(commandName, {
  stripFrontmatter = false, skipIncludes = [], defer = true, slashdoDir = DEFAULT_SLASHDO_DIR,
} = {}) {
  if (!isBareName(commandName)) return null;
  const skips = normalizedSkips(skipIncludes);
  const cacheKey = JSON.stringify([slashdoDir, commandName, stripFrontmatter, skips, defer]);
  if (commandCache.has(cacheKey)) return commandCache.get(cacheKey);
  let content = await tryReadFile(join(slashdoDir, 'commands/do', `${commandName}.md`));
  if (!content) return null;
  if (stripFrontmatter) content = content.replace(/^---[\s\S]*?---\s*/, '');
  const bundle = await renderBundle(content, { skipIncludes: skips, teams: false, defer }, slashdoDir);
  commandCache.set(cacheKey, bundle);
  return bundle;
}

/** Self-contained command for consumers without file tools. */
export async function loadSlashdoFile(commandName, options = {}) {
  const bundle = await loadSlashdoBundle(commandName, { ...options, defer: false });
  return bundle?.body ?? null;
}

/**
 * Library recipe for legacy inline callers. Follow explicit includes/reads only:
 * expanding see-also links pulls unrelated reviewer workflows into sanitized
 * recipes and multiplies their context. Commands use the complete graph above.
 */
export async function loadSlashdoLib(libName, { teams = false, slashdoDir = DEFAULT_SLASHDO_DIR } = {}) {
  if (!isBareName(libName)) return null;
  const cacheKey = JSON.stringify([slashdoDir, libName, teams]);
  if (libCache.has(cacheKey)) return libCache.get(cacheKey);
  const content = await tryReadFile(join(slashdoDir, 'lib', `${libName}.md`));
  const body = content ? (await renderBundle(content, { teams, defer: false, followReferences: false }, slashdoDir)).body : null;
  libCache.set(cacheKey, body);
  return body;
}

/**
 * Stage a resolved body and optional supporting files. Content-addressed paths
 * keep an already-dispatched run stable across submodule updates and different
 * reviewer selections. Publish the entrypoint only after every reference exists.
 */
export async function writeResolvedSlashdoBody(commandName, body, { files = {} } = {}) {
  if (!body || !isBareName(commandName)) return null;
  const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, content] of entries) {
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:md|sh)$/.test(name) || typeof content !== 'string') {
      throw new Error('Invalid slashdo supporting file');
    }
  }
  const digest = createHash('sha256').update(JSON.stringify([body, entries])).digest('hex');
  const directory = join(PATHS.slashdoResolved, `${commandName}-${digest}`);
  const filePath = entries.length ? join(directory, 'workflow.md') : `${directory}.md`;
  if (stagedBodies.has(filePath)) return filePath;
  for (const [name, content] of entries) {
    await atomicWrite(join(directory, 'lib', name), content);
  }
  await atomicWrite(filePath, body);
  stagedBodies.add(filePath);
  return filePath;
}
