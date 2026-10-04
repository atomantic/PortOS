import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';

vi.mock('../../../services/api', () => ({
  getBrainInbox: vi.fn(),
  captureBrainThought: vi.fn(),
  resolveBrainReview: vi.fn(),
  fixBrainClassification: vi.fn(),
  retryBrainClassification: vi.fn(),
  updateBrainInboxEntry: vi.fn(),
  deleteBrainInboxEntry: vi.fn(),
  markBrainInboxDone: vi.fn(),
}));

vi.mock('../../../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../../hooks', () => ({
  useLocalStorageBool: () => [false, vi.fn()],
  useRepoIntake: () => ({
    repo: null,
    options: { malwareScan: false, learn: false },
    managedApps: [],
    targetAppId: 'portos-default',
    setTargetAppId: vi.fn(),
    studyContext: '',
    setStudyContext: vi.fn(),
    providerOverride: { providerId: '', model: '', effort: '' },
    providers: [],
    activeProviderId: '',
    setProviderOverride: vi.fn(),
    toggle: vi.fn(),
    intakeFor: vi.fn(() => undefined),
  }),
}));

vi.mock('../../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('../VoiceCapture', () => ({ default: () => null }));
vi.mock('../RepoIntakeOptions', () => ({ default: () => null }));

import { captureBrainThought, getBrainInbox } from '../../../services/api';
import InboxTab from './InboxTab';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state || {})}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getBrainInbox.mockResolvedValue({ entries: [], counts: {} });
  captureBrainThought.mockResolvedValue({
    inboxLog: {
      id: 'inbox-url-1',
      capturedText: 'https://example.com',
      status: 'filed',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
    link: { id: 'link-1' },
    message: 'Saved to Links!',
  });
});

