import { describe, expect, it, vi } from 'vitest';
import { up } from './006-stacker-news-existing-key-accounts-keep-api-reads.js';

describe('Stacker News existing-key read transport migration', () => {
  it('pins only credential-bearing accounts to API reads, leaving keyless ones on the browser default', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await up({ query });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain("SET read_transport='api'");
    expect(sql).toContain('FROM stacker_news_credentials');
    // Scoped to the default so a re-run (or a later user choice) cannot undo an
    // explicit switch back to browser reads.
    expect(sql).toContain("a.read_transport='browser'");
  });
});
