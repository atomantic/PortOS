/**
 * The promote gate's binding between "what was evaluated" and "what gets
 * promoted" (#7625).
 *
 * Every case here is paired: one body per declared kind that the agent-free
 * assay genuinely passes, and one that is deliberately broken in a way only a
 * REPLAY OF THAT BODY can notice. A derivation that always produced a passing
 * sandbox would reproduce the hole this module exists to close, so the failing
 * half is the load-bearing half — a refusal that never fires is the bug.
 *
 * The assay itself (`services/eidoverseResilienceAssay.js`) is run for real
 * rather than stubbed: the contract under test is "this body survives the
 * disturbance suite", and a mocked harness would only prove that the derivation
 * returns an object.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RESILIENCE_DISTURBANCES, runResilienceAssay } from '../services/eidoverseResilienceAssay.js';
import { findControllerDefinitionById } from '../services/eidoverseControllerRegistry.js';
import { buildDistrictTemplateFoundationDraft, generateDistrictTemplatePlacement } from './eidoverseCreativeToolkit.js';
import { controllerDefinitionIdFromBody, derivedContributionId } from './eidoverseFoundations.js';
import { foundationSandbox } from './eidoverseFoundationSandbox.js';

const resolvers = { findControllerDefinition: findControllerDefinitionById };

/** Derive, replay, and report the verdict the promote gate would read. */
const replay = async (record) => {
  const { contribution, refusal } = await foundationSandbox(record, resolvers);
  if (refusal) return { refusal, pass: false, contributionId: null, reasons: [refusal] };
  const verdict = runResilienceAssay(contribution, { disturbances: RESILIENCE_DISTURBANCES });
  return { refusal: null, ...verdict };
};

const ANCHOR = [2, 0, -3];
const templateBody = (overrides = {}) => {
  const declared = { layoutId: 'radial-ring', anchor: ANCHOR, propCount: 4, seed: 'tide', facing: 0 };
  return { ...declared, placement: generateDistrictTemplatePlacement(declared), ...overrides };
};

