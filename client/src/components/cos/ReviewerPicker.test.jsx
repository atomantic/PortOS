import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  describe('~max round caps', () => {
    it('renders a blank cap input per reviewer/username chip when no cap is set', () => {
      render(<ReviewerPicker reviewers={['codex', 'ollama']} usernames={['flaky-bot']} onChange={() => {}} />);
      expect(screen.getByLabelText('Max review rounds for Codex')).toHaveValue(null);
      expect(screen.getByLabelText('Max review rounds for Ollama')).toHaveValue(null);
      expect(screen.getByLabelText('Max review rounds for @flaky-bot')).toHaveValue(null);
    });

    it('shows an existing cap, including an explicit 0', () => {
      render(<ReviewerPicker reviewers={['codex', 'ollama']} reviewerMaxRounds={{ ollama: 0, codex: 2 }} onChange={() => {}} />);
      // 0 is a real value (loop until clean) and must render as 0, not blank.
      expect(screen.getByLabelText('Max review rounds for Ollama')).toHaveValue(0);
      expect(screen.getByLabelText('Max review rounds for Codex')).toHaveValue(2);
    });

    it('sets a cap for a keyed reviewer', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['codex', 'ollama']} onChange={onChange} />);
      await user.type(screen.getByLabelText('Max review rounds for Ollama'), '1');
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerMaxRounds: { ollama: 1 } }));
    });

    it('sets a cap for a @username reviewer keyed by its @-form token', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['copilot']} usernames={['flaky-bot']} onChange={onChange} />);
      await user.type(screen.getByLabelText('Max review rounds for @flaky-bot'), '3');
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerMaxRounds: { '@flaky-bot': 3 } }));
    });

    it('clearing the input DELETES the entry rather than writing 0 (absent ≠ 0)', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['codex', 'ollama']} reviewerMaxRounds={{ ollama: 2 }} onChange={onChange} />);
      await user.clear(screen.getByLabelText('Max review rounds for Ollama'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerMaxRounds: {} }));
    });

    it('clamps a cap above the ceiling instead of sending a value the server would drop', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['ollama']} onChange={onChange} />);
      // fireEvent (not user.type) so the whole out-of-range value lands in one
      // change event — a controlled input never accumulates keystrokes.
      fireEvent.change(screen.getByLabelText('Max review rounds for Ollama'), { target: { value: '99' } });
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reviewerMaxRounds: { ollama: 10 } }));
    });

    it('clamps a negative cap to 0 rather than dropping the entry silently', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['ollama']} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Max review rounds for Ollama'), { target: { value: '-2' } });
      expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reviewerMaxRounds: { ollama: 0 } }));
    });

    it('prunes the cap entry when its reviewer is removed', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['codex', 'ollama']} reviewerMaxRounds={{ ollama: 1 }} onChange={onChange} />);
      await user.click(screen.getByLabelText('Remove Ollama'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['codex'], reviewerMaxRounds: {} }));
    });

    it('prunes the cap entry when its username reviewer is removed', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['copilot']} usernames={['flaky-bot']} reviewerMaxRounds={{ '@flaky-bot': 2 }} onChange={onChange} />);
      await user.click(screen.getByLabelText('Remove @flaky-bot'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: [], reviewerMaxRounds: {} }));
    });

    it('keeps the ~opt toggle and the cap independent', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['ollama']} reviewerMaxRounds={{ ollama: 1 }} onChange={onChange} />);
      await user.click(screen.getByLabelText('Make Ollama non-blocking'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        optionalReviewers: ['ollama'],
        reviewerMaxRounds: { ollama: 1 }
      }));
    });
  });
});
