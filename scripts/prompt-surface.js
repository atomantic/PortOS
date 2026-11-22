#!/usr/bin/env node
/**
 * Deterministic snapshot + diff of the model-facing prompt surface: the
 * Persistent Mind tool prompt, the Agent Tools MCP manifest, the voice tool
 * registry and the HTTP semantic catalog (#17395).
 *
 *   node scripts/prompt-surface.js render [--out <dir>]
 *   node scripts/prompt-surface.js diff <baseDir> <headDir>
 *
 * `render` imports the production assembly code with the clock pinned, a
 * throwaway data root and the file storage backend, so it never reads live
 * `data/`, Postgres or the network. Layout: `surfaces.json` (token counts and
 * tool names), `prompts/<surface>.txt`, `tools/<tool>.json` (plus
 * `tools/<tool>.<surface>.json` only when surfaces serve different schemas, so
 * a shared description edit is one diff hunk). Tokens are a chars/4 estimate:
 * deterministic and dependency-free, meant for deltas, not billing.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_OUT_DIR = join(REPO_ROOT, 'server/test/fixtures/prompt-surface');
export const PINNED_CLOCK = '2026-01-01T00:00:00.000Z';

export const estimateTokens = (text) => Math.ceil(text.length / 4);
const stable = (value) => JSON.stringify(value, null, 2);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const schemaKey = (tool) => stable(tool);

function scrubber(extraRoots) {
  const roots = [...extraRoots, REPO_ROOT, homedir()]
    .flatMap((root) => [root, root.replaceAll('\\', '/')])
    .map((root) => root.replace(/[\\/]+$/, ''))
    .filter((root) => root.length > 3);
  const placeholders = new Map(roots.map((root) => [root, extraRoots.includes(root) ? '<DATA_DIR>' : '<PORTOS_ROOT>']));
  const ordered = [...placeholders.keys()].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((out, root) => out.split(root).join(placeholders.get(root)), text);
}

// Every surface hands back { prompt, tools: [{ name, description, schema, ...extras }] }.
async function collectSurfaces() {
  const { createDefaultPersistentMindCapabilities } = await import('../server/lib/persistent/persistentMindCapabilities.js');
  const { TOOL_ACTIVATION_FAMILIES } = await import('../server/lib/persistent/persistentMindToolActivation.js');
  const { buildPersistentMindToolPrompt, getCosToolCatalog } = await import('../server/services/cos/cosToolRegistry.js');
  const { createAgentContextContract } = await import('../server/services/agent/agentContextMcp.js');
  const { getToolSpecs } = await import('../server/services/voice/tools.js');

  const grants = Object.fromEntries(Object.entries(createDefaultPersistentMindCapabilities())
    .filter(([key, value]) => typeof value === 'boolean' && key !== 'toolExposureAllSchemas')
    .map(([key]) => [key, true]));
  const catalogTool = (tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.input_schema,
    sideEffect: tool.policy.sideEffect,
  });
  const mindSurface = async (activatedFamilies) => {
    let selected = [];
    const prompt = await buildPersistentMindToolPrompt(grants, [], { activatedFamilies, onSelection: (names) => { selected = names; } });
    const catalog = getCosToolCatalog({ scope: 'mind', capabilities: grants });
    return { prompt, tools: catalog.tools.filter((tool) => selected.includes(tool.name)).map(catalogTool) };
  };

  const contract = createAgentContextContract({ readRecipeCatalog: async () => [], getSourceStatus: async () => 'fresh' });
  const manifest = await contract.getManifest({ agentContext: { enabled: true, actions: grants } });
  const { tools: manifestTools, ...manifestBody } = manifest;

  return {
    'mind.baseline': await mindSurface([]),
    'mind.all-families': await mindSurface([...TOOL_ACTIVATION_FAMILIES]),
    'agent.mcp': {
      prompt: stable(manifestBody),
      tools: manifestTools.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) })),
    },
    'voice.default': {
      prompt: '',
      tools: getToolSpecs().map((spec) => ({ name: spec.function.name, description: spec.function.description, schema: spec.function.parameters })),
    },
    'ui.semantic': { prompt: '', tools: getCosToolCatalog({ scope: 'ui' }).tools.map(catalogTool) },
  };
}

/** Pure: turn collected surfaces into { relativePath: text } files. */
export function layoutSnapshot(surfaces, scrub = (text) => text) {
  const files = {};
  const manifest = {};
  const variants = new Map(); // tool name -> Map(serialized -> [surfaces])
  for (const [surface, { prompt, tools }] of Object.entries(surfaces)) {
    const sorted = [...tools].sort(byName);
    files[`prompts/${surface}.txt`] = scrub(prompt);
    manifest[surface] = {
      promptTokens: estimateTokens(scrub(prompt)),
      toolCount: sorted.length,
      toolTokens: estimateTokens(scrub(stable(sorted))),
      tools: sorted.map((tool) => tool.name),
    };
    for (const tool of sorted) {
      const forTool = variants.get(tool.name) ?? new Map();
      const key = schemaKey(tool);
      forTool.set(key, [...(forTool.get(key) ?? []), surface]);
      variants.set(tool.name, forTool);
    }
  }
  for (const [name, forTool] of variants) {
    const fileSafe = name.replace(/[^A-Za-z0-9._-]/g, '_');
    for (const [serialized, owners] of forTool) {
      const file = forTool.size === 1 ? `tools/${fileSafe}.json` : `tools/${fileSafe}.${owners[0]}.json`;
      files[file] = scrub(serialized);
    }
  }
  files['surfaces.json'] = stable({ clock: PINNED_CLOCK, surfaces: manifest });
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, `${v}\n`]));
}

