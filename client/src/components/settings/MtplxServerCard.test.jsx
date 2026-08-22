import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MtplxServerCard from './MtplxServerCard.jsx';

const renderCard = async (status, props = {}) => {
  const handlers = {
    onRefresh: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onInstall: vi.fn(),
    // The checkpoint manager loads upstream's default listing on mount.
    onSearchModels: vi.fn().mockResolvedValue({ models: [], error: null }),
    onPullModel: vi.fn(),
    onRemoveModel: vi.fn(),
  };
  render(
    <MemoryRouter>
      <MtplxServerCard status={status} loading={false} busy={false} actionInProgress={null} {...handlers} {...props} />
    </MemoryRouter>,
  );
  // The checkpoint manager fetches its default listing on mount — settle it so
  // its state update lands inside act().
  await act(async () => {});
  return handlers;
};

describe('MtplxServerCard', () => {
  it('starts on the cached checkpoint and port the user picked', async () => {
    const handlers = await renderCard({
      installed: true,
      running: false,
      supported: true,
      port: 8000,
      cachedModels: ['Example/Qwen-MTP', 'Example/Other-MTP'],
    });

    fireEvent.change(screen.getByLabelText('Checkpoint'), { target: { value: 'Example/Other-MTP' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '8010' } });
    fireEvent.click(screen.getByRole('button', { name: /Start MTPLX/ }));

    expect(handlers.onStart).toHaveBeenCalledWith({ model: 'Example/Other-MTP', port: 8010 });
  });

  it('omits an untouched field so PortOS picks the cache default and the shipped port', async () => {
    const handlers = await renderCard({ installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'] });
    fireEvent.click(screen.getByRole('button', { name: /Start MTPLX/ }));
    expect(handlers.onStart).toHaveBeenCalledWith({});
  });

  it('offers an in-app download instead of a start that cannot bind', async () => {
    // No start downloads weights, and `mtplx serve` exits before it binds a port
    // on an empty cache — so the card offers the download itself rather than
    // naming a terminal command (PRD NR-9).
    const handlers = await renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: null });
    expect(screen.getByText(/model cache is empty/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start MTPLX/ })).toBeDisabled();
    expect(screen.queryByText(/in a terminal/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Download default checkpoint/ }));
    // `null` = MTPLX's own verified default, the checkpoint the readiness
    // checklist pulls — not a repo id the card invented.
    expect(handlers.onPullModel).toHaveBeenCalledWith(null);
    expect(handlers.onSearchModels).toHaveBeenCalled();
  });

  it('downloads a searched checkpoint and removes a cached one', async () => {
    const handlers = await renderCard(
      {
        installed: true,
        running: false,
        supported: true,
        cachedModels: ['Example/Cached-MTP'],
        cachedModelRows: [{ repo: 'Example/Cached-MTP', sizeBytes: 1024, hasRuntimeContract: true, valid: true }],
      },
      {
        onSearchModels: vi.fn().mockResolvedValue({
          models: [{ repo: 'Example/New-MTP', name: 'New MTP', owner: 'Example', downloads: 12, license: 'apache-2.0' }],
          error: null,
        }),
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Download$/ }));
    expect(handlers.onPullModel).toHaveBeenCalledWith('Example/New-MTP');

    // Removal is confirm-then-delete inline — no window.confirm.
    fireEvent.click(screen.getByRole('button', { name: /^Remove$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(handlers.onRemoveModel).toHaveBeenCalledWith('Example/Cached-MTP');
  });

  it("shows a search hit's age in days, and no age for a repo the Hub had no date for", async () => {
    // The age is what says whether a checkpoint is worth a multi-gigabyte pull, and
    // a dateless row must stay silent rather than rendering a placeholder age.
    const publishedAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await renderCard(
      { installed: true, running: false, supported: true, cachedModels: [] },
      {
        onSearchModels: vi.fn().mockResolvedValue({
          models: [
            { repo: 'Example/Dated-MTP', name: 'Dated MTP', owner: 'Example', downloads: 12, publishedAt },
            { repo: 'Example/Undated-MTP', name: 'Undated MTP', owner: 'Example', downloads: 3, publishedAt: null },
          ],
          error: null,
        }),
      },
    );

    expect(await screen.findByText(/published 5 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/Example\/Undated-MTP/)).not.toHaveTextContent(/published/);
  });

  it('marks an already-cached search hit instead of offering to download it again', async () => {
    await renderCard(
      {
        installed: true,
        running: false,
        supported: true,
        cachedModels: ['Example/Cached-MTP'],
        cachedModelRows: [{ repo: 'Example/Cached-MTP', sizeBytes: 1024, valid: true }],
      },
      {
        onSearchModels: vi.fn().mockResolvedValue({
          models: [{ repo: 'Example/Cached-MTP', name: 'Cached MTP', owner: 'Example' }],
          error: null,
        }),
      },
    );
    expect(await screen.findByText('Cached')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Download$/ })).toBeNull();
  });

  it('still offers a start when the cache could not be READ — unreadable is not empty', async () => {
    const handlers = await renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: '`mtplx models` timed out' });
    const start = screen.getByRole('button', { name: /Start MTPLX/ });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    expect(handlers.onStart).toHaveBeenCalled();
  });

  it('will not offer to stop a server started outside PortOS', async () => {
    await renderCard({ installed: true, running: true, managed: false, supported: true, endpoint: 'http://127.0.0.1:8000/v1' });
    expect(screen.getByText(/Started outside PortOS/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop MTPLX/ })).toBeNull();
  });

  // A measured assessment relaunches this daemon with tuning flags and leaves
  // them on, so every later request through the `mtplx` provider runs under
  // them. A card showing only the model would report the server as plain
  // "running" while it serves with, say, MTP decoding switched off.
  it('names the tuning flags the running daemon was launched with', async () => {
    await renderCard({
      installed: true, running: true, managed: true, supported: true,
      endpoint: 'http://127.0.0.1:8000/v1',
      config: { model: 'Example/Qwen-MTP', port: 8000, tuning: { generationMode: 'ar' } },
      tuningFlags: ['--generation-mode', 'ar'],
    });
    expect(screen.getByText('--generation-mode ar')).toBeInTheDocument();
  });

  it('says nothing about tuning for a daemon running on plain defaults', async () => {
    await renderCard({
      installed: true, running: true, managed: true, supported: true,
      endpoint: 'http://127.0.0.1:8000/v1',
      config: { model: 'Example/Qwen-MTP', port: 8000, tuning: {} },
      tuningFlags: [],
    });
    expect(screen.queryByText(/Tuning:/)).toBeNull();
  });

  it('offers the install when the binary is missing', async () => {
    const handlers = await renderCard({ installed: false, running: false, supported: true });
    fireEvent.click(screen.getByRole('button', { name: /Install MTPLX/ }));
    expect(handlers.onInstall).toHaveBeenCalled();
  });

  it('says why, and offers nothing, on a host that cannot run MLX', async () => {
    await renderCard({ installed: false, running: false, supported: false, unsupportedReason: 'MTPLX runs only on macOS with Apple Silicon.' });
    expect(screen.getByText('MTPLX runs only on macOS with Apple Silicon.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install MTPLX/ })).toBeNull();
  });
});
