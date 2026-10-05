import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SpokenCheckChip, { countLinesNeedingListen } from './SpokenCheckChip';

describe('SpokenCheckChip', () => {
  it('renders nothing without a verification', () => {
    const { container } = render(<SpokenCheckChip verification={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows matched and unverified states', () => {
    const { rerender } = render(<SpokenCheckChip verification={{ status: 'matched' }} />);
    expect(screen.getByText(/matched/)).toBeInTheDocument();
    rerender(<SpokenCheckChip verification={{ status: 'unverified' }} />);
    expect(screen.getByText(/unverified/)).toBeInTheDocument();
  });

  it('shows what was heard on a mismatch and wires Re-render and Accept as spoken', () => {
    const onRerender = vi.fn();
    const onAccept = vi.fn();
    render(<SpokenCheckChip verification={{ status: 'mismatch', heard: 'Ay-Ai rules' }} onRerender={onRerender} onAccept={onAccept} />);
    expect(screen.getByText(/Ay-Ai rules/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Re-render'));
    fireEvent.click(screen.getByText('Accept as spoken'));
    expect(onRerender).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('counts only mismatches', () => {
    expect(countLinesNeedingListen([
      { verification: { status: 'mismatch' } }, { verification: { status: 'matched' } }, {}, null,
    ])).toBe(1);
  });
});
