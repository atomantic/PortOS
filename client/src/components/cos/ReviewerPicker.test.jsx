import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewerPicker from './ReviewerPicker';

describe('ReviewerPicker', () => {
  it('renders the selected reviewers in order with numbered badges', () => {
    render(<ReviewerPicker reviewers={['codex', 'antigravity', 'copilot']} onChange={() => {}} />);
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
    render(<ReviewerPicker reviewers={['codex', 'codex', 'antigravity']} onChange={() => {}} />);
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
    render(<ReviewerPicker reviewers={['codex', 'antigravity', 'copilot']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Move Antigravity earlier'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['antigravity', 'codex', 'copilot'] }));
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
    rerender(<ReviewerPicker reviewers={['codex', 'antigravity']} onChange={() => {}} />);
    expect(screen.getByText('Stop mode:')).toBeInTheDocument();
  });

  it('normalizes legacy Gemini reviewer values to Antigravity', () => {
    render(<ReviewerPicker reviewers={['gemini']} onChange={() => {}} />);
    expect(screen.getByText('Antigravity')).toBeInTheDocument();
  });

  it('shows the reviewer-applies toggle only when a non-copilot reviewer is present', () => {
    const { rerender } = render(<ReviewerPicker reviewers={['copilot']} onChange={() => {}} />);
    expect(screen.queryByText(/Reviewer applies fixes/)).not.toBeInTheDocument();
    rerender(<ReviewerPicker reviewers={['codex']} onChange={() => {}} />);
    expect(screen.getByText(/Reviewer applies fixes/)).toBeInTheDocument();
  });

  it('adds a GitHub reviewer username (strips @) via the Add button', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    await user.type(screen.getByLabelText('Add a GitHub reviewer username'), '@CodeReviewbot');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: ['CodeReviewbot'] }));
  });

  it('adds a username on Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    await user.type(screen.getByLabelText('Add a GitHub reviewer username'), 'reviewer-bot{Enter}');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: ['reviewer-bot'] }));
  });

  it('rejects an invalid username and surfaces an error without emitting', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    await user.type(screen.getByLabelText('Add a GitHub reviewer username'), 'bad token!{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/valid GitHub username/)).toBeInTheDocument();
  });

  it('renders existing username pills and removes one', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} usernames={['CodeReviewbot', 'other-bot']} onChange={onChange} />);
    expect(screen.getByText('CodeReviewbot')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Remove @CodeReviewbot'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: ['other-bot'] }));
  });

  it('toggles a keyed reviewer non-blocking (adds its slug to optionalReviewers)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['codex', 'ollama']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Make Ollama non-blocking'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ optionalReviewers: ['ollama'] }));
  });

  it('toggles a non-blocking reviewer back to blocking (removes it)', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['codex', 'ollama']} optionalReviewers={['ollama']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Make Ollama blocking'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ optionalReviewers: [] }));
  });

  it('marks a GitHub reviewer username non-blocking with the @-form token', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} usernames={['flaky-bot']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Make @flaky-bot non-blocking'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ optionalReviewers: ['@flaky-bot'] }));
  });

  it('prunes the optional token when its reviewer is removed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['codex', 'ollama']} optionalReviewers={['ollama']} onChange={onChange} />);
    await user.click(screen.getByLabelText('Remove Ollama'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['codex'], optionalReviewers: [] }));
  });
});
