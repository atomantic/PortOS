import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), restore: vi.fn(), events: new Map() }));
vi.mock('../../services/api', () => ({
  generateMoodBoardImages: (...args) => mocks.generate(...args),
  getMoodBoardGeneration: (...args) => mocks.restore(...args),
}));
vi.mock('../../services/socket', () => ({ default: {
  on: (name, fn) => mocks.events.set(name, fn), off: (name) => mocks.events.delete(name),
} }));
vi.mock('../../hooks/useProviderModels', () => ({ default: ({ filter }) => ({
  providers: [
    { id: 'writer', type: 'api', enabled: true },
    { id: 'tool-free-cli', type: 'cli', toolFreeOneShot: true },
    { id: 'authoring-cli', type: 'cli', authoringOneShot: true },
    { id: 'unverified-cli', type: 'cli' },
    { id: 'tui-session', type: 'tui' },
  ].filter(filter), selectedProviderId: 'writer',
  selectedModel: 'chosen-model', availableModels: ['chosen-model'], loading: false,
  setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
}) }));
vi.mock('../../hooks/useImageRenderSettings', () => ({ default: () => ({
  imageCfg: { mode: 'grok' }, backends: [{ id: 'grok', label: 'Grok' }, { id: 'codex', label: 'Codex' }],
}) }));
vi.mock('../ProviderModelSelector', () => ({ default: ({ selectedModel, providers, selectionPolicy }) => <div>
  {selectedModel}
  {providers.filter(selectionPolicy.provider).map((p) => <span key={p.id}>{p.id}</span>)}
</div> }));
vi.mock('../pipeline/MediaJobThumb', () => ({ default: ({ jobId }) => <div>Render {jobId}</div> }));
import MoodBoardGeneratePanel from './MoodBoardGeneratePanel';

const board = { id: 'example', items: [{ type: 'image', id: 'reference', mediaKey: 'image:reference.png' }] };
const run = (props = {}) => ({ boardId: board.id, requestId: 'request', epoch: 'server-one', revision: 1, status: 'running', phase: 'writing', total: 1, items: [], error: null, ...props });
const open = async (props = {}) => {
  const ui = render(<MoodBoardGeneratePanel board={board} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Generate more' }));
  await waitFor(() => expect(mocks.restore).toHaveBeenCalled());
  return ui;
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.events.clear(); mocks.restore.mockResolvedValue(null);
  mocks.generate.mockImplementation(async (_id, input) => run({ requestId: input.requestId }));
});

describe('Generate more', () => {
  it('submits chosen prompt LLM, inherited image settings and landscape default once, then follows scoped progress', async () => {
    let resolve;
    mocks.generate.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await open();
    const button = screen.getByRole('button', { name: 'Generate images' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText(/text, not image pixels/)).toBeInTheDocument();
    expect(screen.getByText('tool-free-cli')).toBeInTheDocument();
    expect(screen.getByText('authoring-cli')).toBeInTheDocument();
    expect(screen.queryByText('unverified-cli')).not.toBeInTheDocument();
    expect(screen.queryByText('tui-session')).not.toBeInTheDocument();
    fireEvent.click(button); fireEvent.click(button);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({ providerId: 'writer', model: 'chosen-model', count: 1, render: { width: 1024, height: 576 } });
    expect(mocks.generate.mock.calls[0][1].render).not.toHaveProperty('mode');
    const requestId = mocks.generate.mock.calls[0][1].requestId;
    await act(async () => { mocks.events.get('mood-board:generate')(run({ requestId, revision: 3, status: 'queued', phase: null, items: [{ itemId: 'new', jobId: 'image-job' }] })); });
    await act(async () => resolve(run({ requestId })));
    expect(screen.getByText('Render image-job')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1 images queued');
    await act(async () => mocks.events.get('mood-board:generate')(run({ boardId: 'other', revision: 99 })));
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1 images queued');
  });

  it('retains an uncertain request for duplicate-safe retry and accepts ordinary resolution and renderer controls', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('Network lost'));
    await open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate images' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '1024×1024' } });
    fireEvent.change(screen.getByLabelText('Image renderer'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate images' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry request' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1][1]).toEqual(mocks.generate.mock.calls[0][1]);
    expect(mocks.generate.mock.calls[1][1].render).toEqual({ width: 1024, height: 1024, mode: 'codex' });
  });

  it('restores progress on return and releases a stale running state after server restart', async () => {
    mocks.restore.mockResolvedValueOnce(run());
    await open();
    await screen.findByText('Writing image prompts…');
    expect(screen.getByRole('button', { name: 'Generate images' })).toBeDisabled();
    await act(async () => mocks.events.get('connect')());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate images' })).toBeEnabled());
  });

  it('accepts a new server epoch with a lower revision when another tab restarted generation', async () => {
    mocks.restore.mockResolvedValueOnce(run({ revision: 20 }));
    await open();
    await screen.findByText('Writing image prompts…');
    mocks.restore.mockResolvedValueOnce(run({ requestId: 'new-run', epoch: 'server-two', revision: 1, status: 'queued' }));
    await act(async () => mocks.events.get('connect')());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate images' })).toBeEnabled());
    expect(screen.getByRole('status')).toHaveTextContent('Images will appear');
  });

  it('allows a new batch after an expired retry is definitively rejected and gates unsaved board descriptions', async () => {
    mocks.restore.mockResolvedValueOnce(run({ status: 'failed', error: 'Queue unavailable' }));
    const ui = await open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry unfinished batch' })).toBeEnabled());
    mocks.generate.mockRejectedValueOnce(Object.assign(new Error('Run expired'), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry unfinished batch' }));
    await screen.findByText('Run expired');
    fireEvent.click(screen.getByRole('button', { name: 'Generate images' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1][1].requestId).not.toBe('request');
    expect(mocks.generate.mock.calls[1][1].retry).toBe(false);
    ui.rerender(<MoodBoardGeneratePanel board={board} disabled />);
    expect(screen.getByRole('button', { name: 'Generate images' })).toBeDisabled();
  });

  it('unsubscribes on navigation and ignores the old request result', async () => {
    let resolve;
    mocks.generate.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const ui = await open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate images' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Generate images' }));
    ui.unmount();
    await act(async () => resolve(run()));
    expect(mocks.events.size).toBe(0);
  });
});
