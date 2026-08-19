import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReviewerPicker from './ReviewerPicker';
import { typeSettled } from '../../test/settledInput';

describe('ReviewerPicker', () => {
  it('renders the selected reviewers in order with numbered badges', () => {
    render(<ReviewerPicker reviewers={['codex', 'antigravity', 'copilot']} onChange={() => {}} />);
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('2.')).toBeInTheDocument();
    expect(screen.getByText('3.')).toBeInTheDocument();
    // The not-yet-selected reviewer (claude) shows in the Add row.
    expect(screen.getByRole('button', { name: /Claude/ })).toBeInTheDocument();
  });

  describe('installed badge (#3606)', () => {
    it('flags a selected reviewer whose CLI probe came back false', () => {
      render(<ReviewerPicker reviewers={['antigravity']} installed={{ antigravity: false }} onChange={() => {}} />);
      expect(screen.getByText('not installed')).toBeInTheDocument();
    });

    it('does not flag a selected reviewer with no probe entry (not a CLI reviewer, or not fetched)', () => {
      render(<ReviewerPicker reviewers={['copilot']} installed={{ antigravity: false }} onChange={() => {}} />);
      // copilot has no `installed` entry (it's not a CLI reviewer) — its row
      // stays unbadged even though the map has an entry for a different reviewer.
      expect(screen.getByText('Copilot').closest('div')).not.toHaveTextContent('not installed');
    });

    it('does not flag anything when installed is absent', () => {
      render(<ReviewerPicker reviewers={['codex', 'antigravity']} onChange={() => {}} />);
      expect(screen.queryByText('not installed')).not.toBeInTheDocument();
    });

    it('flags an unselected reviewer in the Add row too', () => {
      render(<ReviewerPicker reviewers={['copilot']} installed={{ antigravity: false }} onChange={() => {}} />);
      const addButton = screen.getByRole('button', { name: /Antigravity/ });
      expect(addButton).toHaveTextContent('not installed');
    });
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
    await typeSettled(user, screen.getByLabelText('Add a GitHub reviewer username'), '@CodeReviewbot');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: ['CodeReviewbot'] }));
  });

  it('adds a username on Enter', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    // Enter is pressed separately so the draft can be pinned first: the keydown
    // handler adds whatever `usernameInput` state holds at that moment.
    await typeSettled(user, screen.getByLabelText('Add a GitHub reviewer username'), 'reviewer-bot');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ usernames: ['reviewer-bot'] }));
  });

  it('rejects an invalid username and surfaces an error without emitting', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ReviewerPicker reviewers={['copilot']} onChange={onChange} />);
    // Same pin: a partially-typed `bad` is a *valid* username, so an Enter that
    // beat the last keystrokes would emit and make this assertion lie.
    await typeSettled(user, screen.getByLabelText('Add a GitHub reviewer username'), 'bad token!');
    await user.keyboard('{Enter}');
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

    it('rejects a negative cap rather than clamping it to 0 (which would mean unlimited)', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['ollama']} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Max review rounds for Ollama'), { target: { value: '-2' } });
      // Clamping to 0 would silently turn a typo into slashdo's "loop until clean".
      expect(onChange).not.toHaveBeenCalled();
    });

    it('rejects a fractional cap rather than truncating it', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['ollama']} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Max review rounds for Ollama'), { target: { value: '1.5' } });
      expect(onChange).not.toHaveBeenCalled();
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

  describe('per-reviewer Model column', () => {
    // Shape mirrors useReviewerModelOptions()' return — the caller owns the fetch.
    const modelOptions = {
      optionsByReviewer: {
        ollama: ['qwen2.5-coder:32b', 'codellama'],
        lmstudio: ['local-model-a'],
        codex: ['gpt-tier-a', 'gpt-tier-b'],
        claude: ['claude-tier-a', 'qwen2.5-coder:32b'],
      },
      freeText: { codex: true, claude: true, lmstudio: false, ollama: false },
      unavailable: { lmstudio: false, ollama: false },
      loaded: true,
    };

    it('renders a Model control for each model-taking reviewer', () => {
      render(<ReviewerPicker reviewers={['ollama', 'codex', 'copilot']} modelOptions={modelOptions} onChange={() => {}} />);
      expect(screen.getByLabelText('Model for Ollama')).toBeInTheDocument();
      expect(screen.getByLabelText('Model for Codex')).toBeInTheDocument();
      // Copilot has no CLI and takes no model — no control, just the em dash.
      expect(screen.queryByLabelText('Model for Copilot')).not.toBeInTheDocument();
    });

    it('does not render a Model control for a @username reviewer', () => {
      render(<ReviewerPicker reviewers={['copilot']} usernames={['flaky-bot']} modelOptions={modelOptions} onChange={() => {}} />);
      expect(screen.queryByLabelText('Model for @flaky-bot')).not.toBeInTheDocument();
    });

    it('renders a local backend as a closed select of its installed ids', () => {
      render(<ReviewerPicker reviewers={['ollama']} modelOptions={modelOptions} onChange={() => {}} />);
      const select = screen.getByLabelText('Model for Ollama');
      expect(select.tagName).toBe('SELECT');
      expect(screen.getByRole('option', { name: 'qwen2.5-coder:32b' })).toBeInTheDocument();
    });

    it('renders a CLI reviewer as a free-text input so an env-specific id can be typed', () => {
      render(<ReviewerPicker reviewers={['claude']} modelOptions={modelOptions} onChange={() => {}} />);
      // An Ollama-backed / Bedrock-form claude id can't be enumerated, so the
      // control must accept a typed value rather than only a pick.
      expect(screen.getByLabelText('Model for Claude').tagName).toBe('INPUT');
    });

    it('falls back to free-text when no options resolved (a closed empty select would be dead)', () => {
      render(<ReviewerPicker reviewers={['ollama']} onChange={() => {}} />);
      expect(screen.getByLabelText('Model for Ollama').tagName).toBe('INPUT');
    });

    it('shows an existing pin', () => {
      render(<ReviewerPicker reviewers={['ollama']} reviewerModels={{ ollama: 'codellama' }} modelOptions={modelOptions} onChange={() => {}} />);
      expect(screen.getByLabelText('Model for Ollama')).toHaveValue('codellama');
    });

    it('keeps an option for a pin the probe no longer lists', () => {
      render(<ReviewerPicker reviewers={['ollama']} reviewerModels={{ ollama: 'uninstalled-model' }} modelOptions={modelOptions} onChange={() => {}} />);
      // Without the synthesized option the select would render blank and read as
      // "unset" while the value is in fact stored.
      expect(screen.getByLabelText('Model for Ollama')).toHaveValue('uninstalled-model');
      expect(screen.getByRole('option', { name: /uninstalled-model \(not installed\)/ })).toBeInTheDocument();
    });

    it('pins a model for a local reviewer', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['ollama']} modelOptions={modelOptions} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Model for Ollama'), { target: { value: 'codellama' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: { ollama: 'codellama' } }));
    });

    it('pins a typed model for a CLI reviewer', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['codex']} modelOptions={modelOptions} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Model for Codex'), { target: { value: 'gpt-tier-b' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: { codex: 'gpt-tier-b' } }));
    });

    it('clearing the field DELETES the pin rather than writing an empty id', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['codex']} reviewerModels={{ codex: 'gpt-tier-a' }} modelOptions={modelOptions} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Model for Codex'), { target: { value: '' } });
      // `''` would emit a `--model ` with no id; absent means "its own default".
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: {} }));
    });

    it('treats a whitespace-only entry as a clear, not a pin', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['codex']} reviewerModels={{ codex: 'gpt-tier-a' }} modelOptions={modelOptions} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Model for Codex'), { target: { value: '   ' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: {} }));
    });

    it('prunes the pin when its reviewer is removed', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(<ReviewerPicker reviewers={['codex', 'ollama']} reviewerModels={{ ollama: 'codellama' }} modelOptions={modelOptions} onChange={onChange} />);
      await user.click(screen.getByLabelText('Remove Ollama'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['codex'], reviewerModels: {} }));
    });

    it('keeps the model pin, the ~opt toggle, and the cap independent', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();
      render(
        <ReviewerPicker
          reviewers={['ollama']}
          reviewerModels={{ ollama: 'codellama' }}
          reviewerMaxRounds={{ ollama: 1 }}
          modelOptions={modelOptions}
          onChange={onChange}
        />
      );
      await user.click(screen.getByLabelText('Make Ollama non-blocking'));
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        optionalReviewers: ['ollama'],
        reviewerMaxRounds: { ollama: 1 },
        reviewerModels: { ollama: 'codellama' }
      }));
    });

    it('preserves an untouched pin when another row changes', () => {
      const onChange = vi.fn();
      render(
        <ReviewerPicker
          reviewers={['codex', 'ollama']}
          reviewerModels={{ codex: 'gpt-tier-a' }}
          modelOptions={modelOptions}
          onChange={onChange}
        />
      );
      fireEvent.change(screen.getByLabelText('Model for Ollama'), { target: { value: 'codellama' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        reviewerModels: { codex: 'gpt-tier-a', ollama: 'codellama' }
      }));
    });

    it('reads a pin case-insensitively (legacy/hand-edited key casing)', () => {
      render(<ReviewerPicker reviewers={['codex']} reviewerModels={{ Codex: 'gpt-tier-a' }} modelOptions={modelOptions} onChange={() => {}} />);
      expect(screen.getByLabelText('Model for Codex')).toHaveValue('gpt-tier-a');
    });

    it('strips characters that would corrupt the emitted [model] selector', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['codex']} modelOptions={modelOptions} onChange={onChange} />);
      // `foo]~opt` would close the selector early and leave slashdo reading the
      // rest as a suffix; the server drops such an id, so accepting it here would
      // show a pin that never persists.
      fireEvent.change(screen.getByLabelText('Model for Codex'), { target: { value: 'foo]~opt' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: { codex: 'foo~opt' } }));
    });

    it('keeps a space in a typed id (slashdo selectors are free-form)', () => {
      const onChange = vi.fn();
      render(<ReviewerPicker reviewers={['claude']} modelOptions={modelOptions} onChange={onChange} />);
      fireEvent.change(screen.getByLabelText('Model for Claude'), { target: { value: 'Some Model (High)' } });
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerModels: { claude: 'Some Model (High)' } }));
    });
  });
  describe('Effort column', () => {
      it('offers each reviewer only the tiers its own CLI accepts', () => {
        render(<ReviewerPicker reviewers={['antigravity']} onChange={() => {}} />);
        const select = screen.getByLabelText('Reasoning effort for Antigravity');
        expect(select.tagName).toBe('SELECT');
        expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument();
        // agy rejects `--effort max`, so the picker must not offer it.
        expect(screen.queryByRole('option', { name: 'max' })).not.toBeInTheDocument();
      });

      it('offers the wider claude ladder on a claude row', () => {
        render(<ReviewerPicker reviewers={['claude']} onChange={() => {}} />);
        expect(screen.getByRole('option', { name: 'xhigh' })).toBeInTheDocument();
      });

      it('tells a cursor row its tier needs a Model pin to reach the CLI', () => {
        // cursor-agent has no --effort flag: the level rides inside the model id,
        // so a tier with no model is dropped when the invocation is built.
        const { rerender } = render(<ReviewerPicker reviewers={['cursor']} reviewerEfforts={{ cursor: 'max' }} onChange={() => {}} />);
        expect(screen.getByLabelText('Reasoning effort for Cursor Agent'))
          .toHaveAttribute('title', expect.stringContaining('pin a Model too'));
        rerender(<ReviewerPicker reviewers={['cursor']} reviewerEfforts={{ cursor: 'max' }} reviewerModels={{ cursor: 'gpt-5' }} onChange={() => {}} />);
        expect(screen.getByLabelText('Reasoning effort for Cursor Agent'))
          .not.toHaveAttribute('title', expect.stringContaining('pin a Model too'));
      });

      it('renders no Effort control for a reviewer with no effort knob', () => {
        render(<ReviewerPicker reviewers={['copilot', 'grok']} usernames={['flaky-bot']} onChange={() => {}} />);
        expect(screen.queryByLabelText('Reasoning effort for Copilot')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Reasoning effort for Grok')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Reasoning effort for @flaky-bot')).not.toBeInTheDocument();
      });

      it('shows an existing pin and emits a picked tier', () => {
        const onChange = vi.fn();
        render(<ReviewerPicker reviewers={['codex']} reviewerEfforts={{ codex: 'low' }} onChange={onChange} />);
        const select = screen.getByLabelText('Reasoning effort for Codex');
        expect(select).toHaveValue('low');
        fireEvent.change(select, { target: { value: 'high' } });
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerEfforts: { codex: 'high' } }));
      });

      it('clearing DELETES the key rather than writing an empty string', () => {
        const onChange = vi.fn();
        render(<ReviewerPicker reviewers={['codex']} reviewerEfforts={{ codex: 'high' }} onChange={onChange} />);
        fireEvent.change(screen.getByLabelText('Reasoning effort for Codex'), { target: { value: '' } });
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerEfforts: {} }));
      });

      it('keeps a stored tier the ladder no longer lists visible instead of reading as unset', () => {
        render(<ReviewerPicker reviewers={['antigravity']} reviewerEfforts={{ antigravity: 'max' }} onChange={() => {}} />);
        const select = screen.getByLabelText('Reasoning effort for Antigravity');
        expect(select).toHaveValue('max');
        expect(screen.getByRole('option', { name: 'max (unsupported)' })).toBeInTheDocument();
      });

      it('prunes the effort pin when its reviewer is removed', () => {
        const onChange = vi.fn();
        render(<ReviewerPicker reviewers={['codex', 'ollama']} reviewerEfforts={{ ollama: 'high' }} onChange={onChange} />);
        fireEvent.click(screen.getByLabelText('Remove Ollama'));
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['codex'], reviewerEfforts: {} }));
      });

      it('reads a pin case-insensitively, like the sibling maps', () => {
        render(<ReviewerPicker reviewers={['codex']} reviewerEfforts={{ Codex: 'high' }} onChange={() => {}} />);
        expect(screen.getByLabelText('Reasoning effort for Codex')).toHaveValue('high');
      });

      // #3733: agy validates the model/effort PAIR, so the ladder narrows by the
      // row's pinned model. `modelEffortLevels` is the caller's accessor (see
      // useReviewerModelOptions) — stubbed here the way the real hook behaves.
      describe('narrowed by the pinned model', () => {
        const tiersByModel = {
          'gemini-3.1-pro': ['high'],
          'gemini-3.6-flash': ['low', 'high'],
          'claude-sonnet-4-6': [],
        };
        const narrowing = {
          optionsByReviewer: { antigravity: Object.keys(tiersByModel) },
          freeText: { antigravity: true },
          unavailable: {},
          loaded: true,
          modelEffortLevels: (reviewer, model) => (reviewer === 'antigravity'
            ? (tiersByModel[model] ?? ['low', 'medium', 'high'])
            : ['low', 'medium', 'high'])
        };

        it('offers only the tiers the pinned model actually has', () => {
          render(<ReviewerPicker reviewers={['antigravity']} reviewerModels={{ antigravity: 'gemini-3.1-pro' }} modelOptions={narrowing} onChange={() => {}} />);
          expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument();
          // The pair agy rejects — the whole point of the narrowing.
          expect(screen.queryByRole('option', { name: 'medium' })).not.toBeInTheDocument();
        });

        it('keeps the full ladder when no model is pinned', () => {
          render(<ReviewerPicker reviewers={['antigravity']} modelOptions={narrowing} onChange={() => {}} />);
          expect(screen.getByRole('option', { name: 'medium' })).toBeInTheDocument();
        });

        it('falls back to the static ladder when the caller passes no modelOptions', () => {
          render(<ReviewerPicker reviewers={['antigravity']} reviewerModels={{ antigravity: 'gemini-3.1-pro' }} onChange={() => {}} />);
          expect(screen.getByRole('option', { name: 'medium' })).toBeInTheDocument();
        });

        it('drops the Effort control for a pinned model with no tiers at all', () => {
          render(<ReviewerPicker reviewers={['antigravity']} reviewerModels={{ antigravity: 'claude-sonnet-4-6' }} modelOptions={narrowing} onChange={() => {}} />);
          expect(screen.queryByLabelText('Reasoning effort for Antigravity')).not.toBeInTheDocument();
        });

        it('still renders a STORED pin under a tier-less model so it stays clearable', () => {
          const onChange = vi.fn();
          render(<ReviewerPicker reviewers={['antigravity']} reviewerModels={{ antigravity: 'claude-sonnet-4-6' }} reviewerEfforts={{ antigravity: 'high' }} modelOptions={narrowing} onChange={onChange} />);
          const select = screen.getByLabelText('Reasoning effort for Antigravity');
          expect(select).toHaveValue('high');
          fireEvent.change(select, { target: { value: '' } });
          expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewerEfforts: {} }));
        });

        it('keeps a stored tier the pinned model dropped visible as unsupported', () => {
          render(<ReviewerPicker reviewers={['antigravity']} reviewerModels={{ antigravity: 'gemini-3.1-pro' }} reviewerEfforts={{ antigravity: 'medium' }} modelOptions={narrowing} onChange={() => {}} />);
          expect(screen.getByLabelText('Reasoning effort for Antigravity')).toHaveValue('medium');
          expect(screen.getByRole('option', { name: 'medium (unsupported)' })).toBeInTheDocument();
        });
      });
    });
});
