import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import * as api from '../services/api';
import Goals, { TABS } from './Goals';
import { expectPageNavTabs } from '../test/pageNavTabAssertions.js';

vi.mock('../services/api', () => ({ getGoalsTree: vi.fn() }));
vi.mock('../components/MortalLoomBanner', () => ({ default: () => null }));
vi.mock('../components/goals/GoalsListView', () => ({
  default: ({ data }) => <div data-testid="goals-list">{data.flat.length} goals</div>,
}));

// Goals derives its tab bar from the nav manifest's `tabGroup: 'goals'` (#6365)
// — this pins that TABS stays in sync (id, label, declaration order) and that
// every manifest tab has a presentation entry (icon) in Goals.jsx, which would
// otherwise only surface as a thrown import-time error. The page-local
// "List"/"Tree" labels differ from the manifest's "Goals"/"Goals Tree" via
// the manifest's `tabLabel`.
describe('Goals TABS ↔ nav manifest', () => {
  it('renders the goals tabGroup in page order with a presentation entry each', () => {
    expectPageNavTabs(TABS, [
      'list:List', 'tree:Tree',
    ]);
  });
});

describe('Goals tree read', () => {
  const renderGoals = () => render(
    <MemoryRouter initialEntries={['/goals/list']}>
      <Routes><Route path="/goals/:tab" element={<Goals />} /></Routes>
    </MemoryRouter>,
  );

  it('shows a failed read with Retry instead of an empty goal list', async () => {
    api.getGoalsTree.mockRejectedValueOnce(new Error('tree unavailable'));
    renderGoals();
    expect(await screen.findByText('Could not load goals')).toBeInTheDocument();
    expect(screen.getByText('tree unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('goals-list')).toBeNull();

    api.getGoalsTree.mockResolvedValueOnce({ roots: [], flat: [{ id: 'g-1' }] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('1 goals')).toBeInTheDocument();
    expect(screen.queryByText('Could not load goals')).toBeNull();
  });
});
