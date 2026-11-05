import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getDigitalTwinStatus: vi.fn(),
  getDigitalTwinSettings: vi.fn(),
  getDigitalTwinTraits: vi.fn(),
  getDigitalTwinConfidence: vi.fn(),
  getDigitalTwinGaps: vi.fn(),
  getDigitalTwinCompleteness: vi.fn(),
  getProviders: vi.fn(),
  detectSoulContradictions: vi.fn(),
  updateSoulSettings: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/digital-twin/SoulWizard', () => ({ default: () => null }));
vi.mock('../components/digital-twin/PersonalityMap', () => ({ default: ({ traits }) => <div data-testid="map">{traits ? 'traits' : 'no-traits'}</div> }));
vi.mock('../components/digital-twin/ConfidenceGauge', () => ({ default: () => null }));
vi.mock('../components/digital-twin/GapRecommendations', () => ({ default: ({ gaps }) => <div data-testid="gaps">{gaps.length}</div> }));
vi.mock('../components/digital-twin/NextActionBanner', () => ({ default: () => null }));
vi.mock('../components/digital-twin/TwinProviderPicker.jsx', () => ({
  default: ({ providers }) => <div data-testid="picker">{providers.map((p) => p.id).join(',')}</div>,
}));

import * as api from '../services/api';
import DigitalTwin from './DigitalTwin';
import socket from '../services/socket';
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});

const mount = () => render(<MemoryRouter><DigitalTwin /></MemoryRouter>);
const status = { documentCount: 2, healthScore: 50, enabledDocuments: 2, documentsByCategory: {} };

beforeEach(() => {
  vi.clearAllMocks();
  api.getDigitalTwinStatus.mockResolvedValue(status);
  api.getDigitalTwinSettings.mockResolvedValue({});
  api.getDigitalTwinTraits.mockResolvedValue({ traits: {} });
  api.getDigitalTwinConfidence.mockResolvedValue({ confidence: {} });
  api.getDigitalTwinGaps.mockResolvedValue({ gaps: [] });
  api.getDigitalTwinCompleteness.mockResolvedValue(null);
  api.getProviders.mockResolvedValue({ providers: [] });
});

describe('Digital Twin initial load', () => {
  it.each(['getDigitalTwinStatus', 'getDigitalTwinSettings'])('offers retry instead of the wizard when %s fails', async (read) => {
    api[read].mockRejectedValueOnce(new Error('offline'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load digital twin — offline');
    expect(screen.queryByText('Create Your Digital Twin')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start Wizard/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('2/2 docs')).toBeInTheDocument();
    await screen.findByTestId('map');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Your Digital Twin')).not.toBeInTheDocument();
    expect(api.getDigitalTwinStatus).toHaveBeenCalledTimes(2);
    expect(api.getDigitalTwinSettings).toHaveBeenCalledTimes(2);
  });

  it('offers the wizard for a successfully loaded empty twin', async () => {
    api.getDigitalTwinStatus.mockResolvedValue({ ...status, documentCount: 0, enabledDocuments: 0 });
    mount();
    expect(await screen.findByText('Create Your Digital Twin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start Wizard/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the loaded overview when later reconciliation fails', async () => {
    mount();
    await screen.findByTestId('map');
    api.getDigitalTwinStatus.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { socket.emit('digital-twin:changed', {}); });
    expect(api.getDigitalTwinStatus).toHaveBeenCalledTimes(2);
    expect(screen.getByText('2/2 docs')).toBeInTheDocument();
    expect(screen.getByTestId('map')).toBeInTheDocument();
    expect(screen.queryByText('Create Your Digital Twin')).not.toBeInTheDocument();
  });
});
