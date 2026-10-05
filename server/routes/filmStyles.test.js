import { describe, expect, it } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import filmStylesRoutes from './filmStyles.js';
import { FILM_STYLE_GRAMMARS } from '../lib/filmStyleGrammars.js';

const app = express();
app.use('/api/film-styles', filmStylesRoutes);
app.use(errorMiddleware);

describe('/api/film-styles', () => {
  it('lists the picker projection only', async () => {
    const response = await request(app).get('/api/film-styles');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(FILM_STYLE_GRAMMARS.length);
    const [first] = response.body;
    expect(Object.keys(first).sort()).toEqual(['category', 'id', 'label', 'nativeMoves', 'summary']);
    expect(first.nativeMoves).toEqual(FILM_STYLE_GRAMMARS[0].nativeMoves.map(({ name }) => ({ name })));
  });

  it('returns the full record by id, 404 for an unknown id, 400 for a malformed one', async () => {
    const { id } = FILM_STYLE_GRAMMARS[1];
    const found = await request(app).get(`/api/film-styles/${id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(FILM_STYLE_GRAMMARS[1]);

    expect((await request(app).get('/api/film-styles/no-such-style')).status).toBe(404);
    expect((await request(app).get('/api/film-styles/Not_Kebab')).status).toBe(400);
  });

  it('previews the rendered prompt for comma-separated parts and rejects unknown parts', async () => {
    const { id } = FILM_STYLE_GRAMMARS[0];
    const response = await request(app).get(`/api/film-styles/${id}/prompt?parts=motion, sound`);
    expect(response.status).toBe(200);
    expect(response.body.parts).toEqual(['motion', 'sound']);
    expect(response.body.prompt).toContain('Motion:');
    expect(response.body.prompt).not.toContain('Colour:');

    expect((await request(app).get(`/api/film-styles/${id}/prompt`)).body.parts).toBe('all');
    expect((await request(app).get(`/api/film-styles/${id}/prompt?parts=palette`)).status).toBe(400);
    expect((await request(app).get('/api/film-styles/no-such-style/prompt')).status).toBe(404);
  });
});
