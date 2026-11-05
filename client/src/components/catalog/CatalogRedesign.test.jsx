import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import CatalogRedesign, { CatalogRedesignButton } from './CatalogRedesign';

vi.mock('../creative/CreativeRefinement', () => ({
  default: ({ disabled, onApply }) => <div>
    <label htmlFor="redesign-feedback">Creative direction</label><input id="redesign-feedback" />
    <button type="button" disabled={disabled} onClick={() => onApply({ description: 'Revised design' })}>Apply proposal</button>
  </div>,
}));

function Harness({ disabled = false, onApply }) {
  const [open, setOpen] = useState(null);
  return <>
    <header><CatalogRedesignButton type="object" open={open} controls="redesign-panel" onToggle={() => setOpen(!open)} /></header>
    <CatalogRedesign id="redesign-panel" ingredient={{ id: 'example', type: 'object' }} payload={{ description: 'Original' }} open={open} disabled={disabled} onApply={onApply} />
  </>;
}

describe('catalog redesign header action', () => {
  it('preserves the conversation when closed and reopened, and keeps application gated', async () => {
    const onApply = vi.fn();
    const view = render(<Harness onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redesign with a creative assistant' }));
    const feedback = await screen.findByRole('textbox', { name: 'Creative direction' });
    fireEvent.change(feedback, { target: { value: 'Keep this direction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close redesign conversation' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Redesign with a creative assistant' }));
    expect(screen.getByRole('textbox')).toHaveValue('Keep this direction');
    view.rerender(<Harness disabled onApply={onApply} />);
    expect(screen.getByRole('button', { name: 'Apply proposal' })).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
    view.rerender(<Harness onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposal' }));
    expect(onApply).toHaveBeenCalledWith({ description: 'Revised design' });
  });
});
