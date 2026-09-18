/**
 * Derive the agent-free resilience-assay sandbox for a foundation FROM ITS OWN
 * BODY (#7625, epic #7453).
 *
 * The promote gate's whole promise is "a contribution still works without its
 * creator narrating it". #7460 built the harness and #7455 made the server run
 * it rather than accept a caller's verdict — but the harness was pointed at
 * whatever module the author NAMED (`contributionId`, free text on the
 * authoring surface), never at the foundation being promoted. Any local
 * foundation could name a shipped demo fixture and inherit its pass; peers then
 * inherited on evidence that described the fixture, not the body inside the
 * envelope. This module closes that: the sandbox is derived from `body`, so
 * "what was evaluated" and "what gets promoted" are the same object by
 * construction rather than by an author-supplied string.
 *
 * **This adds no arbitrary-code-execution surface.** Every executable part is
 * still code PortOS ships: a `controller` foundation names a SHIPPED controller
 * definition and supplies only declarative config; the other three kinds are
 * replayed by the interpreters below, which are ordinary PortOS code. What
 * varies per install is the declarative input the install actually authored —
 * which is exactly what the assay needed to be replaying all along.
 *
 * One derivation per declared kind:
 *
 *   - `controller` — `body.controller.definitionId` names a shipped definition
 *     and `body.controller.config` is parsed through that definition's own
 *     `configSchema`. THIS INSTALL'S config is what gets replayed, not
 *     upstream's `exampleConfig`; a broken local config now fails the gate
 *     instead of promoting on evidence about a config nobody runs.
 *   - `district-template` — the declared placement has to REPRODUCE from its
 *     own `{ layoutId, anchor, propCount, seed, facing }` through
 *     `generateDistrictTemplatePlacement()`, and the body is handed to the
 *     harness as the projection source, because a template's consequence is
 *     its projection plan.
 *   - `schema` / `affordance` — replayed through the declarative interpreter
 *     below: a clean world state is built from the declared field types, and
 *     every declared affordance is resolved against it each tick. A declaration
 *     that cannot be interpreted without its author is not promotable, which is
 *     the correct answer rather than a gap.
 *
 * `contributionId` survives only as a DERIVED label (`derivedContributionId()`)
 * so `assayEvidenceRefusal()`'s binding check in `eidoverseFoundations.js` —
 * "the evidence is about this foundation" — keeps working unchanged, and so a
 * receiving peer can re-derive it from the envelope's own `kind`/`body` and
 * catch an envelope whose evidence was minted against something else.
 *
 * Pure: no I/O, no clock, no provider calls. `foundationSandbox()` is async
 * ONLY because resolving a shipped controller definition is; the resolver is
 * injected so this module never imports the service layer.
 */

import { canonicalStringify } from './objects.js';
import { generateDistrictTemplatePlacement } from './eidoverseCreativeToolkit.js';
// Declared beside the schemas that carry the label rather than here, so this
// module can keep reaching the creative toolkit without closing an ESM cycle
// back through it — see `derivedContributionId`'s own note.
import { controllerDefinitionIdFromBody, derivedContributionId } from './eidoverseFoundations.js';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const refuse = (refusal) => ({ contribution: null, refusal });
const accept = (contribution) => ({ contribution, refusal: null });

/**
 * The declared field-type vocabulary a `schema` foundation may use, and the
 * interpreter that gives each one a clean starting value, a per-tick successor,
 * and a conformance check.
 *
 * `advance` derives the next value from the TICK ORDINAL rather than from a
 * clock or a random source, which is what keeps a replay deterministic and
 * lets the harness's own re-invocation of `createSandbox()` per scenario mean
 * something. Every sample is JSON-portable, so the harness's built-in
 * serializability check is a real check and not a formality.
 */