export async function renderSnapshot(outDir) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'prompt-surface-'));
  // Set before any server import: path constants resolve at module load.
  Object.assign(process.env, { NODE_ENV: 'test', MEMORY_BACKEND: 'file', PORTOS_DATA_ROOT: dataRoot, TZ: 'UTC' });
  const RealDate = Date;
  const pinned = new RealDate(PINNED_CLOCK).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [pinned])); }
    static now() { return pinned; }
  };
  try {
    const files = layoutSnapshot(await collectSurfaces(), scrubber([dataRoot]));
    rmSync(outDir, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
      const target = join(outDir, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, text);
    }
    return files;
  } finally {
    globalThis.Date = RealDate;
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function readSnapshotDir(dir) {
  const files = {};
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else files[next] = readFileSync(join(dir, next), 'utf8');
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const paramNames = (schema) => Object.keys(schema?.properties ?? {});

/** Pure: Markdown token-delta summary of two `layoutSnapshot` file maps. */
export function diffSnapshots(base, head) {
  const surfaces = (files) => JSON.parse(files['surfaces.json'] ?? '{"surfaces":{}}').surfaces;
  const [b, h] = [surfaces(base), surfaces(head)];
  const names = [...new Set([...Object.keys(b), ...Object.keys(h)])].sort();
  const lines = ['| surface | prompt tok | tools | tool-schema tok |', '| --- | ---: | ---: | ---: |'];
  let changedSurface = false;
  for (const name of names) {
    const [x, y] = [b[name] ?? { promptTokens: 0, toolCount: 0, toolTokens: 0 }, h[name] ?? { promptTokens: 0, toolCount: 0, toolTokens: 0 }];
    const deltas = [y.promptTokens - x.promptTokens, y.toolCount - x.toolCount, y.toolTokens - x.toolTokens];
    if (deltas.some(Boolean) || !b[name] || !h[name]) changedSurface = true;
    lines.push(`| ${name} | ${y.promptTokens} (${signed(deltas[0])}) | ${y.toolCount} (${signed(deltas[1])}) | ${y.toolTokens} (${signed(deltas[2])}) |`);
  }
  const toolFiles = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((f) => f.startsWith('tools/')).sort();
  const toolLines = [];
  for (const file of toolFiles) {
    if (base[file] === head[file]) continue;
    if (base[file] === undefined) { toolLines.push(`- \`${file}\` added`); continue; }
    if (head[file] === undefined) { toolLines.push(`- \`${file}\` removed`); continue; }
    const [x, y] = [JSON.parse(base[file]), JSON.parse(head[file])];
    const [px, py] = [paramNames(x.schema), paramNames(y.schema)];
    const parts = [
      ...py.filter((p) => !px.includes(p)).map((p) => `param \`${p}\` added`),
      ...px.filter((p) => !py.includes(p)).map((p) => `param \`${p}\` removed`),
      ...(x.description !== y.description ? [`description ${estimateTokens(y.description) - estimateTokens(x.description) >= 0 ? '+' : ''}${estimateTokens(y.description) - estimateTokens(x.description)} tok`] : []),
    ];
    toolLines.push(`- \`${file}\` changed: ${parts.join(', ') || 'schema details changed'}`);
  }
  const promptChanged = Object.keys({ ...base, ...head }).filter((f) => f.startsWith('prompts/') && base[f] !== head[f]);
  if (!changedSurface && !toolLines.length && !promptChanged.length) return 'No prompt-surface changes.\n';
  return `${[
    '## Prompt surface delta', '', ...lines,
    ...(promptChanged.length ? ['', '### Prompt text changed', ...promptChanged.map((f) => `- \`${f}\``)] : []),
    ...(toolLines.length ? ['', '### Tool changes', ...toolLines] : []),
  ].join('\n')}\n`;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'render') {
    const outIndex = rest.indexOf('--out');
    if (rest.length && (outIndex !== 0 || !rest[1] || rest.length > 2)) throw new Error('usage: render [--out <dir>]');
    const out = outIndex === 0 ? resolve(rest[1]) : DEFAULT_OUT_DIR;
    const files = await renderSnapshot(out);
    console.log(`📸 Rendered ${Object.keys(files).length} prompt-surface files to ${out === DEFAULT_OUT_DIR ? 'server/test/fixtures/prompt-surface' : out}`);
  } else if (command === 'diff' && rest.length === 2) {
    process.stdout.write(diffSnapshots(readSnapshotDir(resolve(rest[0])), readSnapshotDir(resolve(rest[1]))));
  } else {
    throw new Error('usage: prompt-surface.js render [--out <dir>] | diff <baseDir> <headDir>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(() => process.exit(0), (error) => {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  });
}

export { readSnapshotDir };
