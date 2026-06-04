import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReferenceImagePicker from './ReferenceImagePicker';

const emptySlot = () => ({ file: null, previewUrl: null, strength: 1.0 });
const fourEmpty = () => Array.from({ length: 4 }, emptySlot);

describe('ReferenceImagePicker', () => {
  it('renders an Add tile per empty slot', () => {
    render(<ReferenceImagePicker referenceImages={fourEmpty()} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getAllByText('Add')).toHaveLength(4);
    expect(screen.getByText('Ref 1')).toBeTruthy();
    expect(screen.getByText('Ref 4')).toBeTruthy();
  });

  it('renders a thumbnail + strength slider for a populated slot', () => {
    const slots = fourEmpty();
    slots[1] = { file: null, previewUrl: 'blob:two', strength: 0.6 };
    render(<ReferenceImagePicker referenceImages={slots} onPick={vi.fn()} onClear={vi.fn()} onStrengthChange={vi.fn()} />);
    expect(screen.getByAltText('Reference 2')).toBeTruthy();
    expect(screen.getByText(/Strength 0.60/)).toBeTruthy();
    expect(screen.getAllByText('Add')).toHaveLength(3);
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
