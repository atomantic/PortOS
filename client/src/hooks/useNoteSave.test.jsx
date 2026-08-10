/**
 * useNoteSave — the iCloud force-save escape hatch (#3717).
 *
 * The override this hook gates re-admits exactly the blocking write the server's
 * dataless screen exists to prevent, so the properties worth pinning are the ones
 * that keep it SHUT: it opens only for a refusal the server says retrying cannot
 * clear, only after two of those in a row on the same note, and it closes again
 * the moment a save succeeds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ updateNote: vi.fn() }));
vi.mock('../services/api', () => api);

const { useNoteSave } = await import('./useNoteSave.js');

const evicted = ({ stalled = true } = {}) =>
  Object.assign(new Error('evicted'), { code: 'NOTE_EVICTED', context: { stalled } });

const setup = (notePath = 'a.md') =>
  renderHook(props => useNoteSave(props), {
    initialProps: { vaultId: 'v1', notePath, content: 'body' },
  });

const failTwice = async (result) => {
  await act(async () => { await result.current.save(); });
  await act(async () => { await result.current.save(); });
};

beforeEach(() => vi.clearAllMocks());

describe('useNoteSave', () => {
  it('saves without forcing and reports the updated note', async () => {
    api.updateNote.mockResolvedValue({ path: 'a.md' });
    const { result } = setup();

    let data;
    await act(async () => { data = await result.current.save(); });

    expect(api.updateNote).toHaveBeenCalledWith('v1', 'a.md', 'body', { force: false });
    expect(data).toEqual({ path: 'a.md' });
    expect(result.current.forceOffered).toBe(false);
  });

  it('offers the override after two stalled refusals of the same note', async () => {
    api.updateNote.mockRejectedValue(evicted());
    const { result } = setup();

    await act(async () => { await result.current.save(); });
    expect(result.current.forceOffered).toBe(false);

    await act(async () => { await result.current.save(); });
    expect(result.current.forceOffered).toBe(true);
  });

  it('never offers it while a download is genuinely in flight', async () => {
    // `stalled: false` means the materialize attempt DID move the file — waiting
    // is the right answer, and forcing would issue the blocking write.
    api.updateNote.mockRejectedValue(evicted({ stalled: false }));
    const { result } = setup();

    await failTwice(result);

    expect(result.current.forceOffered).toBe(false);
  });

  it('ignores refusals that are not the eviction screen', async () => {
    api.updateNote.mockRejectedValue(Object.assign(new Error('nope'), { code: 'INVALID_PATH' }));
    const { result } = setup();

    await failTwice(result);

    expect(result.current.forceOffered).toBe(false);
  });

  it('restarts the count when the open note changes', async () => {
    api.updateNote.mockRejectedValue(evicted());
    const { result, rerender } = setup('a.md');

    await act(async () => { await result.current.save(); });
    rerender({ vaultId: 'v1', notePath: 'b.md', content: 'body' });
    await act(async () => { await result.current.save(); });

    // Two refusals total, but not two in a row on either note.
    expect(result.current.forceOffered).toBe(false);
  });

  it('closes the override on a successful save', async () => {
    api.updateNote.mockRejectedValue(evicted());
    const { result } = setup();
    await failTwice(result);
    expect(result.current.forceOffered).toBe(true);

    api.updateNote.mockResolvedValue({ path: 'a.md' });
    await act(async () => { await result.current.save({ force: true }); });

    expect(api.updateNote).toHaveBeenLastCalledWith('v1', 'a.md', 'body', { force: true });
    expect(result.current.forceOffered).toBe(false);
  });

  it('closes the override on dismiss without writing anything', async () => {
    api.updateNote.mockRejectedValue(evicted());
    const { result } = setup();
    await failTwice(result);

    act(() => result.current.dismissForce());

    expect(result.current.forceOffered).toBe(false);
    expect(api.updateNote).toHaveBeenCalledTimes(2);
  });

  it('is a no-op with no note open', async () => {
    const { result } = setup(null);

    let data;
    await act(async () => { data = await result.current.save(); });

    expect(data).toBeNull();
    expect(api.updateNote).not.toHaveBeenCalled();
  });
});
