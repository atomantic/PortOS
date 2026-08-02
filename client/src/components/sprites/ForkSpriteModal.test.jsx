/**
 * Fork a character from its locked reference (#sprite-i2i).
 *
 * The modal is a thin form, so what only IT can get wrong is the wire body it
 * hands `forkSpriteRecord` — and that body is invisible to the server suite,
 * which validates `spriteForkSchema` against a hand-built object. So the
 * central assertion here is the EXACT payload (keys included, keys omitted,
 * values trimmed), not merely that the call happened — and `server/routes/
 * sprites.test.js` feeds those same two bodies through the real
 * `spriteForkSchema`, so a drift between the two shows up on one side or the
 * other instead of hiding behind two green suites.
 *
 * Also covered: the `canSubmit` gate (an un-gated empty name/prompt is a
 * guaranteed 400), and the success/error branches — the fork's whole payoff is
 * navigating to the new record, so a swallowed `onForked` strands the user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const forkSpriteRecord = vi.fn();

vi.mock('../../services/apiSprites.js', () => ({
  forkSpriteRecord: (...args) => forkSpriteRecord(...args),
  // SpritePreview → SpriteLightbox → AssetPromptSection pulls this in; the
  // preview here is not zoomable, so it is never called.
  getSpriteAssetPrompt: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import ForkSpriteModal from './ForkSpriteModal.jsx';
import toast from '../ui/Toast';

const SOURCE = { id: 'example-pioneer', name: 'Example Pioneer' };
const BACKENDS = [{ id: 'codex', label: 'Codex' }, { id: 'grok', label: 'Grok' }];

const renderModal = (props = {}) => render(
  <ForkSpriteModal
    open
    onClose={vi.fn()}
    source={SOURCE}
    referencePath="reference/example-pioneer-main-v1.png"
    backends={BACKENDS}
    mode="codex"
    onForked={vi.fn()}
    {...props}
  />,
);

const forkButton = () => screen.getByRole('button', { name: /Fork & generate/ });
const promptBox = () => screen.getByLabelText('Prompt — describe the change');
const nameBox = () => screen.getByLabelText('New name');
const idBox = () => screen.getByLabelText(/^Id/);

beforeEach(() => {
  vi.clearAllMocks();
  forkSpriteRecord.mockResolvedValue({ record: { id: 'example-pioneer-fork', name: 'Example Pioneer fork' } });
});

describe('ForkSpriteModal submit gating', () => {
  it('seeds the name from the source and stays disabled until a prompt is written', async () => {
    renderModal();
    expect(nameBox()).toHaveValue('Example Pioneer fork');
    expect(forkButton()).toBeDisabled();

    await userEvent.type(promptBox(), 'now with a red coat');
    expect(forkButton()).toBeEnabled();
  });

  it('disables on a name that is only whitespace', async () => {
    renderModal();
    await userEvent.type(promptBox(), 'now with a red coat');
    await userEvent.clear(nameBox());
    await userEvent.type(nameBox(), '   ');
    expect(forkButton()).toBeDisabled();
  });

  it('disables on a prompt that is only whitespace', async () => {
    renderModal();
    await userEvent.type(promptBox(), '   ');
    expect(forkButton()).toBeDisabled();
  });

  it('requires a backend pick while backends exist, and backfills a late-arriving mode', async () => {
    // `mode` can resolve after mount (the settings fetch lands later), which is
    // the only reason the gate can start unsatisfied with backends present.
    const { rerender } = render(
      <ForkSpriteModal
        open onClose={vi.fn()} source={SOURCE} backends={BACKENDS} mode="" onForked={vi.fn()}
      />,
    );
    await userEvent.type(promptBox(), 'now with a red coat');
    expect(forkButton()).toBeDisabled();

    rerender(
      <ForkSpriteModal
        open onClose={vi.fn()} source={SOURCE} backends={BACKENDS} mode="grok" onForked={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('grok');
    expect(forkButton()).toBeEnabled();
  });

  it('keeps an explicit backend pick when a mode prop arrives afterwards', async () => {
    const { rerender } = render(
      <ForkSpriteModal
        open onClose={vi.fn()} source={SOURCE} backends={BACKENDS} mode="" onForked={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), 'grok');
    rerender(
      <ForkSpriteModal
        open onClose={vi.fn()} source={SOURCE} backends={BACKENDS} mode="codex" onForked={vi.fn()}
      />,
    );
    expect(screen.getByRole('combobox')).toHaveValue('grok');
  });

  it('drops the backend requirement (and warns) when no backend is configured', async () => {
    renderModal({ backends: [], mode: '' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/No image backend configured/)).toBeInTheDocument();

    await userEvent.type(promptBox(), 'now with a red coat');
    expect(forkButton()).toBeEnabled();
  });
});

describe('ForkSpriteModal wire body', () => {
  it('sends the trimmed full body with the default fidelity', async () => {
    renderModal();
    await userEvent.clear(nameBox());
    await userEvent.type(nameBox(), '  Example Settler  ');
    await userEvent.type(idBox(), '  example-settler  ');
    await userEvent.type(promptBox(), '  wearing a wide-brim hat  ');
    await userEvent.selectOptions(screen.getByRole('combobox'), 'grok');
    await userEvent.click(forkButton());

    expect(forkSpriteRecord).toHaveBeenCalledTimes(1);
    expect(forkSpriteRecord).toHaveBeenCalledWith('example-pioneer', {
      name: 'Example Settler',
      id: 'example-settler',
      designPrompt: 'wearing a wide-brim hat',
      mode: 'grok',
      initImageStrength: 0.65,
    }, { silent: true });
  });

  it('omits id and mode entirely rather than sending empty strings', async () => {
    renderModal({ backends: [], mode: '' });
    await userEvent.type(promptBox(), 'now with a red coat');
    await userEvent.click(forkButton());

    const [, body] = forkSpriteRecord.mock.calls[0];
    expect(Object.keys(body).sort()).toEqual(['designPrompt', 'initImageStrength', 'name']);
  });

  it('sends the fidelity slider value as a number', async () => {
    renderModal();
    await userEvent.type(promptBox(), 'now with a red coat');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.4' } });
    expect(screen.getByText('0.40')).toBeInTheDocument();

    await userEvent.click(forkButton());
    expect(forkSpriteRecord.mock.calls[0][1].initImageStrength).toBe(0.4);
  });
});

describe('ForkSpriteModal outcomes', () => {
  it('hands the new record back and closes on success', async () => {
    const onForked = vi.fn();
    const onClose = vi.fn();
    renderModal({ onForked, onClose });
    await userEvent.type(promptBox(), 'now with a red coat');
    await userEvent.click(forkButton());

    expect(toast.success).toHaveBeenCalledWith(
      'Forked Example Pioneer → Example Pioneer fork — main render queued',
    );
    expect(onForked).toHaveBeenCalledWith({ id: 'example-pioneer-fork', name: 'Example Pioneer fork' });
    expect(onClose).toHaveBeenCalled();
  });

  it('names the turnaround as the seed when the source has a locked sheet', async () => {
    renderModal({ fromTurnaround: true });
    await userEvent.type(promptBox(), 'now with a red coat');
    await userEvent.click(forkButton());
    expect(toast.success).toHaveBeenCalledWith(
      'Forked Example Pioneer → Example Pioneer fork — turnaround render queued',
    );
  });

  it('surfaces the server message and keeps the modal open on failure', async () => {
    forkSpriteRecord.mockRejectedValue(new Error('id already exists'));
    const onForked = vi.fn();
    const onClose = vi.fn();
    renderModal({ onForked, onClose });
    await userEvent.type(promptBox(), 'now with a red coat');
    await userEvent.click(forkButton());

    expect(toast.error).toHaveBeenCalledWith('id already exists');
    expect(toast.success).not.toHaveBeenCalled();
    expect(onForked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
