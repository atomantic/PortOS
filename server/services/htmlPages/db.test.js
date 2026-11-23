/** The HTML Pages run store against real PostgreSQL (portos_test); synthetic records only. */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { modelLifecycleEvents } from '../modelLifecycleEvents.js';
import { createRun, deleteRun, getRun, listRuns, mutateRun } from './db.js';

const health = await checkHealth();
const ready = requireDbOrSkip('htmlPages/db.test', health.connected, health.error);
if (ready) await ensureSchema();

afterAll(async () => {
  if (ready) await query("DELETE FROM html_page_runs WHERE model_id LIKE 'example-%'");
  await close();
});

describe.skipIf(!ready)('html_page_runs store', () => {
  it('round-trips a run with its pages, mirrors status in the column, and signals each persisted change', async () => {
    const seen = [];
    const listener = (payload) => seen.push(payload.id);
    modelLifecycleEvents.on('html-page-run:changed', listener);
    try {
      const run = await createRun({ backend: 'ollama', modelId: 'example-store-model', pageCount: 2, themes: ['A: one', 'B: two'] });
      const html = '<!doctype html><html><body>🌧 "quoted" \\ back</body></html>';
      await mutateRun(run.id, (c) => ({ ...c, status: 'complete', pages: [{ theme: 'A: one', html }] }));

      const stored = await getRun(run.id);
      expect(stored.pages[0].html).toBe(html);
      expect(stored.status).toBe('complete');
      expect((await query('SELECT status FROM html_page_runs WHERE id = $1', [run.id])).rows[0].status).toBe('complete');
      expect(seen).toEqual([run.id, run.id]);
    } finally {
      modelLifecycleEvents.off('html-page-run:changed', listener);
    }
  });

  it('lists newest first, hides a deleted run, and 404s a mutation of a missing one', async () => {
    const first = await createRun({ backend: 'ollama', modelId: 'example-first', pageCount: 1, themes: ['A: one'] });
    // created_at orders the list; two inserts inside one millisecond would tie.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createRun({ backend: 'ollama', modelId: 'example-second', pageCount: 1, themes: ['A: one'] });
    const ids = (await listRuns()).map((r) => r.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    await deleteRun(first.id);
    expect((await listRuns()).map((r) => r.id)).not.toContain(first.id);
    expect(await getRun(first.id)).toBeNull();
    await expect(mutateRun('htmlpages-missing', (c) => c)).rejects.toMatchObject({ status: 404 });
  });
});
