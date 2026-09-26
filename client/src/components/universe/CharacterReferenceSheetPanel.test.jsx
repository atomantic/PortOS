import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import CharacterReferenceSheetPanel from './CharacterReferenceSheetPanel';

const mocks = vi.hoisted(() => ({
  handlers: new Map(), read: vi.fn(), render: vi.fn(), error: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: {
  on: (event, callback) => { if (!mocks.handlers.has(event)) mocks.handlers.set(event, new Set()); mocks.handlers.get(event).add(callback); },
  off: (event, callback) => mocks.handlers.get(event)?.delete(callback),
} }));
vi.mock('../../services/apiUniverseBuilder', () => ({
  fetchReferenceSheetVariants: async () => ({ variants: [{ id: 'standard', label: 'Reference sheet' }] }),
  getCharacterReferenceSheet: (...args) => mocks.read(...args),
  renderCharacterReferenceSheet: (...args) => mocks.render(...args),
  deleteCharacterReferenceSheet: vi.fn(),
}));
vi.mock('../../hooks/useMediaJobProgress', () => ({ default: () => ({ status: 'completed', progress: 1 }) }));
vi.mock('../ui/Toast', () => ({ default: { error: (...args) => mocks.error(...args), success: vi.fn() } }));
vi.mock('../MediaImage', () => ({ default: props => <img src={props.src} alt={props.alt} /> }));
const emit = (event, data) => act(() => { mocks.handlers.get(event)?.forEach(callback => callback(data)); });
const frame = { universeId: 'u-1', entryId: 'c-1', variant: 'standard', jobId: 'job-1', status: 'ready' };
function Panel({ universeId = 'u-1' }) {
  const [entry, setEntry] = useState({ id: 'c-1', name: 'Example Character' });
  return <CharacterReferenceSheetPanel universeId={universeId} entry={entry}
    onSheetCompleted={(_id, filename) => setEntry(old => ({ ...old, referenceSheetImageRef: filename }))} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ filename: null, pendingJobId: null });
  mocks.render.mockResolvedValue({ jobId: 'job-1', destFilename: 'sheet.png' });
});
afterEach(() => vi.useRealTimers());

describe('persisted reference-sheet publication', () => {
  it('waits for publication, filters unrelated events, and performs no timer-driven HEAD requests', async () => {
    render(<Panel />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    mocks.read.mockResolvedValue({ filename: null, pendingJobId: 'job-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Rendering/ })).toBeDisabled());
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
    emit('reference-sheet:changed', { ...frame, entryId: 'other' });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('img')).toBeNull();
    vi.useRealTimers();
    mocks.read.mockResolvedValue({ filename: 'sheet.png', pendingJobId: null });
    emit('reference-sheet:changed', frame);
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/data/image-refs/sheet.png'));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('recovers missed success on reconnect and missed persistence failure on tab re-show', async () => {
    render(<Panel />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    mocks.read.mockResolvedValue({ filename: 'saved.png', pendingJobId: null });
    emit('connect');
    await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', '/data/image-refs/saved.png'));
    mocks.read.mockResolvedValue({ filename: 'saved.png', pendingJobId: 'job-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Rendering/ })).toBeDisabled());
    await act(async () => {});
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    mocks.read.mockResolvedValue({ filename: 'saved.png', pendingJobId: null });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('could not be saved')));
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  });

  it('drops a stale read and kickoff reply after navigating away', async () => {
    let finishRead;
    mocks.read.mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
    let finishRender;
    mocks.render.mockReturnValueOnce(new Promise(resolve => { finishRender = resolve; }));
    const view = render(<Panel />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    view.unmount();
    await act(async () => {
      finishRead({ filename: 'stale.png', pendingJobId: null });
      finishRender({ jobId: 'job-1', destFilename: 'stale.png' });
    });
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.handlers.get('reference-sheet:changed')?.size).toBe(0);
  });
});
