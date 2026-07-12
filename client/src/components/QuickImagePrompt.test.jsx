import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import QuickImagePrompt from './QuickImagePrompt';

// generateImage is the only network call; MediaJobThumb subscribes to sockets
// (irrelevant to this widget's resolution wiring) so stub it to a marker.
const generateImage = vi.fn();
vi.mock('../services/api', () => ({ generateImage: (...args) => generateImage(...args) }));
vi.mock('./pipeline/MediaJobThumb', () => ({ default: () => <div data-testid="job-thumb" /> }));
vi.mock('./ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderWidget = () =>
  render(
    <MemoryRouter>
      <QuickImagePrompt />
    </MemoryRouter>,
  );

describe('QuickImagePrompt — resolution control', () => {
  beforeEach(() => {
    generateImage.mockReset();
    generateImage.mockResolvedValue({ jobId: 'job-1', status: 'queued' });
  });

  it('offers a Custom… option alongside the universal presets', () => {
    renderWidget();
    expect(screen.getByRole('option', { name: 'Custom…' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '1024×1024' })).toBeTruthy();
  });

  it('reveals width/height inputs when Custom… is selected and generates with the typed size', async () => {
    renderWidget();
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

  it('keeps an off-preset size visible in the inputs rather than a blank select', () => {
    renderWidget();
    // Land on an off-preset size via the custom flow, then confirm it round-trips
    // to the visible inputs (the old inline <select> rendered a blank option).
    fireEvent.change(screen.getByLabelText('Resolution'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '900' } });
    expect(screen.getByLabelText('Width').value).toBe('900');
    // Select still reflects the custom sentinel, not an empty value.
    expect(screen.getByLabelText('Resolution').value).toBe('__custom__');
  });
});