export const EIDOVERSE_DECLARED_FIELD_TYPES = Object.freeze({
  boolean: { sample: () => false, advance: (_prev, tick) => tick % 2 === 0, valid: (value) => typeof value === 'boolean' },
  id: { sample: () => 'declared-0', advance: (_prev, tick) => `declared-${tick}`, valid: (value) => typeof value === 'string' && value.length > 0 },
  integer: { sample: () => 0, advance: (prev) => prev + 1, valid: (value) => Number.isInteger(value) },
  list: { sample: () => [], advance: (prev, tick) => [...prev, tick], valid: (value) => Array.isArray(value) },
  map: { sample: () => ({}), advance: (prev, tick) => ({ ...prev, [`t${tick}`]: tick }), valid: isPlainObject },
  number: { sample: () => 0, advance: (prev) => prev + 0.5, valid: (value) => typeof value === 'number' && Number.isFinite(value) },
  string: { sample: () => 'declared', advance: (_prev, tick) => `tick-${tick}`, valid: (value) => typeof value === 'string' },
  timestamp: {
    sample: () => new Date(0).toISOString(),
    advance: (_prev, tick) => new Date(tick * 1000).toISOString(),
    valid: (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
  },
});

/** The declared field types, sorted, for a reader-facing refusal. */
const DECLARED_TYPE_NAMES = Object.freeze(Object.keys(EIDOVERSE_DECLARED_FIELD_TYPES).sort());

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

/**
 * Replay a `controller` foundation through the shipped definition it names,
 * against the config THIS INSTALL authored.
 *
 * `step` and `applyDisturbance` are shaped exactly as
 * `controllerAssayContributions()` shapes them for the CLI's shipped-controller
 * sweep, so the assay is replaying the real tick path. The difference — the
 * whole point of #7625 — is the config: upstream's `exampleConfig` proves
 * upstream's example survives, which says nothing about an install whose own
 * config is broken.
 */
function controllerSandbox({ body, definition, definitionId, contributionId }) {
  if (!definitionId) {
    return refuse('a `controller` foundation must declare `body.controller.definitionId` naming a shipped controller definition — the assay replays the controller this install actually configured, not one it names in prose');
  }
  if (!definition) {
    return refuse(`no shipped controller definition is registered under "${definitionId}" — this install cannot replay the foundation, so it cannot promote it`);
  }
  const config = definition.configSchema.safeParse(body.controller.config ?? {});
  if (!config.success) {
    const detail = config.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    return refuse(`this foundation's own controller config does not satisfy "${definitionId}"'s schema: ${detail}`);
  }

  return accept({
    id: contributionId,
    description: definition.summary,
    createSandbox() {
      // Re-parsed per sandbox rather than closing over one parsed object: the
      // harness re-invokes `createSandbox()` for every scenario precisely so no
      // state survives between them, and a shared config object would be the
      // one thing that did.
      const scenarioConfig = definition.configSchema.parse(body.controller.config ?? {});
      return {
        worldState: definition.createState(scenarioConfig),
        controller: {
          step: (worldState, tick) => definition.step(worldState, { tick, config: scenarioConfig }).state,
          // Every disturbance in the suite is an ENVIRONMENT event; a
          // controller that keeps its durable state in `state` survives all
          // three, and the round-trip proves it holds no in-process handle.
          applyDisturbance: (worldState) => JSON.parse(JSON.stringify(worldState)),
        },
        projectionSource: {},
      };
    },
    invariants: definition.invariants ?? [],
  });
}

// ---------------------------------------------------------------------------
// district-template
// ---------------------------------------------------------------------------

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isAnchor = (value) => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

/**
 * Replay a `district-template` foundation as its own placement.
 *
 * A template's consequence IS its geometry, and the one thing that makes that
 * geometry author-free is that it re-derives from the declarations beside it.
 * So the gate is: `generateDistrictTemplatePlacement()` run over the body's own
 * `{ layoutId, anchor, propCount, seed, facing }` must reproduce
 * `body.placement` exactly. A template carrying hand-edited coordinates its own
 * declarations no longer produce is a template only its author can rebuild.
 *
 * The body is handed to the harness as `projectionSource`, so the assay's
 * "load projections in a clean sandbox" leg runs `buildProjectionPlan()`
 * against the template rather than against an empty object.
 */
function districtTemplateSandbox({ body, contributionId }) {
  const { layoutId, anchor, propCount, seed, facing, placement } = body;
  if (typeof layoutId !== 'string' || !layoutId.trim()) return refuse('a `district-template` foundation must declare `body.layoutId` — a placement that names no generator cannot be re-derived without its author');
  if (!isAnchor(anchor)) return refuse('a `district-template` foundation must declare `body.anchor` as three finite numbers');
  if (!Array.isArray(placement) || placement.length === 0) return refuse('a `district-template` foundation must declare `body.placement` — the geometry the template produces is the thing being promoted');

  const declared = { layoutId: layoutId.trim(), anchor, propCount, seed, facing };
  let regenerated;
  try {
    regenerated = generateDistrictTemplatePlacement(declared);
  } catch (error) {
    return refuse(`this template's placement cannot be re-derived from its own declarations: ${error.message}`);
  }
  if (canonicalStringify(regenerated) !== canonicalStringify(placement)) {
    return refuse('`body.placement` does not reproduce from this template\'s own layout, anchor, count, seed and facing — a placement only its author can rebuild is not promotable');
  }

  return accept({
    id: contributionId,
    description: `Declared ${declared.layoutId} district template with ${placement.length} props.`,
    createSandbox() {
      return {
        // `scratch` is deliberately NOT part of the template's declarations —
        // it is what the `missing-optional-deps` disturbance takes away, so
        // "the template does not depend on anything it did not declare" is
        // proven rather than assumed.
        worldState: { layoutId: declared.layoutId, anchor: [...anchor], props: instantiateProps(placement), tick: null, scratch: { hint: declared.layoutId } },
        controller: {
          step(worldState, tick) {
            return { ...worldState, props: instantiateProps(generateDistrictTemplatePlacement(declared)), tick };
          },
          applyDisturbance(worldState, disturbance) {
            if (disturbance === 'restart-world-host') return JSON.parse(JSON.stringify(worldState));
            if (disturbance === 'missing-optional-deps') {
              const { scratch: _gone, ...durable } = worldState;
              return durable;
            }
            return worldState;
          },
        },
        projectionSource: body,
      };
    },
    invariants: [
      function propsMatchTheDeclaredPlacement(worldState) {
        const expected = canonicalStringify(instantiateProps(placement));
        if (canonicalStringify(worldState.props) !== expected) {
          return { ok: false, reason: 'the replayed props drifted from the declared placement' };
        }
        return true;
      },
    ],
  });
}

/** Declared placement as world props — ids derived from the ordinal, so the
 * instantiation is as reproducible as the placement it comes from. */
function instantiateProps(placement) {
  return placement.map((prop, index) => ({
    id: `prop-${index}`,
    pos: Array.isArray(prop?.pos) ? prop.pos.map(Number) : null,
    yaw: isFiniteNumber(prop?.yaw) ? prop.yaw : null,
  }));
}

// ---------------------------------------------------------------------------
// schema / affordance
// ---------------------------------------------------------------------------

/**
 * The declarative interpreter behind the `schema` and `affordance` kinds.
 *
 * `body.schema` is `{ fieldName: declaredType }`; `body.affordance` is
 * `{ verb: { summary?, reads?: [...], writes?: [...] } }` naming DECLARED
 * fields. That structure is what makes a declaration interpretable at all: an
 * affordance recorded as free prose ("reads the pulse count") can only be
 * resolved by the person who wrote it, which is precisely the dependency the
 * agent-free assay exists to refuse. An `affordance` foundation therefore has
 * to carry the schema its verbs resolve against.
 *
 * The replay builds a clean world state from the declared types, resolves every
 * affordance against it each tick, and lets the harness's per-tick invariant
 * pass assert that every declared field still holds a value of its declared
 * type and that the whole state stays JSON-portable.
 */
function declarativeSandbox({ kind, body, contributionId }) {
  const schema = body.schema;
  if (!isPlainObject(schema) || Object.keys(schema).length === 0) {
    return refuse(`a \`${kind}\` foundation must declare \`body.schema\` as a non-empty { field: type } map — a state shape nobody can instantiate cannot be replayed without its author`);
  }
  for (const [field, declaredType] of Object.entries(schema)) {
    if (typeof declaredType !== 'string' || !Object.hasOwn(EIDOVERSE_DECLARED_FIELD_TYPES, declaredType)) {
      return refuse(`\`body.schema.${field}\` declares "${declaredType}", which is not an interpretable field type (expected one of ${DECLARED_TYPE_NAMES.join(', ')})`);
    }
  }

  const affordances = body.affordance;
  if (kind === 'affordance' && (!isPlainObject(affordances) || Object.keys(affordances).length === 0)) {
    return refuse('an `affordance` foundation must declare `body.affordance` as a non-empty { verb: … } map');
  }
  const resolved = [];
  for (const [verb, declaration] of Object.entries(isPlainObject(affordances) ? affordances : {})) {
    if (!isPlainObject(declaration)) {
      return refuse(`\`body.affordance.${verb}\` is prose, not a resolvable declaration — declare it as { summary, reads: [...], writes: [...] } naming fields from \`body.schema\``);
    }
    const reads = declaration.reads ?? [];
    const writes = declaration.writes ?? [];
    if (!Array.isArray(reads) || !Array.isArray(writes)) return refuse(`\`body.affordance.${verb}\` must declare \`reads\` and \`writes\` as arrays of field names`);
    if (reads.length === 0 && writes.length === 0) return refuse(`\`body.affordance.${verb}\` touches no declared field — an affordance with no readable consequence cannot be replayed`);
    for (const field of [...reads, ...writes]) {
      if (!Object.hasOwn(schema, field)) return refuse(`\`body.affordance.${verb}\` names "${field}", which \`body.schema\` does not declare`);
    }
    resolved.push({ verb, reads, writes });
  }
  resolved.sort((a, b) => a.verb.localeCompare(b.verb));

  return accept({
    id: contributionId,
    description: `Declared ${Object.keys(schema).length}-field ${kind} with ${resolved.length} resolvable affordance(s).`,
    createSandbox() {
      const fields = Object.fromEntries(Object.entries(schema).map(([field, type]) => [field, EIDOVERSE_DECLARED_FIELD_TYPES[type].sample()]));
      return {
        // `scratch` is undeclared state on purpose — see the district-template
        // sandbox: `missing-optional-deps` removes it, and nothing may miss it.
        worldState: { fields, applied: [], scratch: { kind } },
        controller: {
          step(worldState, tick) {
            const fields = { ...worldState.fields };
            const applied = [];
            for (const { verb, reads, writes } of resolved) {
              for (const field of reads) {
                if (!Object.hasOwn(fields, field)) throw new Error(`affordance "${verb}" reads "${field}", which is no longer present in the world state`);
              }
              for (const field of writes) fields[field] = EIDOVERSE_DECLARED_FIELD_TYPES[schema[field]].advance(fields[field], tick);
              applied.push(verb);
            }
            return { ...worldState, fields, applied, tick };
          },
          applyDisturbance(worldState, disturbance) {
            if (disturbance === 'restart-world-host') return JSON.parse(JSON.stringify(worldState));
            if (disturbance === 'missing-optional-deps') {
              const { scratch: _gone, ...durable } = worldState;
              return durable;
            }
            return worldState;
          },
        },
        projectionSource: {},
      };
    },
    invariants: [
      function declaredFieldsKeepTheirDeclaredTypes(worldState) {
        for (const [field, type] of Object.entries(schema)) {
          if (!Object.hasOwn(worldState.fields || {}, field)) return { ok: false, reason: `declared field "${field}" went missing` };
          if (!EIDOVERSE_DECLARED_FIELD_TYPES[type].valid(worldState.fields[field])) {
            return { ok: false, reason: `declared field "${field}" no longer holds a ${type}` };
          }
        }
        return true;
      },
      function everyDeclaredAffordanceResolved(worldState) {
        if (!Array.isArray(worldState.applied) || worldState.applied.length !== resolved.length) {
          return { ok: false, reason: `expected ${resolved.length} affordance(s) to resolve, saw ${worldState.applied?.length ?? 'none'}` };
        }
        return true;
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The resilience-assay contribution for one foundation, derived from its own
 * body — or a refusal reason when the body cannot be replayed at all.
 *
 * Async only for the `controller` kind's registry read, which is injected:
 * `findControllerDefinition(id)` resolves a SHIPPED definition by id (the
 * ledger and the migration both pass
 * `eidoverseControllerRegistry.js#findControllerDefinitionById`). Nothing here
 * imports the service layer, and no caller-supplied path is ever resolved.
 *
 * @param {{ kind: string, id: string, body: object }} record
 * @param {{ findControllerDefinition: (id: string) => Promise<object|null> }} resolvers
 * @returns {Promise<{ contribution: object|null, refusal: string|null }>}
 */
export async function foundationSandbox({ kind, id, body }, { findControllerDefinition } = {}) {
  if (!isPlainObject(body)) return refuse('this foundation has no body to replay');
  const contributionId = derivedContributionId({ kind, id, body });

  if (kind === 'controller') {
    const definitionId = controllerDefinitionIdFromBody(body);
    const definition = definitionId && findControllerDefinition ? await findControllerDefinition(definitionId) : null;
    return controllerSandbox({ body, definition, definitionId, contributionId });
  }
  if (kind === 'district-template') return districtTemplateSandbox({ body, contributionId });
  if (kind === 'schema' || kind === 'affordance') return declarativeSandbox({ kind, body, contributionId });
  return refuse(`"${kind}" has no sandbox derivation, so nothing can replay it without its author`);
}
