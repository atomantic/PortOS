import { expect, it, vi } from 'vitest';
import { withTransaction } from '../lib/db.js';
import { mockTestIdentity } from '../lib/mockPathsDataRoot.js';
import { createMemory } from './memoryDB.js';

vi.mock('../lib/db.js', async importOriginal => ({
  ...await importOriginal(),
  withTransaction: vi.fn()
}));
vi.mock('./instanceIdentity.js', () => mockTestIdentity());

it('logs database memory creation metadata without memory prose', async () => {
  const data = { type: 'fact', summary: 'Example private summary', content: 'Example private content' };
  withTransaction.mockImplementationOnce(work => work({
    query: async (_sql, [id, type, content, summary]) => ({
      rows: [{ id, type, content, summary, created_at: new Date(), updated_at: new Date() }]
    })
  }));

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const memory = await createMemory(data);

    expect(log).toHaveBeenCalledWith(`🧠 Memory created: ${memory.id} (fact)`);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/example private/i);
  } finally {
    log.mockRestore();
  }
});
