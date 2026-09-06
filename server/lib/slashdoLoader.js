/** Shared slashdo rendering and immutable prompt bundles for CoS agents. */
import { createHash } from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { atomicWrite, PATHS, tryReadFile } from './fileUtils.js';

const commandCache = new Map();
const libCache = new Map();
const stagedBodies = new Set();
const isBareName = name => typeof name === 'string'
  && /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
const normalizedSkips = names => [...new Set(Array.isArray(names)
  ? names.filter(name => typeof name === 'string' && name) : [])].sort();

async function renderBundle(content, options) {
  // Load only when a command is requested; an uninitialized submodule must not
  // prevent unrelated server modules from loading. Slashdo owns reference and
  // conditional semantics for installed skills and embedded prompts alike.
  const { default: transformer } = await import(pathToFileURL(join(PATHS.slashdo, 'src/transformer.js')).href);
  return transformer.buildPromptBundle(content, join(PATHS.slashdo, 'lib'), options);
}

/**
 * Load a command and its supporting files. Deferred bodies reference lib/*.md;
 * children reference siblings. Read/staging failures propagate so a missing
 * required procedure cannot silently turn into an invocation-only dispatch.
 * Missing top-level commands return null, matching the existing loader contract.
 */
export async function loadSlashdoBundle(commandName, {
  stripFrontmatter = false, skipIncludes = [], defer = true,
} = {}) {
  if (!isBareName(commandName)) return null;
  const skips = normalizedSkips(skipIncludes);
  const cacheKey = JSON.stringify([commandName, stripFrontmatter, skips, defer]);
  if (commandCache.has(cacheKey)) return commandCache.get(cacheKey);
  let content = await tryReadFile(join(PATHS.slashdo, 'commands/do', `${commandName}.md`));
  if (!content) return null;
  if (stripFrontmatter) content = content.replace(/^---[\s\S]*?---\s*/, '');
  const bundle = await renderBundle(content, { skipIncludes: skips, teams: false, defer });
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
export async function loadSlashdoLib(libName, { teams = false } = {}) {
  if (!isBareName(libName)) return null;
  const cacheKey = JSON.stringify([libName, teams]);
  if (libCache.has(cacheKey)) return libCache.get(cacheKey);
  const content = await tryReadFile(join(PATHS.slashdo, 'lib', `${libName}.md`));
  const body = content ? (await renderBundle(content, { teams, defer: false, followReferences: false })).body : null;
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
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.md$/.test(name) || typeof content !== 'string') {
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
