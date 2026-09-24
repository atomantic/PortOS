import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';

import {
  imageGenPeer,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

// The backend probe is held open on purpose: an unconfigured `external` SD API
// URL times out, and that window used to grey out the whole form.
let resolveStatus = null;

await loadImageGenPage();

const mount = (path = '/media/image') => renderImageGenPage(path);

describe('ImageGen backend-probe gating', () => {
  beforeEach(() => {
    resetImageGenMockState();
    // Interactive MediaCard so a suite can drive hide/delete through the page's
    // own handlers, and a MediaPreview that renders only while a preview is open.
    state.mediaCardFactory = ({ item, onToggleHidden, onDelete }) => (
      <div>
        <button type="button" onClick={() => onToggleHidden(item)}>{item.filename}</button>
        <button type="button" aria-label={`Delete ${item.filename}`} onClick={() => onDelete(item)}>Delete</button>
      </div>
    );
    state.mediaPreviewFactory = ({ preview }) => (
      preview ? <div role="dialog" aria-label={`Preview ${preview.filename}`} /> : null
    );
    state.getImageGenStatus.mockImplementation(() => new Promise((resolve) => { resolveStatus = resolve; }));
    window.matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it('requests only five recent images, shows the global count, and queries favorites before limiting', async () => {
    const items = Array.from({ length: 5 }, (_, n) => ({ filename: `recent-${n}.png` }));
    state.listImageGalleryPage.mockResolvedValueOnce({ items, total: 2100, hiddenTotal: 70 })
      .mockResolvedValueOnce({ items: [{ filename: 'old-favorite.png' }], total: 1, hiddenTotal: 0 });
    await mount();
    expect(await screen.findByText('Recent renders (5 of 2100)')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all →' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show hidden \(70\)/ })).toBeInTheDocument();
    expect(state.listImageGalleryPage).toHaveBeenCalledTimes(1);
    expect(state.listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 5, hidden: false, starred: false, summary: true }, { silent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Favorites' }));
    expect(await screen.findByText('old-favorite.png')).toBeInTheDocument();
    expect(screen.getByText('Recent renders (1 of 1)')).toBeInTheDocument();
    expect(state.listImageGalleryPage).toHaveBeenLastCalledWith(
      { limit: 5, hidden: false, starred: true, summary: true }, { silent: true });
  });

  it('opens an older hidden deep link independently of the recent strip and retains a card when deletion fails', async () => {
    state.listImageGalleryPage.mockImplementation(async ({ filename }) => filename
      ? { items: [{ filename, hidden: true }], total: 1 }
      : { items: [{ filename: 'recent.png' }], total: 1, hiddenTotal: 1 });
    await mount('/media/image?preview=image:older.png');
    expect(await screen.findByRole('dialog', { name: 'Preview older.png' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show hidden/ })).toBeInTheDocument();
    expect(state.listImageGalleryPage).toHaveBeenCalledWith({ limit: 1, filename: 'older.png' }, { silent: true });
    state.deleteImage.mockRejectedValueOnce(new Error('cannot delete'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete recent.png' })));
    expect(screen.getByRole('button', { name: 'recent.png' })).toBeInTheDocument();
    expect(screen.getByText('Recent renders (1 of 1)')).toBeInTheDocument();
  });

  // The probe decides which backend can RUN, not what the user may TYPE. While
  // it is in flight the whole above-the-fold form must stay usable.
  it('leaves the prompt fields editable while the status probe is still in flight', async () => {
    await mount();

    expect(await screen.findByLabelText('Prompt')).not.toBeDisabled();
    expect(screen.getByLabelText('Negative Prompt')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
  });

  // A probe that comes back unusable must still not take the form hostage —
  // only submit stays blocked, so the user can compose while they fix settings.
  it('keeps the prompt editable and submit blocked when the probe reports not connected', async () => {
    await mount();
    await act(async () => {
      resolveStatus({ connected: false, mode: 'local', reason: 'Not configured' });
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled());
    expect(screen.getByLabelText('Prompt')).not.toBeDisabled();
    expect(screen.getByLabelText('Negative Prompt')).not.toBeDisabled();
  });

  it('vertically centers the ready status icon with the text in the status pill', async () => {
    await mount();
    await act(async () => {
      resolveStatus({ connected: true, mode: 'local', model: 'Qwen-Image 2.1' });
    });

    const badge = await screen.findByText(/Ready — Qwen-Image 2\.1/);
    expect(badge.className).toContain('items-center');
    expect(badge.className).not.toContain('items-start');
    const dot = badge.querySelector('.rounded-full.bg-port-success');
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain('shrink-0');
  });

  // A live form has a live implicit submit: Enter inside a number input fires
  // onSubmit even when the default button is disabled, so the handler carries
  // the same probe gate the button does.
  it('refuses an implicit submit fired while the probe is still in flight', async () => {
    await mount();

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a lighthouse at dusk' } });
    await act(async () => { fireEvent.submit(prompt.closest('form')); });

    expect(state.generateImage).not.toHaveBeenCalled();
  });

  // A federated render runs on the peer, so THIS machine's probe — hung against
  // an unconfigured SD API URL — must not hold the submit hostage.
  it('still submits to a ready peer while the local probe hangs', async () => {
    const { getInstances } = await import('../services/api');
    getInstances.mockResolvedValueOnce({ peers: [imageGenPeer()] });
    await mount();

    fireEvent.change(await screen.findByRole('combobox', { name: /generation target/i }), { target: { value: 'peer-example' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'a lighthouse at dusk' } });

    const generate = screen.getByRole('button', { name: /^Generate$/ });
    expect(generate).not.toBeDisabled();
    await act(async () => { fireEvent.click(generate); });

    await waitFor(() => expect(state.generateImage).toHaveBeenCalled());
    expect(state.generateImage.mock.calls[0][0]).toMatchObject({ mediaProviderPeerId: 'peer-example' });
  });

  it('reseeds cleaner defaults when the selected backend changes', async () => {
    state.settings = {
      imageGen: {
        mode: 'local',
        local: { pythonPath: '/usr/bin/python3', denoise: false },
        grok: { enabled: true, denoise: true },
      },
    };
    state.getImageGenStatus.mockImplementation(async (mode) => ({ connected: true, mode, model: mode }));
    await mount();

    expect(screen.getByRole('checkbox', { name: /Denoise/, hidden: true })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /Grok/i }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Denoise/, hidden: true })).toBeChecked());
  });

  it('keeps prompt and Generate ahead of closed mobile Options', async () => {
    await mount();

    const prompt = await screen.findByLabelText('Prompt');
    const generate = screen.getByRole('button', { name: /^Generate$/ });
    const options = screen.getByText('Options').closest('details');
    const primaryActions = screen.getByTestId('image-primary-actions');

    expect(options).not.toHaveAttribute('open');
    expect(options).not.toContainElement(prompt);
    expect(options).toContainElement(screen.getByLabelText('Negative Prompt'));
    expect(options).toContainElement(screen.getByRole('button', { name: 'Enhance with AI' }));
    expect(options).toContainElement(screen.getByRole('button', { name: 'Prompt from media' }));
    expect(primaryActions).toContainElement(generate);
    expect(primaryActions.className).toContain('sticky');
    expect(primaryActions.className).toContain('lg:static');
    expect(prompt.compareDocumentPosition(generate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(generate.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens Options and preserves the two-column form at desktop width', async () => {
    window.matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    await mount();

    const options = screen.getByText('Options').closest('details');
    expect(options).toHaveAttribute('open');
    expect(options.closest('form').className).toContain('lg:grid-cols-[3fr_2fr]');
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });
});