describe('Brain inbox capture', () => {
  it.each([false, true])('keeps an early capture when deferred history includes it: %s', async (historyIncludesCapture) => {
    let resolveHistory;
    const history = new Promise(resolve => { resolveHistory = resolve; });
    getBrainInbox.mockReturnValue(history);
    const accepted = {
      id: 'example-accepted', capturedText: 'An example thought',
      status: 'filed', capturedAt: '2026-01-01T00:00:00.000Z',
    };
    captureBrainThought.mockResolvedValue({ inboxLog: accepted });
    render(<MemoryRouter><InboxTab /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('New inbox thought'), { target: { value: accepted.capturedText } });
    fireEvent.click(screen.getByLabelText('Capture thought'));
    await waitFor(() => expect(screen.getByText(accepted.capturedText)).toBeInTheDocument());
    expect(screen.getByText('Loading inbox history')).toBeInTheDocument();
    expect(captureBrainThought.mock.calls[0].slice(1, 3)).toEqual([undefined, undefined]);

    await act(async () => { resolveHistory({ entries: historyIncludesCapture ? [accepted] : [], counts: { filed: historyIncludesCapture ? 1 : 0 } }); });
    await waitFor(() => expect(screen.queryByText('Loading inbox history')).toBeNull());
    expect(screen.getAllByText(accepted.capturedText)).toHaveLength(1);
  });

  it('keeps capture usable after history fails without claiming it is still loading', async () => {
    getBrainInbox.mockRejectedValue(new Error('Example history could not load'));
    const accepted = {
      id: 'example-after-history-error', capturedText: 'A thought after a history failure',
      status: 'filed', capturedAt: '2026-01-01T00:00:00.000Z',
    };
    captureBrainThought.mockResolvedValue({ inboxLog: accepted });
    render(<MemoryRouter><InboxTab /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('Example history could not load');
    expect(screen.getByRole('button', { name: 'Retry loading' })).toBeEnabled();
    expect(screen.queryByText('Inbox history is loading. You can capture thoughts above.')).toBeNull();
    expect(screen.queryByText('Loading inbox history')).toBeNull();
    fireEvent.change(screen.getByLabelText('New inbox thought'), { target: { value: accepted.capturedText } });
    fireEvent.click(screen.getByLabelText('Capture thought'));
    await waitFor(() => expect(screen.getByText(accepted.capturedText)).toBeInTheDocument());
  });

  it('sends an optional note when a URL is filed to Links', async () => {
    render(<MemoryRouter><InboxTab /></MemoryRouter>);
    const input = await screen.findByLabelText('New inbox thought');

    fireEvent.change(input, {
      target: { value: 'https://example.com' },
    });
    fireEvent.change(screen.getByLabelText(/Why are you saving this link/i), {
      target: { value: '  Share this with the team  ' },
    });
    fireEvent.click(screen.getByLabelText('Capture thought'));

    await waitFor(() => expect(captureBrainThought).toHaveBeenCalled());
    expect(captureBrainThought.mock.calls[0][3]).toMatchObject({
      note: 'Share this with the team',
    });
  });

  it('carries the Brain provider and model into the creative Catalog handoff', async () => {
    getBrainInbox.mockResolvedValue({
      entries: [{
        id: 'inbox-creative-1',
        capturedText: 'A captured story fragment.',
        creative: true,
        status: 'filed',
        capturedAt: '2026-01-01T00:00:00.000Z',
      }],
      counts: {},
    });

    render(
      <MemoryRouter>
        <InboxTab settings={{ defaultProvider: 'ollama', defaultModel: 'example-model' }} />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send to Catalog' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Send to Catalog' }));

    await waitFor(() => expect(JSON.parse(screen.getByTestId('location-state').textContent)).toMatchObject({
      prefill: expect.objectContaining({
        providerOverride: 'ollama',
        modelOverride: 'example-model',
      }),
    }));
  });

  describe('rejected capture recovery', () => {
    const deferred = () => {
      let resolve; let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };

    it('keeps the rejected text until an explicit Retry, without touching the next draft', async () => {
      const first = deferred();
      captureBrainThought.mockReturnValueOnce(first.promise);
      render(<MemoryRouter><InboxTab /></MemoryRouter>);
      const input = await screen.findByLabelText('New inbox thought');

      fireEvent.change(input, { target: { value: 'invented thought A' } });
      fireEvent.click(screen.getByLabelText('Capture thought'));
      await waitFor(() => expect(input.value).toBe(''));
      // The next draft is typed while A is still pending.
      fireEvent.change(input, { target: { value: 'invented thought B' } });

      first.reject(new Error('Server said no'));
      const row = await screen.findByRole('group', { name: 'Not saved capture' });
      expect(row.textContent).toContain('invented thought A');
      expect(row.textContent).toContain('Server said no');
      expect(input.value).toBe('invented thought B');
      expect(captureBrainThought).toHaveBeenCalledTimes(1);

      // Editing the failed row leaves the composer alone; Retry sends the edit once.
      fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
      fireEvent.change(screen.getByLabelText('Edit unsaved capture'), { target: { value: 'invented thought A, fixed' } });
      // Closing the editor keeps the edit.
      fireEvent.click(screen.getByRole('button', { name: /Done editing/ }));
      expect(screen.getByRole('group', { name: 'Not saved capture' }).textContent).toContain('invented thought A, fixed');
      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
      fireEvent.click(screen.getByRole('button', { name: /Retry|Retrying/ }));

      await waitFor(() => expect(screen.queryByRole('group', { name: 'Not saved capture' })).toBeNull());
      expect(captureBrainThought).toHaveBeenCalledTimes(2);
      expect(captureBrainThought.mock.calls[1][0]).toBe('invented thought A, fixed');
      expect(input.value).toBe('invented thought B');
    });

    it('lets the user discard a failed capture and keeps it on a second failure', async () => {
      captureBrainThought.mockRejectedValue(new Error('Still down'));
      render(<MemoryRouter><InboxTab /></MemoryRouter>);
      const input = await screen.findByLabelText('New inbox thought');
      fireEvent.change(input, { target: { value: 'invented thought C' } });
      fireEvent.click(screen.getByLabelText('Capture thought'));
      await screen.findByRole('group', { name: 'Not saved capture' });

      fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
      await waitFor(() => expect(captureBrainThought).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ }).disabled).toBe(false));
      expect(screen.getAllByRole('group', { name: 'Not saved capture' })).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
      expect(screen.queryByRole('group', { name: 'Not saved capture' })).toBeNull();
      expect(captureBrainThought).toHaveBeenCalledTimes(2);
    });
  });
});
