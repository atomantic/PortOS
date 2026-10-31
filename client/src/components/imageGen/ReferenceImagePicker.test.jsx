import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReferenceImagePicker from './ReferenceImagePicker';

const emptySlot = () => ({ file: null, previewUrl: null, strength: 1.0 });
const fourEmpty = () => Array.from({ length: 4 }, emptySlot);

describe('ReferenceImagePicker', () => {
  it('renders an Upload tile per empty slot', () => {
    render(<ReferenceImagePicker referenceImages={fourEmpty()} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getAllByText('Upload')).toHaveLength(4);
    expect(screen.getByText('Ref 1')).toBeTruthy();
    expect(screen.getByText('Ref 4')).toBeTruthy();
  });

  it('renders one tile per slot it is given, so a capped backend shows no droppable slot', () => {
    render(<ReferenceImagePicker referenceImages={fourEmpty().slice(0, 2)} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getAllByText('Upload')).toHaveLength(2);
    expect(screen.queryByText('Ref 3')).toBeNull();
  });

  it('hides the strength slider on backends with no numeric per-reference weight', () => {
    const slots = fourEmpty();
    slots[0] = { file: null, previewUrl: 'blob:one', strength: 0.5 };
    const { container } = render(
      <ReferenceImagePicker referenceImages={slots} showStrength={false} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />,
    );
    // The thumbnail and its clear button stay — only the inert control goes.
    expect(screen.getByTitle('Remove reference 1')).toBeTruthy();
    expect(container.querySelector('input[type="range"]')).toBeNull();
  });

  it('renders the caller-supplied caption', () => {
    render(<ReferenceImagePicker referenceImages={fourEmpty()} caption="up to 2 more images Agy will use as visual references" onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getByText('(up to 2 more images Agy will use as visual references)')).toBeTruthy();
  });

  it('renders a per-slot Gallery button when onBrowse is set and fires it with the slot index', () => {
    const onBrowse = vi.fn();
    render(<ReferenceImagePicker referenceImages={fourEmpty()} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} onBrowse={onBrowse} />);
    const galleryButtons = screen.getAllByText('Gallery');
    expect(galleryButtons).toHaveLength(4);
    fireEvent.click(galleryButtons[2]);
    expect(onBrowse).toHaveBeenCalledWith(2);
  });

  it('gives the Gallery and Remove controls phone-sized touch targets', () => {
    const slots = fourEmpty();
    slots[0] = { file: null, previewUrl: 'blob:one', strength: 0.5 };
    render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} onBrowse={vi.fn()} />);
    // Phones get a 44px Gallery target and a 32px Remove chip; desktop keeps the 20px bars.
    expect(screen.getAllByText('Gallery')[1].className).toContain('min-h-[44px]');
    expect(screen.getByTitle('Remove reference 1').className).toContain('max-sm:w-8');
  });

  it('omits the Gallery button when onBrowse is absent', () => {
    render(<ReferenceImagePicker referenceImages={fourEmpty()} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.queryByText('Gallery')).toBeNull();
  });

  it('renders a thumbnail + strength slider for a populated slot', () => {
    const slots = fourEmpty();
    slots[1] = { file: null, previewUrl: 'blob:two', strength: 0.6 };
    render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getByAltText('Reference 2')).toBeTruthy();
    expect(screen.getByText(/Strength 0.60/)).toBeTruthy();
    expect(screen.getAllByText('Upload')).toHaveLength(3);
  });

  it('fires onClear with the slot index', () => {
    const slots = fourEmpty();
    slots[2] = { file: null, previewUrl: 'blob:three', strength: 1.0 };
    const onClear = vi.fn();
    render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={onClear} onStrengthChange={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Remove reference 3'));
    expect(onClear).toHaveBeenCalledWith(2);
  });

  it('fires onStrengthChange with slot index and numeric value', () => {
    const slots = fourEmpty();
    slots[0] = { file: null, previewUrl: 'blob:one', strength: 0.5 };
    const onStrengthChange = vi.fn();
    const { container } = render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={onStrengthChange} />);
    fireEvent.change(container.querySelector('input[type="range"]'), { target: { value: '0.25' } });
    expect(onStrengthChange).toHaveBeenCalledWith(0, 0.25);
  });

  it('fires onPick with slot index and event when a file is chosen on an empty slot', () => {
    const onPick = vi.fn();
    const { container } = render(<ReferenceImagePicker referenceImages={fourEmpty()} onPick={onPick} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(fileInputs[3], { target: { files: [] } });
    expect(onPick).toHaveBeenCalledWith(3, expect.anything());
  });

  it('disables clear buttons and sliders when disabled', () => {
    const slots = fourEmpty();
    slots[0] = { file: null, previewUrl: 'blob:one', strength: 0.5 };
    const { container } = render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} disabled />);
    expect(screen.getByTitle('Remove reference 1').disabled).toBe(true);
    expect(container.querySelector('input[type="range"]').disabled).toBe(true);
  });
});
