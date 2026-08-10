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

  it('does not carry an armed override to a same-named note in another vault', async () => {
    // Vaults routinely share basenames (index.md, README.md, daily notes). Keying
    // on the path alone would render the override over a different file that was
    // never screened, and confirming it would force-write THAT one.
    api.updateNote.mockRejectedValue(evicted());
    const { result, rerender } = renderHook(props => useNoteSave(props), {
      initialProps: { vaultId: 'v1', notePath: 'index.md', content: 'body' },
    });

    await failTwice(result);
    expect(result.current.forceOffered).toBe(true);

    rerender({ vaultId: 'v2', notePath: 'index.md', content: 'body' });

    expect(result.current.forceOffered).toBe(false);
  });

  it('disarms when the editor reopens the note, so a stale override never greets the user', async () => {
    api.updateNote.mockRejectedValue(evicted());
    const { result, rerender } = setup('a.md');
    await failTwice(result);
    expect(result.current.forceOffered).toBe(true);

    // Close the note, then reopen it — no save has been attempted since.
    rerender({ vaultId: 'v1', notePath: null, content: '' });
    rerender({ vaultId: 'v1', notePath: 'a.md', content: 'body' });

    expect(result.current.forceOffered).toBe(false);
  });

  it('refuses to stack a second write while one is in flight', async () => {
    // The click that matters is "Save anyway" on a note that may genuinely be
    // evicted: that write blocks uninterruptibly, so a second one strands another
    // libuv thread for the life of the process. `saving` can't guard this — the
    // setState hasn't repainted the disabled button yet.
    let release;
    api.updateNote.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const { result } = setup();

    let first;
    let second;
    await act(async () => {
      first = result.current.save({ force: true });
      second = result.current.save({ force: true });
    });

    expect(api.updateNote).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBeNull();

    await act(async () => { release({ path: 'a.md' }); await first; });
    expect(api.updateNote).toHaveBeenCalledTimes(1);
  });

  it('accepts a new save once the previous one settles', async () => {
    api.updateNote.mockResolvedValue({ path: 'a.md' });
    const { result } = setup();

    await act(async () => { await result.current.save(); });
    await act(async () => { await result.current.save(); });

    // The re-entrancy guard must release on settle, or the editor is save-once.
    expect(api.updateNote).toHaveBeenCalledTimes(2);
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
