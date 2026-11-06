// The page applies this response to its project, which is what makes the
// Cast & Sets check-in re-resolve without leaving the Look page. The service's
// create-and-link behavior is covered in musicVideo/catalogCast.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const { saveVideoSubjectToCatalog } = vi.hoisted(() => ({ saveVideoSubjectToCatalog: vi.fn() }));
vi.mock('../services/musicVideo/catalogCast.js', async (importOriginal) => ({ ...(await importOriginal()), saveVideoSubjectToCatalog }));

const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);

const save = (body) => request(app).post('/api/catalog/stories/music-video/mv-1/subjects/save').send(body);

beforeEach(() => vi.clearAllMocks());

describe('POST /api/catalog/stories/music-video/:id/subjects/save', () => {
  // Uniquely catches the response losing what the page applies, or the outcome that says a record was not recreated.
  it('answers with the saved concept and the outcome', async () => {
    const concept = { subjects: [{ id: 'mvc-1', kind: 'place', name: 'Example Rink', ingredientId: 'cat-plc-mv-1' }] };
    saveVideoSubjectToCatalog.mockResolvedValue({ project: { concept, updatedAt: '2026-01-01T00:00:00.000Z' }, created: 1, kept: 0 });
    const res = await save({ subjectId: 'mvc-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ concept, updatedAt: '2026-01-01T00:00:00.000Z', created: 1, kept: 0 });
    expect(saveVideoSubjectToCatalog).toHaveBeenCalledWith('mv-1', 'mvc-1');
  });

  // Uniquely catches this route accepting importer decisions, which could name another record or keep a subject local.
  it('refuses anything beyond a subject id', async () => {
    const res = await save({ subjectId: 'mvc-1', action: 'link', ingredientId: 'cat-plc-other' });
    expect(res.status).toBe(400);
    expect(saveVideoSubjectToCatalog).not.toHaveBeenCalled();
  });
});
