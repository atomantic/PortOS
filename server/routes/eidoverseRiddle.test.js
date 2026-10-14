import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-riddle-'),
}));
vi.mock('../services/eventScheduler.js', () => ({ cancel: vi.fn(), getEvent: vi.fn(), schedule: vi.fn() }));
const world = vi.hoisted(() => ({ say: vi.fn() }));
vi.mock('../services/eidoverseWorld.js', () => ({ sayInEidoverseWorld: world.say }));

const { PATHS, atomicWrite, readJSONFile } = await import('../lib/fileUtils.js');
let authGate;
let hostControlRouteGate;
let runtime;
let routes;
const appFor = (remoteAddress = '127.0.0.1') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use('/api/eidoverse/world', routes);
  app.use(errorMiddleware);
  return app;
};
const actionPath = '/api/eidoverse/world/controllers/example-game/riddle';
const offer = { action: 'offer', expectedRevision: 0, clue: 'Which shape has three sides?', answer: 'triangle' };
const act = (body, app = appFor()) => request(app).post(actionPath).send(body);
const inspect = async () => (await request(appFor()).get('/api/eidoverse/world/controllers/example-game')).body;
const install = async (deliverEffects = true) => {
  const res = await request(appFor()).post('/api/eidoverse/world/controllers').send({
    id: 'example-game', controllerId: 'riddle-ledger', config: {}, armed: true, deliverEffects,
  });
  expect(res.body.outcome).toBe('installed');
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  rmSync(join(PATHS.data, 'eidoverse'), { recursive: true, force: true });
  ({ authGate, hostControlRouteGate } = await import('../services/authGate.js'));
  runtime = await import('../services/eidoverseControllerRuntime.js');
  routes = (await import('./eidoverseWorldRoutes.js')).default;
  world.say.mockResolvedValue({ success: true });
});
afterAll(cleanupTempDataRoots);

