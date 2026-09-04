import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SlotstreamServerCard from './SlotstreamServerCard.jsx';

const CATALOG = [
  { id: 'small-moe', repo: 'someone/small-moe', label: 'Small MoE', params: '30B total / 3B active', approxBytes: 17 * 1024 ** 3, note: 'Small enough to verify the whole install end to end.' },
  { id: 'big-moe', repo: 'someone/big-moe', label: 'Big MoE', params: '235B total / 22B active', approxBytes: 132 * 1024 ** 3, note: 'The headline case.' },
];

const renderCard = (status, props = {}) => {
  const handlers = {
    onRefresh: vi.fn(),
    onSaveLaunch: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onInstall: vi.fn(),
    onDownloadModel: vi.fn(),
    onCancelDownload: vi.fn(),
  };
  render(
    <SlotstreamServerCard status={status} loading={false} busy={false} actionInProgress={null} {...handlers} {...props} />,
  );
  return handlers;
};

describe('SlotstreamServerCard', () => {
  it('surfaces the memory plan instead of hiding it', () => {
    renderCard({
      installed: true,
      running: false,
      supported: true,
      cachedModels: ['qwen-moe'],
      memoryPlan: { targetGb: 22, expectedPeakGb: 22, expectedWarmDecodeToks: 8, auto: false },
    });
    expect(screen.getByText('Target').closest('p')).toHaveTextContent('22 GB');
    expect(screen.getByText('Expected peak').closest('p')).toHaveTextContent('22 GB');
    expect(screen.getByText('Warm decode').closest('p')).toHaveTextContent('~8 tok/s');
  });

  it('saves checkpoint, port, and memory-cap override', () => {
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      port: 5564,
      cachedModels: ['qwen-moe'],
      memoryPlan: { targetGb: 32, expectedPeakGb: 32, expectedWarmDecodeToks: 12, auto: true },
    });
    fireEvent.change(screen.getByLabelText('Checkpoint'), { target: { value: 'qwen-moe' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5565' } });
    fireEvent.change(screen.getByLabelText('Memory cap (GB)'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: /Save configuration/ }));
    expect(handlers.onSaveLaunch).toHaveBeenCalledWith({ model: 'qwen-moe', port: 5565, memoryGb: 22 });
  });

  it('seeds the form from the saved launch line so a saved cap survives a reload', () => {
    // Without this the memory cap the user saved is invisible on the next
    // visit, and re-saving after any other edit drops it — `launchPayload`
    // omits an empty field.
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      cachedModels: ['qwen-moe'],
      launch: { model: 'qwen-moe', port: 5565, memoryGb: 22 },
      memoryPlan: { targetGb: 22, expectedPeakGb: 22, expectedWarmDecodeToks: 8, auto: false },
    });
    expect(screen.getByLabelText('Memory cap (GB)')).toHaveValue(22);
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5566' } });
    fireEvent.click(screen.getByRole('button', { name: /Save configuration/ }));
    expect(handlers.onSaveLaunch).toHaveBeenCalledWith({ model: 'qwen-moe', port: 5566, memoryGb: 22 });
  });

  it('does not name a terminal command when the cache is empty', () => {
    renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: null });
    expect(screen.getByText(/never downloads weights/i)).toBeInTheDocument();
    expect(screen.queryByText(/in a terminal/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Save configuration/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Start Slotstream/ })).toBeNull();
  });

  it('offers a checkpoint to download when the cache is empty, instead of only a hand-placed directory', () => {
    // The empty cache used to be a dead end: the only way forward was to
    // assemble a 100 GB+ directory by hand outside the app.
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      cachedModels: [],
      cacheDir: '/tmp/example-slotstream/models',
      catalog: CATALOG,
    });
    const picker = screen.getByLabelText('Add a checkpoint');
    expect(picker).toBeInTheDocument();

    const download = screen.getByRole('button', { name: /Download checkpoint/ });
    // Nothing chosen yet — a transfer this size never starts on an empty pick.
    expect(download).toBeDisabled();

    fireEvent.change(picker, { target: { value: 'small-moe' } });
    expect(screen.getByText(/verify the whole install/i)).toBeInTheDocument();
    fireEvent.click(download);
    expect(handlers.onDownloadModel).toHaveBeenCalledWith('small-moe');
  });

  it('renders download progress and blocks a second press while one is running', () => {
    renderCard(
      { installed: true, running: false, supported: true, cachedModels: [], catalog: CATALOG },
      { download: { model: 'someone/small-moe', received: 5 * 1024 ** 3, total: 20 * 1024 ** 3 } },
    );
    fireEvent.change(screen.getByLabelText('Add a checkpoint'), { target: { value: 'small-moe' } });
    expect(screen.getByRole('button', { name: /Download checkpoint/ })).toBeDisabled();
    expect(screen.getByText('5 GB of 20 GB (25%)')).toBeInTheDocument();
  });

  // Without this the only way out of a 100 GB+ transfer that is slow rather
  // than stalled was to wait out the 20-minute idle watchdog.
  it('offers a cancel beside the bar while a checkpoint is transferring', () => {
    const handlers = renderCard(
      { installed: true, running: false, supported: true, cachedModels: [], catalog: CATALOG },
      { download: { model: 'someone/small-moe', received: 5 * 1024 ** 3, total: 20 * 1024 ** 3 } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(handlers.onCancelDownload).toHaveBeenCalledWith('someone/small-moe');
  });

  it('hides the cancel when nothing is transferring', () => {
    renderCard({ installed: true, running: false, supported: true, cachedModels: [], catalog: CATALOG });
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument();
  });

  it('offers a download while the server is running, so a second checkpoint needs no stop', () => {
    renderCard({
      installed: true,
      running: true,
      supported: true,
      endpoint: 'http://127.0.0.1:5564/v1',
      cachedModels: ['qwen-moe'],
      catalog: CATALOG,
    });
    expect(screen.getByLabelText('Add a checkpoint')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop Slotstream/ })).toBeInTheDocument();
  });

  it('leaves the picker out when the runtime is not installed', () => {
    renderCard({ installed: false, running: false, supported: true, catalog: CATALOG });
    expect(screen.queryByLabelText('Add a checkpoint')).toBeNull();
    expect(screen.getByRole('button', { name: /Install Slotstream/ })).toBeInTheDocument();
  });

  it('leaves the picker out when the runtime has no catalog to offer', () => {
    // An older status payload (a tab left open across an upgrade) carries no
    // catalog at all; the card must still render its launch controls.
    renderCard({ installed: true, running: false, supported: true, cachedModels: ['qwen-moe'] });
    expect(screen.queryByLabelText('Add a checkpoint')).toBeNull();
    expect(screen.getByLabelText('Checkpoint')).toBeInTheDocument();
  });

  it('disables the row copy on a non-Apple-Silicon host', () => {
    renderCard({ supported: false, unsupportedReason: 'Slotstream runs only on macOS with Apple Silicon.' });
    expect(screen.getByText(/macOS with Apple Silicon/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install Slotstream/ })).toBeNull();
  });
});
