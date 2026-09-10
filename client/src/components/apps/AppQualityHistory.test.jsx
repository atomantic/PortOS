import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { it, expect, vi } from 'vitest';
import AppQualityHistory from './AppQualityHistory';
import { getAppQualityHistory } from '../../services/apiApps';
vi.mock('../../services/apiApps', () => ({ getAppQualityHistory: vi.fn() }));
vi.mock('recharts', () => ({ ResponsiveContainer: () => <div>Chart</div>, LineChart: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null }));
function Location() { return <output>{useLocation().search}</output>; }
it('loads shared filters, displays category evidence, and recovers after a failed range change', async () => {
  getAppQualityHistory.mockResolvedValueOnce({ totalCategories: 25, points: [{ date: '2026-09-10', score: 80, ratedCategories: 2, categories: { security: { score: 40, coverage: 'partial', confidence: 'medium' } } }] });
  render(<MemoryRouter initialEntries={['/?qualityDays=30&qualityCategory=security&tab=overview']}><AppQualityHistory appId="portos-default" categories={[{ id: 'security', label: 'Security' }]} /><Location /></MemoryRouter>);
  expect(await screen.findByText('40/100')).toBeInTheDocument();
  expect(screen.getByText('partial · medium confidence')).toBeInTheDocument();
  expect(getAppQualityHistory).toHaveBeenCalledWith('portos-default', '30');
  getAppQualityHistory.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(screen.getByLabelText('Period'), { target: { value: '365' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.getByRole('status')).toHaveTextContent('qualityDays=365&qualityCategory=security&tab=overview');
  getAppQualityHistory.mockResolvedValueOnce({ points: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }));
  await waitFor(() => expect(screen.getByText(/No scored assessments/)).toBeInTheDocument());
});
