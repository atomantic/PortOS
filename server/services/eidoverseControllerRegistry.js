/**
 * The fixed registry of executable Eidoverse world controllers (#7456).
 *
 * A controller's BEHAVIOR is code PortOS ships. An INSTALL is data a mind or a
 * user authors, and all it may say about behavior is an id. This module is the
 * only bridge between the two, and it resolves by **id against a fixed
 * directory — never by a caller-supplied path**, for exactly the reason
 * `eidoverseResilienceContributions.js` does: an install arrives from an HTTP
 * body or a mind's tool call, and "import the module this request names" is
 * arbitrary code execution wearing a feature's clothes. There is deliberately
 * no path-taking export here at all; the assay's own `loadContributionModule`
 * exists only because a local CLI is handed a path on purpose.
 *
 * A definition declares:
 *   - `id`: the slug an install names. Must match its filename's slug.
 *   - `title` / `summary`: what an author sees when choosing one.
 *   - `configSchema`: a Zod schema for the install's `config`, so a bad config
 *     is refused at INSTALL time rather than discovered on the first tick.
 *   - `createState(config)`: the controller's initial durable state.
 *   - `step(state, { tick, config })`: advances one tick SYNCHRONOUSLY,
 *     returning `{ state, effects? }`. See `lib/eidoverseControllers.js` for
 *     the sandbox rules the supervisor enforces on the result.
 *   - `invariants` (optional): the same `(state, tick) => …` predicates the
 *     resilience assay runs, reused below.
 *
 * **This registry is the assay's second contribution source.** #7460 shipped
 * `eidoverseResilienceContributions.js` resolving contributions by id out of a
 * fixture directory, with a note that executable controllers would become a
 * second source behind the same resolver. `controllerAssayContributions()` is
 * that source: every shipped controller is replayable by the agent-free assay
 * with no extra authoring, so a `controller` foundation can name its
 * controller's id as its `contributionId` and be gated for promotion on the
 * evidence that it still runs with its author gone. Neither the assay CLI nor
 * the promote path changes shape to get this.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFINITIONS_DIR = fileURLToPath(new URL('./eidoverseControllerDefinitions/', import.meta.url));
const DEFINITION_SUFFIX = '.controller.js';

// Shipped modules cannot change under a running process, so the directory is
// read and imported once and the result held for the lifetime of the process.
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
  // A failed load must not poison the process: clear the memo so the next
  // caller retries rather than inheriting a rejected promise forever.
  if (!definitionsPromise) {
    definitionsPromise = loadDefinitions().catch((error) => {
      definitionsPromise = null;
      throw error;
    });
  }
  return definitionsPromise;
}

/**
 * The shipped controller with this id, or `null` when none matches.
 *
 * Null rather than a throw, so an install naming an id this version does not
 * ship reads as one refusal reason beside the others — and so a supervisor
 * pass over a ledger written by a NEWER install (a downgrade, a restored
 * backup) disarms that one controller with a reason instead of failing the
 * whole pass.
 */
export async function findControllerDefinitionById(controllerId) {
  return (await definitions()).get(controllerId) || null;
}

/** Every shipped controller id, in stable order. */
export async function listControllerDefinitionIds() {
  return [...(await definitions()).keys()];
}

/**
 * What an author needs to choose a controller: id, title, summary, and the
 * example config the definition documents itself with. The Zod schema itself
 * is NOT projected — a mind needs to know what a controller is for, and the
 * install refusal tells it precisely what a bad config got wrong.
 */
export async function describeControllerDefinitions() {
  return [...(await definitions()).values()].map((definition) => ({
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    exampleConfig: definition.exampleConfig ?? {},
  }));
}

/**
 * Every shipped controller, shaped as an agent-free resilience-assay
 * contribution (`{ id, description, createSandbox, invariants }`).
 *
 * `createSandbox()` builds the controller's own initial state from its example
 * config and wraps `step` in the shape the harness calls — which is the same
 * shape the supervisor calls, so the assay is replaying the real tick path and
 * not a parallel description of it. `applyDisturbance` is generic on purpose:
 * the harness's disturbances are about the ENVIRONMENT (a reconnect, a host
 * restart, a missing optional dependency), and a controller that only keeps
 * durable state in `state` survives all three by construction. The
 * `restart-world-host` case proves that by re-serializing the state and
 * throwing away everything else, which is exactly what a restart does.
 */
export async function controllerAssayContributions() {
  return [...(await definitions()).values()].map((definition) => ({
    id: definition.id,
    description: definition.summary,
    createSandbox() {
      // Through the definition's own schema, so the replay runs against the
      // config an INSTALL would get (defaults applied), and so a definition
      // whose documented example no longer satisfies its own schema fails the
      // assay instead of quietly replaying something no install could produce.
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
