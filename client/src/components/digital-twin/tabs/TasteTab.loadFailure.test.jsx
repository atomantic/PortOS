import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  getTasteProfile: vi.fn(),
  getTasteNextQuestion: vi.fn(),
  getTasteSectionResponses: vi.fn(),
  getProviders: vi.fn(),
}));
vi.mock('../../../services/socket', () => ({ default: { connected: false, on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('../ObservedTasteEvidence', () => ({ default: () => null }));
vi.mock('../../cos/MarkdownOutput', () => ({ default: ({ content }) => <div>{content}</div> }));
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="provider-picker">{providers.map(p => p.name).join(',')}</div>,
}));

import TasteTab from './TasteTab';
import * as api from '../../../services/api';

const PROFILE = {
  completedCount: 0,
  totalSections: 1,
  sections: [{ id: 'movies', label: 'Movies', description: 'Films', status: 'in_progress', progress: { coreAnswered: 1, coreTotal: 3, percentage: 33 } }],
};
const API_PROVIDER = { id: 'p1', name: 'Example API', enabled: true, type: 'api', defaultModel: 'm1', models: ['m1'] };

beforeEach(() => {
  vi.clearAllMocks();
  api.getTasteProfile.mockResolvedValue(PROFILE);
  api.getTasteNextQuestion.mockResolvedValue(null);
  api.getProviders.mockResolvedValue({ providers: [API_PROVIDER] });
  api.getTasteSectionResponses.mockResolvedValue([{ questionText: 'Favorite film?', answer: 'Example Film' }]);
});

describe('TasteTab failed reads stay distinct from empty ones (#12783)', () => {
  it('shows a retryable error, not "0 responses", when the review read fails, and hides the actions that act on it', async () => {
    const user = userEvent.setup();
    api.getTasteSectionResponses.mockRejectedValueOnce(new Error('responses offline'));
    render(<TasteTab />);

    await user.click(await screen.findByRole('button', { name: /Review/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your responses — responses offline');
    expect(screen.queryByText(/responses recorded/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reset Section/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate Summary/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Example Film')).toBeInTheDocument();
    expect(screen.getByText('1 responses recorded')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a retryable error instead of the "no API provider" banner when providers fail to load', async () => {
    const user = userEvent.setup();
    api.getProviders.mockRejectedValueOnce(new Error('providers offline'));
    render(<TasteTab />);

    await user.click(await screen.findByRole('button', { name: /Movies/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load AI providers');
    expect(screen.queryByText(/No API-based provider configured/)).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: /Go Deeper/ });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/No API-based provider configured/)).not.toBeInTheDocument();
  });

  it('still explains a genuinely empty provider list with the banner', async () => {
    const user = userEvent.setup();
    api.getProviders.mockResolvedValue({ providers: [] });
    render(<TasteTab />);

    await user.click(await screen.findByRole('button', { name: /Movies/ }));
    expect(await screen.findByText(/No API-based provider configured/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
