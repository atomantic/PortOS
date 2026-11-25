import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/apiDigitalTwin.js', () => ({
  getDigitalTwinTraits: vi.fn(),
  getDigitalTwinConfidence: vi.fn(),
  getDigitalTwinGaps: vi.fn(),
  getDigitalTwinCompleteness: vi.fn(),
  detectSoulContradictions: vi.fn(),
  updateSoulSettings: vi.fn(),
}));
vi.mock('../../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
}));
vi.mock('../../ui/Toast');
vi.mock('../SoulWizard', () => ({ default: () => null }));
vi.mock('../PersonalityMap', () => ({ default: ({ traits }) => <div data-testid="map">{traits ? 'traits' : 'no-traits'}</div> }));
vi.mock('../ConfidenceGauge', () => ({ default: () => null }));
vi.mock('../GapRecommendations', () => ({ default: ({ gaps }) => <div data-testid="gaps">{gaps.length}</div> }));
vi.mock('../NextActionBanner', () => ({ default: () => null }));
vi.mock('../TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));

import {
  getDigitalTwinTraits,
  getDigitalTwinConfidence,
  getDigitalTwinGaps,
  getDigitalTwinCompleteness,
} from '../../../services/apiDigitalTwin.js';
import { getProviders } from '../../../services/apiProviders.js';
import OverviewTab from './OverviewTab';

const STATUS = { documentCount: 2, healthScore: 50, enabledDocuments: 2, documentsByCategory: {} };
const renderTab = () => render(
  <MemoryRouter><OverviewTab status={STATUS} settings={{}} onRefresh={() => {}} onSettingsChange={() => {}} /></MemoryRouter>
);

describe('OverviewTab failed reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinTraits.mockResolvedValue({ traits: { openness: 0.5 } });
    getDigitalTwinConfidence.mockResolvedValue({ confidence: { overall: 0.5 } });
    getDigitalTwinGaps.mockResolvedValue({ gaps: [{ dimension: 'x' }] });
    getDigitalTwinCompleteness.mockResolvedValue(null);
    getProviders.mockResolvedValue({ providers: [{ id: 'example', enabled: true }] });
  });

  it('shows an error with Retry when traits/confidence/gaps fail instead of an empty personality map', async () => {
    getDigitalTwinGaps.mockRejectedValueOnce(new Error('gaps offline'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load personality traits, confidence and gaps.*gaps offline/i);
    expect(screen.queryByTestId('gaps')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('gaps')).toHaveTextContent('1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error with Retry for a failed provider list instead of an empty picker', async () => {
    getProviders.mockRejectedValueOnce(new Error('providers down')).mockResolvedValueOnce({ providers: [{ id: 'example', enabled: true }] });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load AI providers/i);
    expect(screen.queryByTestId('picker')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('picker')).toHaveTextContent('example'));
  });
});

describe('OverviewTab completeness failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinTraits.mockResolvedValue({ traits: {} });
    getDigitalTwinConfidence.mockResolvedValue({ confidence: { overall: 0.5 } });
    getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
    getProviders.mockResolvedValue({ providers: [{ id: 'example', enabled: true }] });
  });

  it('shows a retryable error, not a dead-end message, when the completeness read fails', async () => {
    getDigitalTwinCompleteness
      .mockRejectedValueOnce(new Error('completeness offline'))
      .mockResolvedValueOnce({ score: 100, found: 1, total: 1, missing: [] });
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load completeness analysis.*completeness offline/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('100%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('OverviewTab CoS status Enable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDigitalTwinTraits.mockResolvedValue({ traits: { openness: 0.5 } });
    getDigitalTwinConfidence.mockResolvedValue({ confidence: { overall: 0.5 } });
    getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
    getDigitalTwinCompleteness.mockResolvedValue(null);
    getProviders.mockResolvedValue({ providers: [{ id: 'example', enabled: true }] });
  });

  it('opens the Settings panel, scrolls it into view and focuses its first checkbox', async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderTab();
      fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
      const checkbox = await screen.findByLabelText('Auto-inject soul context into CoS agents');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
      expect(scrollIntoView.mock.contexts[0]).toBe(checkbox.closest('div.border-t'));
      expect(document.activeElement).toBe(checkbox);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('OverviewTab CoS status Enable with Settings already open', () => {
  it('still scrolls the open Settings panel into view', async () => {
    vi.clearAllMocks();
    getDigitalTwinTraits.mockResolvedValue({ traits: { openness: 0.5 } });
    getDigitalTwinConfidence.mockResolvedValue({ confidence: { overall: 0.5 } });
    getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
    getDigitalTwinCompleteness.mockResolvedValue(null);
    getProviders.mockResolvedValue({ providers: [{ id: 'example', enabled: true }] });
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderTab();
      const enable = await screen.findByRole('button', { name: 'Enable' });
      fireEvent.click(enable);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
