import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The service is exercised by services/character.test.js; here we only care about the route
// contract — query/body validation, and that the parsed options reach the service.
vi.mock('../services/character.js', () => ({
  getCharacter: vi.fn(async (options) => ({ name: 'Gandalf', class: 'Wizard', level: 42, __options: options })),
  updateCharacterFields: vi.fn(async (patch) => ({ name: 'Gandalf', class: 'Wizard', ...patch })),
  saveCharacter: vi.fn(async (c) => c),
  createDefaultCharacter: vi.fn(() => ({ name: 'Adventurer' })),
  addXP: vi.fn(async () => ({})),
  takeDamage: vi.fn(async () => ({})),
  takeRest: vi.fn(async () => ({})),
  addEvent: vi.fn(async () => ({})),
  syncJiraXP: vi.fn(async () => ({})),
  syncTaskXP: vi.fn(async () => ({})),
}));

import characterRouter from './character.js';
import * as characterService from '../services/character.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/character', characterRouter);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/character', () => {
  it('includes skills and metrics by default', async () => {
    const res = await request(makeApp()).get('/api/character');
    expect(res.status).toBe(200);
    expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: true, withMetrics: true });
  });

  it('skips BOTH fan-outs for a legacy ?skills=0 caller that predates the metrics flag', async () => {
    // Back-compat: `?skills=0` has only ever meant "give me the cheap sheet". A caller that
    // predates #2676 (a browser on a stale bundle, an external script) has no way to ask for
    // `metrics=0`, so it must not silently start paying the new fan-out — the CyberCity HUD
    // issues exactly this request every 15s.
    for (const value of ['0', 'false']) {
      vi.clearAllMocks();
      const res = await request(makeApp()).get(`/api/character?skills=${value}`);
      expect(res.status).toBe(200);
      expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: false, withMetrics: false });
    }
  });

  it('lets an explicit ?metrics= override the value inherited from ?skills=', async () => {
    // The inheritance is only a default — the two stay independently gateable.
    await request(makeApp()).get('/api/character?skills=0&metrics=1');
    expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: false, withMetrics: true });
  });

  it('skips the metrics fan-out for ?metrics=0 and ?metrics=false', async () => {
    for (const value of ['0', 'false']) {
      vi.clearAllMocks();
      const res = await request(makeApp()).get(`/api/character?metrics=${value}`);
      expect(res.status).toBe(200);
      expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: true, withMetrics: false });
    }
  });

  it('skips only the metrics fan-out when metrics alone is disabled', async () => {
    await request(makeApp()).get('/api/character?metrics=0');
    expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: true, withMetrics: false });
  });

  it('gates the two fan-outs independently', async () => {
    await request(makeApp()).get('/api/character?skills=0&metrics=0');
    expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: false, withMetrics: false });
  });

  it('keeps skills and metrics for an explicit opt-in', async () => {
    for (const value of ['1', 'true']) {
      vi.clearAllMocks();
      await request(makeApp()).get(`/api/character?skills=${value}&metrics=${value}`);
      expect(characterService.getCharacter).toHaveBeenCalledWith({ withSkills: true, withMetrics: true });
    }
  });

  it('rejects a nonsense skills or metrics value rather than silently including them', async () => {
    for (const query of ['skills=maybe', 'metrics=maybe']) {
      vi.clearAllMocks();
      const res = await request(makeApp()).get(`/api/character?${query}`);
      expect(res.status).toBe(400);
      expect(characterService.getCharacter).not.toHaveBeenCalled();
    }
  });
});

describe('PUT /api/character', () => {
  it('passes only the validated fields through to the service', async () => {
    const res = await request(makeApp()).put('/api/character').send({ name: 'Radagast' });
    expect(res.status).toBe(200);
    expect(characterService.updateCharacterFields).toHaveBeenCalledWith({ name: 'Radagast' });
  });

  it('strips unknown keys so the generic patch loop is not a mass-assignment surface', async () => {
    await request(makeApp()).put('/api/character').send({ name: 'Radagast', xp: 999999, level: 99 });
    expect(characterService.updateCharacterFields).toHaveBeenCalledWith({ name: 'Radagast' });
  });

  it('rejects an empty name instead of clearing it', async () => {
    const res = await request(makeApp()).put('/api/character').send({ name: '' });
    expect(res.status).toBe(400);
    expect(characterService.updateCharacterFields).not.toHaveBeenCalled();
  });

  it('rejects an avatarPath outside the images directory', async () => {
    const res = await request(makeApp()).put('/api/character').send({ avatarPath: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(characterService.updateCharacterFields).not.toHaveBeenCalled();
  });
});
