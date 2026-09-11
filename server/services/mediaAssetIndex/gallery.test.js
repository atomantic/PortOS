import { describe, it, expect, vi, afterEach } from 'vitest';
import { listGalleryPage } from './gallery.js';
import { query } from '../../lib/db.js';

vi.mock('../../lib/db.js', () => ({ query: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('indexed gallery page', () => {
  it('bounds production SQL reads and preserves metadata without invoking disk', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    const item = { filename: 'fox.png', path: '/data/images/fox.png', prompt: '100% fox', seed: 8 };
    query.mockImplementation(async sql => sql.includes('COUNT(*)')
      ? { rows: [{ count: '27' }] } : { rows: [{ data: item }] });
    const disk = vi.fn();
    expect(await listGalleryPage({ limit: 5, offset: 10, q: '100% fox', hidden: false }, disk))
      .toEqual({ items: [item], total: 27, limit: 5, offset: 10 });
    const [sql, params] = query.mock.calls.find(([sql]) => sql.startsWith('SELECT data'));
    expect(sql).toContain('ORDER BY created_at DESC, media_key ASC LIMIT $4 OFFSET $5');
    expect(params).toEqual(['image', '100%', 'fox', 5, 10]);
    expect(sql).toContain('strpos(lower(data::text), $2)');
    expect(sql).toContain("COALESCE(data->>'hidden', 'false') <> 'true'");
    expect(disk).not.toHaveBeenCalled();
  });

  it('does not turn an index failure into a full disk scan', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('MEMORY_BACKEND', 'db');
    query.mockRejectedValue(new Error('database unavailable'));
    const disk = vi.fn();
    await expect(listGalleryPage({}, disk)).rejects.toThrow('database unavailable');
    expect(disk).not.toHaveBeenCalled();
  });
});
