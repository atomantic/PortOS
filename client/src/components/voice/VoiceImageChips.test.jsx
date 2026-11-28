import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import VoiceImageChips from './VoiceImageChips';

describe('VoiceImageChips', () => {
  it('announces image analysis status transitions in a live region and wires aria-controls only while open', () => {
    const analyzing = [{ id: 'img-1', name: 'chart.png', source: 'upload', status: 'analyzing' }];
    const { rerender } = render(<VoiceImageChips images={analyzing} />);

    expect(screen.getByRole('status')).toHaveTextContent('chart.png: Reading…');
    const chip = screen.getByRole('button', { name: /chart\.png/ });
    expect(chip).toBeDisabled();
    expect(chip).not.toHaveAttribute('aria-controls');

    const ready = [{ id: 'img-1', name: 'chart.png', source: 'upload', status: 'ready', text: 'Bar chart of latency', model: 'gemma' }];
    rerender(<VoiceImageChips images={ready} />);

    expect(screen.getByRole('status')).toHaveTextContent('chart.png: Ready');
    expect(chip).toBeEnabled();
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).not.toHaveAttribute('aria-controls');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    const detailId = chip.getAttribute('aria-controls');
    expect(detailId).toBeTruthy();
    expect(document.getElementById(detailId)).toHaveTextContent('Bar chart of latency');

    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip).not.toHaveAttribute('aria-controls');
  });
});
