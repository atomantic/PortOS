import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchProseExport } from './apiPipeline.js';

afterEach(() => vi.unstubAllGlobals());

describe('fetchProseExport', () => {
  it('returns the blob and the server attachment filename', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('# Book', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="example-series.md"' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { blob, filename } = await fetchProseExport('ser 1', 'md');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pipeline/series/ser%201/export/manuscript.md');
    expect(filename).toBe('example-series.md');
    expect(await blob.text()).toBe('# Book');
  });

  it('rejects with the structured server error code and status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'No drafted prose', code: 'PIPELINE_PROSE_EXPORT_NO_CONTENT' }),
      { status: 409 },
    )));
    await expect(fetchProseExport('s', 'epub')).rejects.toMatchObject({
      code: 'PIPELINE_PROSE_EXPORT_NO_CONTENT', status: 409, message: 'No drafted prose',
    });
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(fetchProseExport('s', 'pdf')).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
  });
});
