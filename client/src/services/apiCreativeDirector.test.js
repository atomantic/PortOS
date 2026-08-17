/**
 * Creative Director API wrapper — batch-by-id fetch (#4148).
 *
 * The empty-list short-circuit is load-bearing, not a micro-optimization: a
 * present-but-blank `?ids=` reads as ABSENT server-side, so issuing the request
 * anyway would return every project on the install — exactly the over-fetch this
 * helper exists to remove.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./apiCore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  request: vi.fn(),
}));

let request;
let getCreativeDirectorProjectsByIds;

beforeEach(async () => {
  vi.resetModules();
  ({ request } = await import('./apiCore.js'));
  ({ getCreativeDirectorProjectsByIds } = await import('./apiCreativeDirector.js'));
  request.mockReset();
});

describe('getCreativeDirectorProjectsByIds', () => {
  it('sends the ids as a CSV on the list route and returns the bare array', async () => {
    request.mockResolvedValue([{ id: 'cd-1' }, { id: 'cd-2' }]);
    const out = await getCreativeDirectorProjectsByIds(['cd-1', 'cd-2']);
    expect(out.map((p) => p.id)).toEqual(['cd-1', 'cd-2']);

    const [path, options] = request.mock.calls[0];
    expect(path.startsWith('/creative-director?')).toBe(true);
    expect(decodeURIComponent(path)).toContain('ids=cd-1,cd-2');
    expect(options).toEqual({});
  });

  it('de-duplicates and drops falsy ids before building the query', async () => {
    request.mockResolvedValue([]);
    await getCreativeDirectorProjectsByIds(['cd-1', '', 'cd-1', null, 'cd-2', undefined]);
    expect(decodeURIComponent(request.mock.calls[0][0])).toContain('ids=cd-1,cd-2');
  });

  it('short-circuits an empty/all-falsy id list without issuing a request', async () => {
    expect(await getCreativeDirectorProjectsByIds([])).toEqual([]);
    expect(await getCreativeDirectorProjectsByIds([null, '', undefined])).toEqual([]);
    expect(await getCreativeDirectorProjectsByIds()).toEqual([]);
    expect(await getCreativeDirectorProjectsByIds('not-an-array')).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  // A whitespace-only id survives a bare `filter(Boolean)` and serializes to
  // `?ids=%20`, which the server trims back to ABSENT — i.e. it would return
  // every project on the install, the exact over-fetch this helper removes.
  it('trims ids, and treats an all-whitespace list as empty (no request)', async () => {
    expect(await getCreativeDirectorProjectsByIds(['  ', '\t', 42])).toEqual([]);
    expect(request).not.toHaveBeenCalled();

    request.mockResolvedValue([]);
    await getCreativeDirectorProjectsByIds([' cd-1 ', '  ', 'cd-2']);
    expect(decodeURIComponent(request.mock.calls[0][0])).toContain('ids=cd-1,cd-2');
  });

  it('unwraps a paginated { items } envelope and tolerates a junk response', async () => {
    request.mockResolvedValue({ items: [{ id: 'cd-1' }], total: 1 });
    expect(await getCreativeDirectorProjectsByIds(['cd-1'])).toEqual([{ id: 'cd-1' }]);

    request.mockResolvedValue(null);
    expect(await getCreativeDirectorProjectsByIds(['cd-1'])).toEqual([]);
  });

  it('forwards request options (e.g. { silent: true }) through to request()', async () => {
    request.mockResolvedValue([]);
    await getCreativeDirectorProjectsByIds(['cd-1'], { silent: true });
    expect(request.mock.calls[0][1]).toEqual({ silent: true });
  });
});
// @vitest-environment node
