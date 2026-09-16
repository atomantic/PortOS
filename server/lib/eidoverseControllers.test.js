/**
 * The sandbox boundary is the security-relevant surface of #7456 — everything
 * else about a controller is scheduling — so it gets focused tests here rather
 * than only being observed through the runtime. Each case is a refusal that
 * would be ambiguous or invisible one level up: a controller that escapes the
 * synchronous rule, that grows without bound, or that proposes an effect
 * outside the closed vocabulary all look like "the tick failed" from the
 * supervisor's side.
 */

import { describe, it, expect } from 'vitest';
import {
  EIDOVERSE_CONTROLLER_LIMITS,
  controllerTickDue,
  eidoverseControllerInstallSchema,
  nextControllerTickAt,
  runControllerStep,
  summarizeControllerInstall,
} from './eidoverseControllers.js';

const definitionThat = (step) => ({ id: 'probe', step });

describe('runControllerStep', () => {
  it('advances state and returns the validated effects a controller proposed', () => {
    const outcome = runControllerStep({
      definition: definitionThat((state, { tick, config }) => ({
        state: { ...state, seen: state.seen + 1, label: config.label, lastTick: tick },
        effects: [{ kind: 'note', text: 'counted' }],
      })),
      state: { seen: 1 },
      config: { label: 'probe' },
      tick: 7,
    });

    expect(outcome).toMatchObject({ ok: true, reason: null });
    expect(outcome.state).toEqual({ seen: 2, label: 'probe', lastTick: 7 });
    expect(outcome.effects).toEqual([{ kind: 'note', text: 'counted' }]);
  });

  it('refuses an async step, so the tick path cannot reach a provider or the network', async () => {
    const outcome = runControllerStep({
      definition: definitionThat(async () => ({ state: {} })),
      state: {},
      config: {},
      tick: 0,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/returned a Promise/);
    expect(outcome.reason).toMatch(/AI-provider call/);
  });

  it('turns a throwing controller into a recorded reason rather than an exception', () => {
    const outcome = runControllerStep({
      definition: definitionThat(() => { throw new Error('boom'); }),
      state: {},
      config: {},
      tick: 0,
    });

    expect(outcome).toMatchObject({ ok: false, state: null });
    expect(outcome.reason).toMatch(/step\(\) threw: boom/);
  });

  it('hands the controller a copy, so it cannot retain a reference into the stored record', () => {
    const stored = { nested: { count: 0 } };
    let captured = null;
    runControllerStep({
      definition: definitionThat((state) => { captured = state; return { state }; }),
      state: stored,
      config: {},
      tick: 0,
    });

    captured.nested.count = 99;
    expect(stored.nested.count).toBe(0);
  });

  it('refuses state that cannot serialize or that grows past the cap', () => {
    const unserializable = runControllerStep({
      definition: definitionThat(() => ({ state: { circular: BigInt(1) } })),
      state: {},
      config: {},
      tick: 0,
    });
    expect(unserializable.ok).toBe(false);

    const oversized = runControllerStep({
      definition: definitionThat(() => ({ state: { blob: 'x'.repeat(EIDOVERSE_CONTROLLER_LIMITS.stateBytes + 1) } })),
      state: {},
      config: {},
      tick: 0,
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.reason).toMatch(/over the \d+-byte cap/);
  });

  it('leaves state untouched when a step returns nothing, which is an ordinary quiet tick', () => {
    const outcome = runControllerStep({
      definition: definitionThat(() => undefined),
      state: { kept: true },
      config: {},
      tick: 3,
    });

    expect(outcome).toMatchObject({ ok: true, state: { kept: true }, effects: [] });
  });

  it('refuses an effect outside the closed vocabulary, including a world verb it invented', () => {
    const unknownKind = runControllerStep({
      definition: definitionThat((state) => ({ state, effects: [{ kind: 'exec', text: 'rm -rf /' }] })),
      state: {},
      config: {},
      tick: 0,
    });
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.reason).toMatch(/outside the permitted vocabulary/);

    const unknownVerb = runControllerStep({
      definition: definitionThat((state) => ({ state, effects: [{ kind: 'augment', operations: [{ verb: 'evaluate', args: {} }] }] })),
      state: {},
      config: {},
      tick: 0,
    });
    expect(unknownVerb.ok).toBe(false);

    const tooMany = runControllerStep({
      definition: definitionThat((state) => ({
        state,
        effects: Array.from({ length: EIDOVERSE_CONTROLLER_LIMITS.effectsPerTick + 1 }, () => ({ kind: 'note', text: 'spam' })),
      })),
      state: {},
      config: {},
      tick: 0,
    });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toMatch(/per-tick cap/);
  });

  it('accepts a bounded augment effect built from the shared world-verb schema', () => {
    const outcome = runControllerStep({
      definition: definitionThat((state) => ({
        state,
        effects: [{ kind: 'augment', operations: [{ verb: 'light', args: { id: 'plaza-lantern', pos: [0, 2, 0] } }] }],
      })),
      state: {},
      config: {},
      tick: 0,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.effects[0].operations).toHaveLength(1);
  });
});

describe('install schema', () => {
  it('defaults effect delivery off, so installing arms bookkeeping and not a world verb', () => {
    const parsed = eidoverseControllerInstallSchema.parse({ id: 'plaza-beacon', controllerId: 'ambient-beacon' });
    expect(parsed).toMatchObject({ deliverEffects: false, armed: true, tickIntervalMs: EIDOVERSE_CONTROLLER_LIMITS.defaultTickIntervalMs });
  });

  it('refuses a cadence outside the supervised bounds', () => {
    expect(eidoverseControllerInstallSchema.safeParse({ id: 'a', controllerId: 'ambient-beacon', tickIntervalMs: 1 }).success).toBe(false);
    expect(eidoverseControllerInstallSchema.safeParse({
      id: 'a', controllerId: 'ambient-beacon', tickIntervalMs: EIDOVERSE_CONTROLLER_LIMITS.maxTickIntervalMs + 1,
    }).success).toBe(false);
  });
});

describe('scheduling', () => {
  const at = (iso) => Date.parse(iso);

  it('only considers an armed install due, and never replays a missed backlog', () => {
    const record = { armed: true, tickIntervalMs: 60_000, nextTickAt: '2026-01-01T00:00:00.000Z' };
    expect(controllerTickDue(record, at('2026-01-04T00:00:00.000Z'))).toBe(true);
    expect(controllerTickDue({ ...record, armed: false }, at('2026-01-04T00:00:00.000Z'))).toBe(false);

    // Three days late, and the next tick is still one interval from NOW.
    expect(nextControllerTickAt(record, at('2026-01-04T00:00:00.000Z'))).toBe('2026-01-04T00:01:00.000Z');
  });

  it('treats an unparseable nextTickAt as due rather than as never', () => {
    expect(controllerTickDue({ armed: true, nextTickAt: 'whenever' }, Date.now())).toBe(true);
  });
});

describe('summarizeControllerInstall', () => {
  const record = {
    id: 'plaza-beacon', controllerId: 'ambient-beacon', armed: true, tick: 4,
    state: { blob: 'x'.repeat(5_000) }, config: { label: 'beacon' }, lastOutcome: null,
  };

  it('keeps the controller state out of a list projection and includes it on an inspect', () => {
    expect(summarizeControllerInstall(record)).not.toHaveProperty('state');
    expect(summarizeControllerInstall(record, { includeState: true })).toMatchObject({ state: record.state, config: record.config });
  });

  it('reports "never stepped" as null rather than collapsing it into a failure', () => {
    expect(summarizeControllerInstall(record).lastTickOk).toBeNull();
    expect(summarizeControllerInstall({ ...record, lastOutcome: { ok: false, reason: 'boom' } }).lastTickOk).toBe(false);
  });
});
