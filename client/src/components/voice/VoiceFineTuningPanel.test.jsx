import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VoiceFineTuningPanel from './VoiceFineTuningPanel';

const mocks = vi.hoisted(() => ({
  handlers: new Map(), list: vi.fn(), start: vi.fn(), cancel: vi.fn(), promote: vi.fn(),
}));
vi.mock('../../services/socket', () => ({ default: {
  on: (event, callback) => { if (!mocks.handlers.has(event)) mocks.handlers.set(event, new Set()); mocks.handlers.get(event).add(callback); },
  off: (event, callback) => mocks.handlers.get(event)?.delete(callback),
} }));
vi.mock('../../services/apiVoice', () => ({
  listFineTuningJobs: (...args) => mocks.list(...args),
  startFineTuningJob: (...args) => mocks.start(...args),
  cancelFineTuningJob: (...args) => mocks.cancel(...args),
  promoteFineTunedCheckpoint: (...args) => mocks.promote(...args),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

const emit = (event, data) => act(() => { mocks.handlers.get(event)?.forEach((callback) => callback(data)); });

const PROFILE_ID = 'voice-profile-1';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const REVISION = `Qwen/Base@${'a'.repeat(40)}+sha256.${'b'.repeat(64)}`;
const job = (overrides = {}) => ({
  id: JOB_ID, profileId: PROFILE_ID, status: 'running', progress: 10, step: 10, totalSteps: 100,
  startedAt: '2026-01-01T00:00:00.000Z', checkpoints: [], error: null, ...overrides,
});
const checkpoint = (step, overrides = {}) => ({
  id: `checkpoint-step-${step}`, step, loss: 0.5, modelRevision: REVISION,
  auditionUrl: `/data/voice-profiles/${PROFILE_ID}/fine-tune/${JOB_ID}/checkpoint-step-${step}/audition.wav`,
  promotable: true, promotionBlockedReason: null, ...overrides,
});
const frame = (overrides) => ({ profileId: PROFILE_ID, job: job(overrides) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.list.mockResolvedValue({ jobs: [] });
});

describe('VoiceFineTuningPanel', () => {
  it('recovers the newest run on mount and applies pushed frames without refetching', async () => {
    mocks.list.mockResolvedValue({ jobs: [job()] });
    render(<VoiceFineTuningPanel profileId={PROFILE_ID} />);
    expect(await screen.findByText('running')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith(PROFILE_ID, expect.objectContaining({ silent: true }));
    // A run in progress blocks a second one on the same voice.
    expect(screen.getByRole('button', { name: /Start Fine-Tuning Job/ })).toBeDisabled();

    emit('voice:fine-tune:updated', { profileId: 'other-profile', job: job({ id: 'x', checkpoints: [checkpoint(5)] }) });
    emit('voice:fine-tune:updated', frame({ step: 20, progress: 20, checkpoints: [checkpoint(20)] }));
    const audio = await screen.findByLabelText('Audition for Step 20');
    expect(audio.getAttribute('src')).toBe(checkpoint(20).auditionUrl);
    expect(screen.queryByLabelText('Audition for Step 5')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');

    emit('voice:fine-tune:updated', frame({ status: 'completed', progress: 100, checkpoints: [checkpoint(20)] }));
    expect(await screen.findByText('completed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('starts a run, then cancels it and shows cancelled from the response', async () => {
    render(<VoiceFineTuningPanel profileId={PROFILE_ID} />);
    expect(await screen.findByText(/No fine-tuning runs/)).toBeTruthy();
    mocks.start.mockResolvedValue({ jobId: JOB_ID, status: 'running', job: job({ step: 0, progress: 0 }) });
    fireEvent.change(screen.getByLabelText('Epochs'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: /Start Fine-Tuning Job/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledWith(PROFILE_ID, { epochs: 8 }, { silent: true }));
    expect(await screen.findByText('running')).toBeTruthy();

    mocks.cancel.mockResolvedValue({ ok: true, jobId: JOB_ID, status: 'cancelled', job: job({ status: 'cancelled', error: 'Cancelled by user' }) });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(await screen.findByText('cancelled')).toBeTruthy();
    expect(mocks.cancel).toHaveBeenCalledWith(PROFILE_ID, JOB_ID, { silent: true });
    expect(screen.getByText('Cancelled by user')).toBeTruthy();
  });

  it('promotes a verified checkpoint, refreshes profiles, and keeps an unverified one blocked with its reason', async () => {
    const unverified = checkpoint(10, {
      id: 'checkpoint-10.safetensors', modelRevision: undefined, auditionUrl: null,
      promotable: false, promotionBlockedReason: 'Checkpoint was not produced by a supported training adapter',
    });
    mocks.list.mockResolvedValue({ jobs: [job({ status: 'completed', checkpoints: [unverified, checkpoint(20)] })] });
    const onPromoted = vi.fn();
    const { rerender } = render(<VoiceFineTuningPanel profileId={PROFILE_ID} onPromoted={onPromoted} />);

    const blocked = await screen.findByRole('button', { name: 'Promote Step 10' });
    expect(blocked).toBeDisabled();
    expect(within(blocked.closest('li')).getByRole('note').textContent).toMatch(/supported training adapter/);

    const promotedProfile = { id: PROFILE_ID, kind: 'fine-tuned', modelRevision: REVISION, approval: { status: 'approved' } };
    mocks.promote.mockResolvedValue({ profile: promotedProfile });
    fireEvent.click(screen.getByRole('button', { name: 'Promote Step 20' }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalledWith(promotedProfile));
    expect(mocks.promote).toHaveBeenCalledWith(PROFILE_ID, JOB_ID, 'checkpoint-step-20', { silent: true });

    rerender(<VoiceFineTuningPanel profileId={PROFILE_ID} onPromoted={onPromoted} activeModelRevision={REVISION} />);
    expect(screen.getByText('Active voice')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Promote Step 20' })).toBeNull();
  });

  it('shows the server refusal beside the checkpoint it refused', async () => {
    mocks.list.mockResolvedValue({ jobs: [job({ status: 'interrupted', error: 'Training stopped when the server restarted', checkpoints: [checkpoint(20)] })] });
    render(<VoiceFineTuningPanel profileId={PROFILE_ID} />);
    const button = await screen.findByRole('button', { name: 'Promote Step 20' });
    expect(screen.getByText(/server restarted/)).toBeTruthy();
    const refusal = Object.assign(new Error('Checkpoint was not produced by a supported training adapter'), { status: 409 });
    mocks.promote.mockRejectedValue(refusal);
    fireEvent.click(button);
    await waitFor(() => expect(within(button.closest('li')).getByRole('note').textContent).toMatch(/supported training adapter/));
  });
});
