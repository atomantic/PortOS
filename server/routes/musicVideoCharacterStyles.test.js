import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

let settings = {};
vi.mock('../services/settings.js', () => ({
  getSettings: async () => structuredClone(settings),
  updateSettingsWith: async (mutate) => { settings = await mutate(structuredClone(settings)); return settings; },
}));
const pathExists = vi.fn();
vi.mock('../lib/fileUtils.js', async (importOriginal) => ({ ...(await importOriginal()), pathExists: (...a) => pathExists(...a) }));

const { default: routes } = await import('./musicVideoCharacterStyles.js');
const app = express();
app.use(express.json());
app.use('/api/music-video/character-styles', routes);
app.use(errorMiddleware);

describe('/api/music-video/character-styles', () => {
  beforeEach(() => { settings = {}; pathExists.mockReset().mockResolvedValue(true); });

  it('lists the catalog and returns a style with its rendered sheet prompt', async () => {
    const list = await request(app).get('/api/music-video/character-styles');
    expect(list.status).toBe(200);
    expect(list.body.find((s) => s.id === 'claudia-slopcore')).toMatchObject({ characterName: 'Claudia', referenceImageId: null });
    const detail = await request(app).get('/api/music-video/character-styles/claudia-slopcore');
    expect(detail.body.sheetPrompt).toContain('eight-pointed star hair clip');
    expect(detail.body.sheetPrompt).not.toContain('{identity}');
    expect((await request(app).get('/api/music-video/character-styles/no-such-style')).status).toBe(400);
  });

  it('sets and clears this install\'s character sheet, refusing a missing gallery image', async () => {
    const set = await request(app).put('/api/music-video/character-styles/claudia-slopcore/reference').send({ imageId: 'sheet.png' });
    expect(set.status).toBe(200);
    expect(set.body.referenceImageId).toBe('sheet.png');
    expect(settings.musicVideoCharacterStyles['claudia-slopcore']).toEqual({ referenceImageId: 'sheet.png' });

    pathExists.mockResolvedValue(false);
    expect((await request(app).put('/api/music-video/character-styles/claudia-slopcore/reference').send({ imageId: 'gone.png' })).status).toBe(404);
    expect((await request(app).put('/api/music-video/character-styles/claudia-slopcore/reference').send({ imageId: '../x.png' })).status).toBe(400);

    const cleared = await request(app).put('/api/music-video/character-styles/claudia-slopcore/reference').send({ imageId: null });
    expect(cleared.body.referenceImageId).toBeNull();
    expect(settings.musicVideoCharacterStyles).toEqual({});
  });
});
