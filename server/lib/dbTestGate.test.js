import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireDbOrSkip } from './dbTestGate.js';

const originalRequireDb = process.env.PORTOS_REQUIRE_DB;

afterEach(() => {
  if (originalRequireDb === undefined) delete process.env.PORTOS_REQUIRE_DB;
  else process.env.PORTOS_REQUIRE_DB = originalRequireDb;
  vi.restoreAllMocks();
});

describe('requireDbOrSkip', () => {
  it('returns false and logs when the DB is absent and the flag is unset', () => {
    delete process.env.PORTOS_REQUIRE_DB;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(requireDbOrSkip('routes/catalog.test', false, 'catalog schema not present')).toBe(false);
    expect(log).toHaveBeenCalledWith('⏭️ routes/catalog.test: skipping suite — catalog schema not present');
  });

  it('throws naming the suite and reason when PORTOS_REQUIRE_DB is set', () => {
    process.env.PORTOS_REQUIRE_DB = '1';

    expect(() => requireDbOrSkip('routes/catalog.test', false, 'catalog schema not present'))
      .toThrow('routes/catalog.test: DB-backed suite skipped but PORTOS_REQUIRE_DB is set — catalog schema not present');
  });

  it('returns true and logs nothing when the DB is ready', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(requireDbOrSkip('routes/catalog.test', true, 'unused')).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
