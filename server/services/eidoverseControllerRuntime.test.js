/**
 * The runtime is where #7456's claim is either true or not: a controller a
 * mind installed has to keep running while that mind is not running.
 *
 * The HELD-OUT test the issue asks for is `still ticks with no mind, no tool
 * call, and no author in the process` below. It installs a controller and then
 * touches nothing a mind touches — no tool dispatch, no wake, no further
 * install — and drives only the supervisor's own clock. Time is injected
 * rather than slept through, so the contract is about cadence and not about
 * how long the suite is willing to wait.
 *
 * The rest of these pin the boundaries a higher-level test could not phrase
 * usefully: that an id is the only thing an install may say about behavior,
 * that arming is reconciled at every gate move rather than only at boot, that
 * a laptop that slept does not wake to a replayed backlog, and that a broken
 * controller stops and says why instead of failing on a schedule forever.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-eidoverse-controllers-'),
}));

const {
  __resetEidoverseControllerRuntimeForTests,
  getEidoverseControllerInstall,
  installEidoverseController,
  isEidoverseControllerSupervisorRegistered,
  listEidoverseControllers,
  retireEidoverseController,
  setEidoverseControllerArmed,
  tickEidoverseControllers,
} = await import('./eidoverseControllerRuntime.js');

const MINUTE = 60_000;
const START = Date.parse('2026-03-04T00:00:00.000Z');
const at = (msFromStart) => new Date(START + msFromStart).toISOString();

const install = (overrides = {}, options = {}) => installEidoverseController({
  id: 'plaza-beacon',
  controllerId: 'ambient-beacon',
  tickIntervalMs: 5 * MINUTE,
  config: { label: 'plaza', pulseEveryTicks: 2 },
  ...overrides,
}, { installedBy: 'mind', now: at(0), ...options });

/**
 * Advance the supervisor's clock past `passes` wake-ups, exactly as the
 * scheduled interval would. Nothing else in the process runs.
 */
async function runSupervisorPasses(passes, { fromMs = 0, everyMs = MINUTE, ...options } = {}) {
  const results = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    results.push(await tickEidoverseControllers({ now: at(fromMs + pass * everyMs), ...options }));
  }
  return results;
}

beforeEach(() => {
  rmSync(lazyTempDataRoot('portos-eidoverse-controllers-'), { recursive: true, force: true });
  __resetEidoverseControllerRuntimeForTests();
});

afterEach(() => __resetEidoverseControllerRuntimeForTests());
afterAll(cleanupTempDataRoots);

describe('installing a controller', () => {
  it('resolves behavior by id against the fixed registry and refuses anything else', async () => {
    const refused = await install({ controllerId: 'ambient-beacon/../../../etc/passwd' });
    expect(refused.outcome).toBe('refused');

    // An id-shaped string that is simply not registered is refused the same
    // way — there is no path, no import, and no fallback that could run it.
    const unknown = await install({ controllerId: 'attacker-supplied' });
    expect(unknown.outcome).toBe('refused');
    expect(unknown.reasons[0]).toMatch(/never by a module path/);

    expect((await listEidoverseControllers()).installs).toEqual([]);
  });

  it('validates the config against the controller\'s own schema at install time', async () => {
    const refused = await install({ config: { label: 'plaza', pulseEveryTicks: 0 } });
    expect(refused.outcome).toBe('refused');
    expect(refused.reasons[0]).toMatch(/^config\.pulseEveryTicks/);
  });

  it('arms the supervisor on install and stands it down again on retire', async () => {
    expect(isEidoverseControllerSupervisorRegistered()).toBe(false);

    await install();
    expect(isEidoverseControllerSupervisorRegistered()).toBe(true);

    await retireEidoverseController('plaza-beacon');
    expect(isEidoverseControllerSupervisorRegistered()).toBe(false);
  });

  it('reconciles arming when a controller is disarmed and re-armed, not only at boot', async () => {
    await install();

    await setEidoverseControllerArmed('plaza-beacon', false, { now: at(MINUTE) });
    expect(isEidoverseControllerSupervisorRegistered()).toBe(false);

    await setEidoverseControllerArmed('plaza-beacon', true, { now: at(2 * MINUTE) });
    expect(isEidoverseControllerSupervisorRegistered()).toBe(true);
  });

  it('never fires on install — the first tick is one interval away', async () => {
    const installed = await install();

    expect(installed.install.tick).toBe(0);
    expect(installed.install.nextTickAt).toBe(at(5 * MINUTE));
    expect((await runSupervisorPasses(4))[3]).toMatchObject({ ticked: 0 });
  });
});