describe('explicit Eidoverse riddle round', () => {
  it('plays a full round over HTTP, survives fresh module loading, and never announces from ticks', async () => {
    await install();
    const offered = await act(offer);
    expect(offered.body).toMatchObject({ outcome: 'applied', delivery: { status: 'acknowledged', delivered: 1 } });
    expect(offered.body.install.state).toMatchObject({ revision: 1, round: 1, clue: offer.clue, guess: '', revealed: false, correct: null });
    expect(world.say).toHaveBeenLastCalledWith(`Riddle 1: ${offer.clue}`, expect.any(Object));
    expect(world.say.mock.calls[0][0]).not.toContain('triangle');

    // A fresh runtime has no in-memory round to lean on; keep the temp disk.
    vi.resetModules();
    runtime = await import('../services/eidoverseControllerRuntime.js');
    routes = (await import('./eidoverseWorldRoutes.js')).default;
    expect((await inspect()).state.revision).toBe(1);
    const guessed = await act({ action: 'guess', expectedRevision: 1, guess: 'TRIANGLE' });
    expect(guessed.body.install.state).toMatchObject({ revision: 2, guess: 'TRIANGLE', correct: null });
    const revealed = await act({ action: 'reveal', expectedRevision: 2 });
    expect(revealed.body.install.state).toMatchObject({ revision: 3, revealed: true, correct: true });
    expect(world.say).toHaveBeenLastCalledWith('Riddle 1 answer: triangle (correct)', expect.any(Object));
    await runtime.tickEidoverseControllers({ now: '2099-01-01T00:00:00.000Z' });
    expect(world.say).toHaveBeenCalledTimes(3);
    expect((await inspect()).state).toEqual(revealed.body.install.state);
    expect((await act({ ...offer, expectedRevision: 3 })).body.install.state).toMatchObject({ round: 2, guess: '', revealed: false, correct: null });
  });

  it('refuses invalid, repeated, stale and overlapping transitions without extra delivery', async () => {
    expect((await act(offer)).status).toBe(404);
    await install();
    expect((await act({ action: 'reveal', expectedRevision: 0 })).body.outcome).toBe('refused');
    expect((await act({ action: 'guess', expectedRevision: 0, guess: 'circle' })).body.outcome).toBe('refused');
    expect((await act({ ...offer, answer: '' })).status).toBe(400);
    expect((await act({ ...offer, clue: 'x'.repeat(201) })).status).toBe(400);
    expect((await act({ ...offer, action: 'interpret' })).status).toBe(400);
    await act(offer);
    expect((await act(offer)).body.outcome).toBe('refused');
    expect((await act({ ...offer, expectedRevision: 1 })).body.outcome).toBe('refused');
    const pair = await Promise.all([
      act({ action: 'guess', expectedRevision: 1, guess: 'circle' }),
      act({ action: 'guess', expectedRevision: 1, guess: 'square' }),
    ]);
    expect(pair.map((res) => res.body.outcome).sort()).toEqual(['applied', 'refused']);
    expect((await act({ action: 'guess', expectedRevision: 2, guess: 'triangle' })).body.outcome).toBe('refused');
    const revealed = await act({ action: 'reveal', expectedRevision: 2 });
    expect(revealed.body.install.state.correct).toBe(false);
    expect((await act({ action: 'reveal', expectedRevision: 3 })).body.outcome).toBe('refused');
    expect((await act({ action: 'guess', expectedRevision: 3, guess: 'triangle' })).body.outcome).toBe('refused');
    expect(world.say).toHaveBeenCalledTimes(3);
  });

  it('persists refused delivery independently of local progress, without automatic retry', async () => {
    await install();
    world.say.mockRejectedValue(new Error('Synthetic world refusal'));
    const offered = await act(offer);
    expect(offered.body).toMatchObject({ outcome: 'applied', delivery: { status: 'refused', delivered: 0, reason: 'Synthetic world refusal' } });
    expect((await inspect()).state.delivery).toEqual(offered.body.delivery);
    vi.resetModules();
    runtime = await import('../services/eidoverseControllerRuntime.js');
    routes = (await import('./eidoverseWorldRoutes.js')).default;
    expect((await inspect()).state.delivery).toEqual(offered.body.delivery);
    await runtime.tickEidoverseControllers({ now: '2099-01-01T00:00:00.000Z' });
    expect((await act(offer)).body.outcome).toBe('refused');
    expect(world.say).toHaveBeenCalledTimes(1);
  });

  it('supports local-only play, disarm refusal and rejects actions on the existing beacon', async () => {
    await install(false);
    expect((await act(offer)).body.delivery.status).toBe('disabled');
    expect((await act({ action: 'reveal', expectedRevision: 1 })).body.install.state.correct).toBeNull();
    await runtime.setEidoverseControllerArmed('example-game', false);
    expect((await act({ ...offer, expectedRevision: 2 })).body.outcome).toBe('refused');
    await runtime.installEidoverseController({ id: 'example-beacon', controllerId: 'ambient-beacon', config: {} });
    const before = await runtime.getEidoverseControllerInstall('example-beacon');
    const res = await request(appFor()).post('/api/eidoverse/world/controllers/example-beacon/riddle').send(offer);
    expect(res.body.outcome).toBe('refused');
    expect(await runtime.getEidoverseControllerInstall('example-beacon')).toEqual(before);
    expect(world.say).not.toHaveBeenCalled();
  });

  it('fences incompatible stores/state and does not stamp a receipt over a re-install', async () => {
    await install();
    const file = join(PATHS.data, 'eidoverse', 'controllers.json');
    const stored = await readJSONFile(file);
    await atomicWrite(file, { ...stored, schemaVersion: 999 });
    expect((await act(offer)).body.outcome).toBe('refused');
    expect(await readJSONFile(file)).toEqual({ ...stored, schemaVersion: 999 });
    await atomicWrite(file, { ...stored, installs: { 'example-game': { ...stored.installs['example-game'], state: { revision: 0 } } } });
    expect((await act(offer)).body.outcome).toBe('refused');
    await atomicWrite(file, stored);
    world.say.mockImplementationOnce(async () => {
      expect((await runtime.getEidoverseControllerInstall('example-game')).state.delivery.status).toBe('pending');
      await runtime.installEidoverseController({ id: 'example-game', controllerId: 'riddle-ledger', config: {}, deliverEffects: true });
      return { success: true };
    });
    const res = await act(offer);
    expect(res.body).toMatchObject({ outcome: 'superseded', install: null, delivery: { status: 'acknowledged' } });
    expect((await inspect()).state).toMatchObject({ revision: 0, round: 0, delivery: null });
  });

  it('refuses anonymous remote gameplay before state/delivery and retains authenticated agent access', async () => {
    await install();
    const denied = await act(offer, appFor('192.0.2.10'));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect((await inspect()).state.revision).toBe(0);
    expect(world.say).not.toHaveBeenCalled();
    // Same server-minted session used by PORTOS_API_TOKEN, with synthetic stores.
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'synthetic-riddle-password' });
    const { token } = await auth.createSession({ label: 'agent' });
    expect((await act(offer)).status).toBe(401);
    const allowed = await request(appFor()).post(actionPath).set('Authorization', `Bearer ${token}`).send(offer);
    expect(allowed.body).toMatchObject({ outcome: 'applied', delivery: { status: 'acknowledged' } });
    await auth.clearPassword({ currentPassword: 'synthetic-riddle-password' });
  });
});
