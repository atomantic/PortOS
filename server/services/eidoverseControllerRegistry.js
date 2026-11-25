/**
 * The fixed registry of executable Eidoverse world controllers (#7456).
 *
 * BEHAVIOR is code PortOS ships; an INSTALL is authored data that may only name an
 * id. This is the only bridge, resolving by id against a fixed directory, never a
 * caller path (see `eidoverseResilienceContributions.js`: importing a request-named
 * module is arbitrary code execution). No path-taking export exists here.
 *
 * A definition declares:
 *   - `id`: the slug an install names; must match its filename's slug.
 *   - `title` / `summary`: what an author sees when choosing one.
 *   - `configSchema`: Zod schema for the install's `config` (refused at INSTALL time).
 *   - `createState(config)`: initial durable state.
 *   - `step(state, { tick, config })`: advances one tick SYNCHRONOUSLY, returning
 *     `{ state, effects? }` (sandbox rules: `lib/eidoverseControllers.js`).
 *   - `invariants` (optional): `(state, tick) => …` predicates the assay reuses.
 *
 * `controllerAssayContributions()` is the assay's second contribution source, so a
 * `controller` foundation can name its controller's id as its `contributionId`.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFINITIONS_DIR = fileURLToPath(new URL('./eidoverseControllerDefinitions/', import.meta.url));
const DEFINITION_SUFFIX = '.controller.js';

// Shipped modules cannot change under a running process: import once.
let definitionsPromise = null;

async function importDefinition(file) {
  const mod = await import(pathToFileURL(join(DEFINITIONS_DIR, file)).href);
  const factory = typeof mod.default === 'function' ? mod.default : null;
  if (!factory) throw new Error(`${file} must export a default zero-argument controller factory`);
  const definition = factory();
  if (!definition?.id || typeof definition.step !== 'function' || typeof definition.createState !== 'function' || !definition.configSchema) {
    throw new Error(`${file} produced a definition without an id, a configSchema, a createState() and a step() function`);
  }
  return definition;
}

async function loadDefinitions() {
  const files = (await readdir(DEFINITIONS_DIR)).filter((file) => file.endsWith(DEFINITION_SUFFIX)).sort();
  const definitions = new Map();
  for (const file of files) {
    const definition = await importDefinition(file);
    if (definitions.has(definition.id)) throw new Error(`two controller definitions claim the id "${definition.id}"`);
    definitions.set(definition.id, definition);
  }
  return definitions;
}

function definitions() {
  // A failed load clears the memo so the next caller retries.
  if (!definitionsPromise) {
    definitionsPromise = loadDefinitions().catch((error) => {
      definitionsPromise = null;
      throw error;
    });
  }
  return definitionsPromise;
}

/**
 * The shipped controller with this id, or `null`: an unknown id reads as one refusal
 * reason, and a ledger from a NEWER install disarms that controller instead of failing the pass.
 */
export async function findControllerDefinitionById(controllerId) {
  return (await definitions()).get(controllerId) || null;
}

/** What an author needs to choose a controller: id, title, summary, example config (not the Zod schema). */
export async function describeControllerDefinitions() {
  return [...(await definitions()).values()].map((definition) => ({
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    exampleConfig: definition.exampleConfig ?? {},
  }));
}

/**
 * Every shipped controller, shaped as a resilience-assay contribution
 * (`{ id, description, createSandbox, invariants }`). `createSandbox()` wraps the
 * real `step` the supervisor calls. `applyDisturbance` is generic: it re-serializes
 * the state and discards everything else, which is what a restart does.
 */
export async function controllerAssayContributions() {
  return [...(await definitions()).values()].map((definition) => ({
    id: definition.id,
    description: definition.summary,
    createSandbox() {
      // Through the definition's own schema, so a stale documented example fails the assay instead of replaying something no install could produce.
      const config = definition.configSchema.parse(definition.exampleConfig ?? {});
      return {
        worldState: definition.createState(config),
        controller: {
          step: (worldState, tick) => definition.step(worldState, { tick, config }).state,
          applyDisturbance: (worldState) => JSON.parse(JSON.stringify(worldState)),
        },
        projectionSource: {},
      };
    },
    invariants: definition.invariants ?? [],
  }));
}
