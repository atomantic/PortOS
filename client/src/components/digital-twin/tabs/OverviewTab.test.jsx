import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getDigitalTwinTraits: vi.fn(),
  getDigitalTwinConfidence: vi.fn(),
  getDigitalTwinGaps: vi.fn(),
  getDigitalTwinCompleteness: vi.fn(),
  getProviders: vi.fn(),
  detectSoulContradictions: vi.fn(),
  updateSoulSettings: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../SoulWizard', () => ({ default: () => null }));
vi.mock('../PersonalityMap', () => ({ default: ({ traits }) => <div data-testid="map">{traits ? 'traits' : 'no-traits'}</div> }));
vi.mock('../ConfidenceGauge', () => ({ default: () => null }));
vi.mock('../GapRecommendations', () => ({ default: ({ gaps }) => <div data-testid="gaps">{gaps.length}</div> }));
vi.mock('../NextActionBanner', () => ({ default: () => null }));
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));

import * as api from '../../../services/api';
import OverviewTab from './OverviewTab';

const STATUS = { documentCount: 2, healthScore: 50, enabledDocuments: 2, documentsByCategory: {} };
const renderTab = () => render(
  <MemoryRouter><OverviewTab status={STATUS} settings={{}} onRefresh={() => {}} onSettingsChange={() => {}} /></MemoryRouter>
);

describe('OverviewTab failed reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDigitalTwinTraits.mockResolvedValue({ traits: { openness: 0.5 } });
    api.getDigitalTwinConfidence.mockResolvedValue({ confidence: { overall: 0.5 } });
    api.getDigitalTwinGaps.mockResolvedValue({ gaps: [{ dimension: 'x' }] });
    api.getDigitalTwinCompleteness.mockResolvedValue(null);
    api.getProviders.mockResolvedValue({ providers: [{ id: 'example', enabled: true }] });
  });

  it('shows an error with Retry when traits/confidence/gaps fail instead of an empty personality map', async () => {
    api.getDigitalTwinGaps.mockRejectedValueOnce(new Error('gaps offline'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load personality traits, confidence and gaps.*gaps offline/i);
    expect(screen.queryByTestId('gaps')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('gaps')).toHaveTextContent('1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error with Retry for a failed provider list instead of an empty picker', async () => {
    api.getProviders.mockRejectedValueOnce(new Error('providers down')).mockResolvedValueOnce({ providers: [{ id: 'example', enabled: true }] });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    expect(screen.queryByTestId('picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('picker')).toHaveTextContent('example'));
  });
});