describe('the supervised tick path', () => {
  it('still ticks with no mind, no tool call, and no author in the process', async () => {
    await install({ deliverEffects: false });

    // From here on nothing a mind does happens: no tool dispatch, no wake, no
    // second install. Only the supervisor's own clock moves.
    await runSupervisorPasses(30);

    const record = await getEidoverseControllerInstall('plaza-beacon');
    // Six five-minute cadences fit in thirty one-minute supervisor passes.
    expect(record.tick).toBe(6);
    expect(record.state).toMatchObject({ label: 'plaza', ticks: 6, pulses: 3 });
    expect(record.lastOutcome).toMatchObject({ ok: true, reason: null });
    // Every second tick pulsed, and each pulse was recorded where the author
    // can read it back on their next wake.
    expect(record.recentEffects.map((effect) => effect.summary))
      .toEqual(['plaza pulse 3', 'plaza pulse 2', 'plaza pulse 1']);
  });

  it('survives a restart of the process that installed it', async () => {
    await install();
    await runSupervisorPasses(10);
    expect((await getEidoverseControllerInstall('plaza-beacon')).tick).toBe(2);

    // A restart: every in-memory handle in this module is dropped and the
    // runtime is re-imported fresh. Only what reached disk comes back.
    __resetEidoverseControllerRuntimeForTests();
    vi.resetModules();
    const restarted = await import('./eidoverseControllerRuntime.js');

    await restarted.startEidoverseControllerSupervisor();
    expect(restarted.isEidoverseControllerSupervisorRegistered()).toBe(true);

    await restarted.tickEidoverseControllers({ now: at(20 * MINUTE) });
    const record = await restarted.getEidoverseControllerInstall('plaza-beacon');
    expect(record.tick).toBe(3);
    expect(record.state.ticks).toBe(3);

    restarted.__resetEidoverseControllerRuntimeForTests();
  });

  it('wakes a slept machine to ONE tick, not to a replayed backlog', async () => {
    await install();

    // Three days later, in a single pass.
    const [pass] = await runSupervisorPasses(1, { everyMs: 3 * 24 * 60 * MINUTE });

    expect(pass).toMatchObject({ ticked: 1, due: 1 });
    expect((await getEidoverseControllerInstall('plaza-beacon')).tick).toBe(1);
  });

  it('keeps effects out of the world until the install explicitly delivers them', async () => {
    const deliver = vi.fn(async () => ({ delivered: 1, error: null }));
    await install({ config: { label: 'plaza', pulseEveryTicks: 1 }, deliverEffects: false });

    await runSupervisorPasses(5, { deliver });
    expect(deliver).not.toHaveBeenCalled();

    await install({ id: 'lamp-keeper', controllerId: 'lantern-keeper', deliverEffects: true, tickIntervalMs: 5 * MINUTE,
      config: { relightEveryTicks: 1, lanterns: [{ id: 'plaza-lantern', pos: [0, 2, 0] }] } }, { now: at(5 * MINUTE) });

    await runSupervisorPasses(5, { fromMs: 5 * MINUTE, deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toEqual([{
      kind: 'augment',
      operations: [{ verb: 'light', args: { id: 'plaza-lantern', pos: [0, 2, 0], color: 0xFFD27F, intensity: 16, range: 10 } }],
    }]);
  });

  it('counts the step and records the failure when the world cannot be reached', async () => {
    const deliver = vi.fn(async () => { throw new Error('world host is down'); });
    await install({ config: { label: 'plaza', pulseEveryTicks: 1 }, deliverEffects: true });

    await runSupervisorPasses(5, { deliver });

    const record = await getEidoverseControllerInstall('plaza-beacon');
    // The controller's own state advanced — re-running it to retry a world
    // write would double-count everything it did.
    expect(record.state.pulses).toBe(1);
    expect(record.lastOutcome).toMatchObject({ ok: true, delivered: 0, deliveryError: 'world host is down' });
  });
});

describe('a controller that goes wrong', () => {
  const brokenController = {
    id: 'broken-probe',
    configSchema: { safeParse: (config) => ({ success: true, data: config }) },
    createState: () => ({}),
    step: () => { throw new Error('boom'); },
  };
  const resolveBroken = async (id) => (id === 'broken-probe' ? brokenController : null);

  it('disarms after repeated failures instead of failing on a schedule forever', async () => {
    await install({ controllerId: 'broken-probe', tickIntervalMs: MINUTE }, { resolveDefinition: resolveBroken });

    await runSupervisorPasses(3, { resolveDefinition: resolveBroken });

    const record = await getEidoverseControllerInstall('plaza-beacon');
    expect(record.armed).toBe(false);
    expect(record.consecutiveFailures).toBe(3);
    expect(record.disarmedReason).toMatch(/3 consecutive failed ticks: step\(\) threw: boom/);

    // And a further pass does nothing at all, rather than continuing to throw.
    expect(await tickEidoverseControllers({ now: at(10 * MINUTE), resolveDefinition: resolveBroken }))
      .toMatchObject({ ticked: 0, due: 0 });
    // Disarming the last armed install moves the gate as surely as a retire
    // does, so the supervisor stands itself down instead of waking every
    // minute to find nothing to do until the next restart.
    expect(isEidoverseControllerSupervisorRegistered()).toBe(false);
  });

  it('disarms an install whose controller id this version no longer ships', async () => {
    await install({ controllerId: 'broken-probe', tickIntervalMs: MINUTE }, { resolveDefinition: resolveBroken });

    // The real registry, which has never heard of `broken-probe`.
    await runSupervisorPasses(1);

    const record = await getEidoverseControllerInstall('plaza-beacon');
    expect(record.armed).toBe(false);
    expect(record.disarmedReason).toMatch(/no controller is registered under "broken-probe" any more/);
  });
});

describe('the install store', () => {
  it('reads as empty on an install that has never installed one', async () => {
    const listed = await listEidoverseControllers();
    expect(listed.installs).toEqual([]);
    expect(listed.counts).toEqual({ total: 0, armed: 0, delivering: 0 });
  });

  it('rebuilds state on re-install, because state is shaped by the config that produced it', async () => {
    await install();
    await runSupervisorPasses(10);
    expect((await getEidoverseControllerInstall('plaza-beacon')).state.ticks).toBe(2);

    const reinstalled = await install({ config: { label: 'quay', pulseEveryTicks: 4 } }, { now: at(20 * MINUTE) });
    expect(reinstalled.install.state).toMatchObject({ label: 'quay', ticks: 0, pulses: 0 });
    // The tick ordinal is the supervisor's own count of attempts and survives.
    expect(reinstalled.install.tick).toBe(2);
    expect(reinstalled.install.installedAt).toBe(at(0));
  });

  it('keeps accumulated state across a disarm and re-arm', async () => {
    await install();
    await runSupervisorPasses(10);

    await setEidoverseControllerArmed('plaza-beacon', false, { now: at(11 * MINUTE) });
    await runSupervisorPasses(10, { fromMs: 11 * MINUTE });
    expect((await getEidoverseControllerInstall('plaza-beacon')).state.ticks).toBe(2);

    await setEidoverseControllerArmed('plaza-beacon', true, { now: at(22 * MINUTE) });
    await runSupervisorPasses(10, { fromMs: 22 * MINUTE });
    expect((await getEidoverseControllerInstall('plaza-beacon')).state.ticks).toBe(4);
  });

  it('retires an install outright rather than parking it forever', async () => {
    await install();
    expect((await retireEidoverseController('plaza-beacon')).outcome).toBe('retired');
    expect(await getEidoverseControllerInstall('plaza-beacon')).toBeNull();
    expect((await retireEidoverseController('plaza-beacon')).outcome).toBe('unknown-install');
  });
});
