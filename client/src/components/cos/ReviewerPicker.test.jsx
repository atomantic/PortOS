import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewerPicker from './ReviewerPicker';

describe('ReviewerPicker', () => {
  it('renders the selected reviewers in order with numbered badges', () => {
    render(<ReviewerPicker reviewers={['codex', 'gemini', 'copilot']} onChange={() => {}} />);
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    expect(screen.getByText('3.')).toBeInTheDocument();
    // The not-yet-selected reviewer (claude) shows in the Add row.
    expect(screen.getByRole('button', { name: /Claude/ })).toBeInTheDocument();
  });

  it('shows the empty-state hint when no reviewers are selected', () => {
    render(<ReviewerPicker reviewers={[]} onChange={() => {}} />);
    expect(screen.getByText(/none — defaults to Copilot/)).toBeInTheDocument();
  });

  it('de-dupes a malformed list with duplicates (order-preserving)', () => {
    render(<ReviewerPicker reviewers={['codex', 'codex', 'gemini']} onChange={() => {}} />);
    // Two distinct pills (badges 1 and 2), not three.
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    expect(screen.queryByText('3.')).not.toBeInTheDocument();
  });

  it('emits an empty list when the last reviewer is removed (server resolves to copilot)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Remove Copilot'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: [] }));
  });

  it('appends a reviewer in click order on add', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Codex/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['copilot', 'codex'] }));
  });

  it('reorders with the up arrow', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['codex', 'gemini', 'copilot']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Move Gemini earlier'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['gemini', 'codex', 'copilot'] }));
  });

  it('removes a reviewer', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['codex', 'copilot']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Remove Codex'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['copilot'] }));
  });

  it('shows the stop-mode select only for 2+ reviewers', () => {
    const { rerender } = render(<ReviewerPicker reviewers={['codex']} onChange={() => {}} />);
    expect(screen.queryByText('Stop mode:')).not.toBeInTheDocument();
    rerender(<ReviewerPicker reviewers={['codex', 'gemini']} onChange={() => {}} />);
    expect(screen.getByText('Stop mode:')).toBeInTheDocument();
  });

  it('shows the reviewer-applies toggle only when a non-copilot reviewer is present', () => {
    const { rerender } = render(<ReviewerPicker reviewers={['copilot']} onChange={() => {}} />);
    expect(screen.queryByText(/Reviewer applies fixes/)).not.toBeInTheDocument();
    rerender(<ReviewerPicker reviewers={['codex']} onChange={() => {}} />);
    expect(screen.getByText(/Reviewer applies fixes/)).toBeInTheDocument();
  });
});
