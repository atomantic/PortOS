import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FramePanel from './FramePanel';

const GALLERY = [{ filename: 'a.png' }, { filename: 'b.png' }];

describe('FramePanel', () => {
  it('renders the gallery + upload picker when empty', () => {
    render(
      <FramePanel
        label="Source image"
        file={null}
        upload={null}
        uploadUrl={null}
        visibleGallery={GALLERY}
        onPickGallery={vi.fn()}
        onUpload={vi.fn()}
        onClear={vi.fn()}
        alt="Source"
      />,
    );
    expect(screen.getByLabelText(/Source image — pick from gallery/i)).toBeTruthy();
    expect(screen.getByText(/Upload an image/i)).toBeTruthy();
    // No Clear button until something is selected.
    expect(screen.queryByText('Clear')).toBeNull();
  });

  it('fires onPickGallery with the chosen filename', () => {
    const onPickGallery = vi.fn();
    render(
      <FramePanel
        label="First frame"
        file={null}
        upload={null}
        uploadUrl={null}
        visibleGallery={GALLERY}
        onPickGallery={onPickGallery}
        onUpload={vi.fn()}
        onClear={vi.fn()}
        alt="Source"
      />,
    );
    fireEvent.change(screen.getByLabelText(/First frame — pick from gallery/i), { target: { value: 'b.png' } });
    expect(onPickGallery).toHaveBeenCalledWith('b.png');
  });

  it('shows the gallery preview + Clear when a file is set', () => {
    const onClear = vi.fn();
    render(
      <FramePanel
        label="Source image"
        file="a.png"
        upload={null}
        uploadUrl={null}
        visibleGallery={GALLERY}
        onPickGallery={vi.fn()}
        onUpload={vi.fn()}
        onClear={onClear}
        alt="Source"
      />,
    );
    const img = screen.getByAltText('Source');
    expect(img.getAttribute('src')).toBe('/data/images/a.png');
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('renders advisory + hint copy when provided', () => {
    render(
      <FramePanel
        label="Last frame"
        file={null}
        upload={null}
        uploadUrl={null}
        visibleGallery={GALLERY}
        onPickGallery={vi.fn()}
        onUpload={vi.fn()}
        onClear={vi.fn()}
        alt="End frame"
        advisoryNote={{ text: 'Experimental note', title: 'why' }}
        hint={{ text: 'Hint copy', title: 'how' }}
      />,
    );
    expect(screen.getByText('Experimental note')).toBeTruthy();
    expect(screen.getByText('Hint copy')).toBeTruthy();
  });
});
