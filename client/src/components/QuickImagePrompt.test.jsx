import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import QuickImagePrompt from './QuickImagePrompt';

// generateImage + listUniverseStyles are the only network calls; MediaJobThumb
// subscribes to sockets (irrelevant here) so stub it to a marker.
const generateImage = vi.fn();
const listUniverseStyles = vi.fn();
vi.mock('../services/api', () => ({
  generateImage: (...args) => generateImage(...args),
  listUniverseStyles: (...args) => listUniverseStyles(...args),
}));
vi.mock('./pipeline/MediaJobThumb', () => ({ default: () => <div data-testid="job-thumb" /> }));
vi.mock('./ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

// Settles the mount fetch before returning so no test has to remember to — a
// state update from it after the test body starts trips the act() guard.
const renderWidget = async () => {
  render(
    <MemoryRouter>
      <QuickImagePrompt />
    </MemoryRouter>,
  );
  await waitFor(() => expect(listUniverseStyles).toHaveBeenCalled());
};

beforeEach(() => {
  localStorage.clear();
  generateImage.mockReset();
  generateImage.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
  listUniverseStyles.mockReset();
  listUniverseStyles.mockResolvedValue([]);
});

describe('QuickImagePrompt — resolution control', () => {
  it('offers a Custom… option alongside the universal presets', async () => {
    await renderWidget();
    expect(screen.getByRole('option', { name: 'Custom…' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '1024×1024' })).toBeTruthy();
  });

  it('reveals width/height inputs when Custom… is selected and generates with the typed size', async () => {
    await renderWidget();
    // Default 1024×1024 matches a preset → no custom inputs yet.
    expect(screen.queryByLabelText('Width')).toBeNull();

    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '__custom__' } });
    const widthInput = screen.getByLabelText('Width');
    const heightInput = screen.getByLabelText('Height');
    expect(widthInput.value).toBe('1024');

    fireEvent.change(widthInput, { target: { value: '704' } });
    fireEvent.change(heightInput, { target: { value: '1280' } });

    fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a neon alley' } });
    fireEvent.click(screen.getByTitle('Generate with these settings'));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a neon alley', width: 704, height: 1280 }),
    );
  });

  it('keeps an off-preset size visible in the inputs rather than a blank select', async () => {
    await renderWidget();
    // Land on an off-preset size via the custom flow, then confirm it round-trips
    // to the visible inputs (the old inline <select> rendered a blank option).
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '900' } });
    expect(screen.getByLabelText('Width').value).toBe('900');
    // Select still reflects the custom sentinel, not an empty value.
    expect(screen.getByLabelText('Resolution').value).toBe('__custom__');
  });
});

describe('QuickImagePrompt — universe styling', () => {
  const STYLES = [
    {
      id: 'u-1',
      name: 'Example Universe',
      influences: { embrace: ['inky linework', 'cold palette'], avoid: ['lowres'] },
    },
  ];

  it('hides the picker when no universe carries style tokens', async () => {
    await renderWidget();
    expect(screen.queryByLabelText('Universe style')).toBeNull();
  });

  it('prefixes the prompt and appends the avoid tokens for the selected universe', async () => {
    listUniverseStyles.mockResolvedValue(STYLES);
    await renderWidget();

    fireEvent.change(await screen.findByLabelText('Universe style'), { target: { value: 'u-1' } });
    fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a quiet harbor' } });
    fireEvent.click(screen.getByTitle('Generate with these settings'));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    const [params] = generateImage.mock.calls[0];
    expect(params.prompt).toBe('inky linework, cold palette. a quiet harbor');
    expect(params.negativePrompt).toContain('lowres');
  });

  it('submits the raw prompt when the picker is left on None', async () => {
    listUniverseStyles.mockResolvedValue(STYLES);
    await renderWidget();

    fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a quiet harbor' } });
    fireEvent.click(screen.getByTitle('Generate with these settings'));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].prompt).toBe('a quiet harbor');
  });

  // A universe deleted since the selection was persisted must not keep styling
  // renders — `stylePreset` resolves against the live list, not the saved id.
  it('ignores a persisted selection whose universe no longer exists', async () => {
    localStorage.setItem('dashboard.quickImage.universeId', JSON.stringify('u-gone'));
    listUniverseStyles.mockResolvedValue(STYLES);
    await renderWidget();

    fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a quiet harbor' } });
    fireEvent.click(screen.getByTitle('Generate with these settings'));

    await waitFor(() => expect(generateImage).toHaveBeenCalled());
    expect(generateImage.mock.calls[0][0].prompt).toBe('a quiet harbor');
  });
});
