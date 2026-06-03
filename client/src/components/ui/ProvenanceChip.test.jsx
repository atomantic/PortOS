import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import ProvenanceChip from './ProvenanceChip';
import { PROVENANCE_LEVELS } from '../../lib/healthProvenance.js';

describe('ProvenanceChip', () => {
  it('renders the level label and the success tone for data-backed', () => {
    render(<ProvenanceChip level="data-backed" />);
    const btn = screen.getByRole('button', { name: /data-backed/i });
    expect(btn.className).toContain('text-port-success');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('falls back to the inferred level for an unknown id', () => {
    render(<ProvenanceChip level="bogus" />);
    expect(screen.getByRole('button', { name: /inferred/i })).toBeTruthy();
  });

  it('reveals the default explainer and "what would change this?" on click', () => {
    render(<ProvenanceChip level="speculative" />);
    const btn = screen.getByRole('button');
    expect(screen.queryByText('What would change this?')).toBeNull();

    fireEvent.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('What would change this?')).toBeTruthy();
    expect(screen.getByText(PROVENANCE_LEVELS.speculative.description)).toBeTruthy();
    expect(screen.getByText(PROVENANCE_LEVELS.speculative.whatWouldChange)).toBeTruthy();
  });

  it('prefers custom explainer / whatWouldChange copy over the level defaults', () => {
    render(
      <ProvenanceChip
        level="inferred"
        explainer="Custom how-derived copy."
        whatWouldChange="Custom change copy."
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Custom how-derived copy.')).toBeTruthy();
    expect(screen.getByText('Custom change copy.')).toBeTruthy();
    expect(screen.queryByText(PROVENANCE_LEVELS.inferred.description)).toBeNull();
  });

  it('overrides the chip label when label prop is set, keeping the resolved tone', () => {
    render(<ProvenanceChip level="experimental" label="Beta clock" />);
    const btn = screen.getByRole('button', { name: /beta clock/i });
    expect(btn.className).toContain('text-port-warning');
  });

  it('closes the popover on a click outside', () => {
    render(
      <div>
        <ProvenanceChip level="inferred" />
        <button type="button">elsewhere</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /inferred/i }));
    expect(screen.getByText('What would change this?')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByText('What would change this?')).toBeNull();
  });

  it('closes the popover on Escape', () => {
    render(<ProvenanceChip level="inferred" />);
    const btn = screen.getByRole('button');
    fireEvent.click(btn);
    expect(screen.getByText('What would change this?')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('What would change this?')).toBeNull();
  });
});