describe('deriving the assay sandbox from a foundation body', () => {
  it('replays a controller foundation against ITS OWN config, and fails a config the shipped definition rejects', async () => {
    // The regression this pins: the old derivation built its sandbox from
    // `definition.exampleConfig`, so an install whose own controller config was
    // broken still promoted on evidence that UPSTREAM's example survived.
    const authored = { kind: 'controller', id: 'tide-beacon', body: { controller: { definitionId: 'ambient-beacon', config: { label: 'tide', pulseEveryTicks: 2 } } } };
    const passed = await replay(authored);
    expect(passed.refusal).toBeNull();
    expect(passed.pass).toBe(true);
    expect(passed.contributionId).toBe('controller:ambient-beacon');

    const broken = await replay({ ...authored, body: { controller: { definitionId: 'ambient-beacon', config: { pulseEveryTicks: 0 } } } });
    expect(broken.refusal).toMatch(/own controller config does not satisfy "ambient-beacon"/);

    // …while the shipped definition's own example still passes on its own, so
    // the refusal is about this install's config and not about the definition.
    const definition = await findControllerDefinitionById('ambient-beacon');
    const shipped = await replay({ ...authored, body: { controller: { definitionId: 'ambient-beacon', config: definition.exampleConfig } } });
    expect(shipped.pass).toBe(true);
  });

  it('refuses a controller foundation that names no shipped definition', async () => {
    const named = await replay({ kind: 'controller', id: 'tide-beacon', body: { controller: { definitionId: 'not-shipped-anywhere', config: {} } } });
    expect(named.refusal).toMatch(/no shipped controller definition is registered under "not-shipped-anywhere"/);

    const unnamed = await replay({ kind: 'controller', id: 'tide-beacon', body: { schema: { pulses: 'integer' } } });
    expect(unnamed.refusal).toMatch(/must declare `body\.controller\.definitionId`/);
  });

  it('replays a district template only when its placement re-derives from its own declarations', async () => {
    const passed = await replay({ kind: 'district-template', id: 'lantern-row', body: templateBody() });
    expect(passed.refusal).toBeNull();
    expect(passed.pass).toBe(true);

    // One hand-edited coordinate: geometry only its author can rebuild.
    const drifted = templateBody();
    drifted.placement = drifted.placement.map((prop, index) => (index === 0 ? { ...prop, yaw: prop.yaw + 1 } : prop));
    const refused = await replay({ kind: 'district-template', id: 'lantern-row', body: drifted });
    expect(refused.refusal).toMatch(/does not reproduce from this template's own layout/);

    const unknownLayout = await replay({ kind: 'district-template', id: 'lantern-row', body: templateBody({ layoutId: 'no-such-layout' }) });
    expect(unknownLayout.refusal).toMatch(/cannot be re-derived from its own declarations/);
  });

  it('replays the district template the shipped creative toolkit authors', async () => {
    // The authoring helper a mind reaches for has to produce a body this gate
    // can replay — otherwise the one documented way to author a template is
    // also the one way to author an unpromotable one.
    const draft = buildDistrictTemplateFoundationDraft({
      id: 'lantern-row', title: 'Lantern Row', summary: 'Lanterns around the plaza.',
      layoutId: 'grid-plot', materialId: 'sunbaked-clay', motifId: 'lantern-row', anchor: ANCHOR, propCount: 5,
    });
    const verdict = await replay(draft);

    expect(verdict.refusal).toBeNull();
    expect(verdict.pass).toBe(true);
  });

  it('replays a declared schema, and refuses a field type no interpreter knows', async () => {
    const passed = await replay({ kind: 'schema', id: 'tide-state', body: { schema: { pulses: 'integer', lastSeen: 'timestamp', peers: 'list' } } });
    expect(passed.refusal).toBeNull();
    expect(passed.pass).toBe(true);
    expect(passed.contributionId).toBe('schema:tide-state');

    const refused = await replay({ kind: 'schema', id: 'tide-state', body: { schema: { pulses: 'whatever-the-author-meant' } } });
    expect(refused.refusal).toMatch(/not an interpretable field type/);
  });

  it('replays declared affordances, and refuses prose or a verb naming an undeclared field', async () => {
    const passed = await replay({
      kind: 'affordance',
      id: 'tide-beacon',
      body: { schema: { pulses: 'integer' }, affordance: { pulse: { summary: 'advance the count', reads: ['pulses'], writes: ['pulses'] } } },
    });
    expect(passed.refusal).toBeNull();
    expect(passed.pass).toBe(true);

    // The exact shape the repo's own canonical fixture used to carry.
    const prose = await replay({ kind: 'affordance', id: 'tide-beacon', body: { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } } });
    expect(prose.refusal).toMatch(/is prose, not a resolvable declaration/);

    const dangling = await replay({
      kind: 'affordance',
      id: 'tide-beacon',
      body: { schema: { pulses: 'integer' }, affordance: { pulse: { reads: ['tideHeight'] } } },
    });
    expect(dangling.refusal).toMatch(/names "tideHeight", which `body\.schema` does not declare/);
  });

  it('fails a controller whose own step breaks under the disturbance suite rather than refusing it up front', async () => {
    // A derivation that only ever refused MALFORMED bodies would still let a
    // well-formed-but-fragile one through, so this pins that the replay itself
    // is what decides: a controller holding state outside `state` does not
    // survive the restart disturbance.
    let leaked = 0;
    const fragile = {
      id: 'leaky-beacon',
      title: 'Leaky beacon',
      summary: 'Keeps its counter outside the durable state.',
      configSchema: z.object({}).strict(),
      createState: () => ({ pulses: 0 }),
      step: (state) => {
        leaked += 1;
        return { state: { ...state, pulses: leaked } };
      },
      invariants: [function pulsesTrackTheDurableState(state, tick) {
        return state.pulses === tick + 1 || { ok: false, reason: `pulses was ${state.pulses} at tick ${tick}` };
      }],
    };
    // Resolved through an injected registry rather than the shipped one, so the
    // fixture does not have to become a shipped controller definition.
    const injected = await foundationSandbox(
      { kind: 'controller', id: 'leaky-beacon', body: { controller: { definitionId: 'leaky-beacon', config: {} } } },
      { findControllerDefinition: async (id) => (id === 'leaky-beacon' ? fragile : null) },
    );
    expect(injected.refusal).toBeNull();
    const replayed = runResilienceAssay(injected.contribution, { disturbances: RESILIENCE_DISTURBANCES });
    expect(replayed.pass).toBe(false);
    expect(replayed.reasons.join(' ')).toMatch(/pulses was/);
  });

  it('refuses a kind with no derivation and a body that is not an object', async () => {
    expect((await foundationSandbox({ kind: 'mystery', id: 'x', body: {} }, resolvers)).refusal).toMatch(/has no sandbox derivation/);
    expect((await foundationSandbox({ kind: 'schema', id: 'x', body: null }, resolvers)).refusal).toMatch(/no body to replay/);
  });
});

describe('the derived binding label', () => {
  it('comes from the controller definition a body names, and otherwise from kind + id', () => {
    expect(derivedContributionId({ kind: 'controller', id: 'tide-beacon', body: { controller: { definitionId: 'ambient-beacon' } } })).toBe('controller:ambient-beacon');
    expect(derivedContributionId({ kind: 'controller', id: 'tide-beacon', body: {} })).toBe('controller:tide-beacon');
    expect(derivedContributionId({ kind: 'district-template', id: 'lantern-row', body: {} })).toBe('district-template:lantern-row');
  });

  it('ignores a definition id shaped like a path, so no label can smuggle one', () => {
    expect(controllerDefinitionIdFromBody({ controller: { definitionId: '../../etc/passwd' } })).toBeNull();
    expect(controllerDefinitionIdFromBody({ controller: { definitionId: 'ambient-beacon' } })).toBe('ambient-beacon');
  });
});
