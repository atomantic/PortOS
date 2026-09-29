import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../services/api', () => ({ getClaudeCodeModelUsage: vi.fn() }));
import * as api from '../../services/api';
import ClaudeCodeModelTokensCard from './ClaudeCodeModelTokensCard';

const totals = { messages: 2, input: 1200, output: 34, cacheRead: 5, cacheWrite: 6, total: 1245, estimatedCost: 12.5 };
const row = { model: 'model-x', ...totals };

describe('ClaudeCodeModelTokensCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders fleet models with API-equivalent cost and a per-instance breakdown', async () => {
    api.getClaudeCodeModelUsage.mockResolvedValue({
      models: [row], totals,
      instances: [
        { instanceId: 'a', name: 'Box A', self: true, capturedAt: '2026-09-20T00:00:00Z', usesSubscriptions: true, models: [row], totals },
        { instanceId: 'b', name: 'Box B', self: false, capturedAt: '2026-09-20T00:00:00Z', usesSubscriptions: false, models: [row], totals }
      ]
    });
    render(<ClaudeCodeModelTokensCard period="30d" from="" to="" isCustom={false} />);
    expect(await screen.findByText(/all instances/)).toBeTruthy();
    expect(screen.getAllByText('model-x').length).toBeGreaterThan(0);
    expect(screen.getByText(/API-billed, not in total/)).toBeTruthy();
    expect(api.getClaudeCodeModelUsage).toHaveBeenCalledWith({ period: '30d' }, { silent: true });
  });

  it('sends the explicit range for a custom window and reports a failed read', async () => {
    api.getClaudeCodeModelUsage.mockRejectedValue(new Error('boom'));
    render(<ClaudeCodeModelTokensCard period="7d" from="2026-09-01" to="2026-09-15" isCustom />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(api.getClaudeCodeModelUsage).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-15' }, { silent: true });
  });
});
