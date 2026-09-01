import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getBrainInbox: vi.fn(),
  captureBrainThought: vi.fn(),
  getBrainInboxEntry: vi.fn(),
  resolveBrainReview: vi.fn(),
  fixBrainClassification: vi.fn(),
  retryBrainClassification: vi.fn(),
  updateBrainInboxEntry: vi.fn(),
  deleteBrainInboxEntry: vi.fn(),
  markBrainInboxDone: vi.fn(),
  markBrainInboxSentToCatalog: vi.fn(),
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
  it('sends an optional note when a URL is filed to Links', async () => {
    render(<MemoryRouter><InboxTab /></MemoryRouter>);
    await waitFor(() => expect(getBrainInbox).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('New inbox thought'), {
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
});
