import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/api', () => ({
  getAgentActivityTimeline: vi.fn(),
}));

import * as api from '../../../services/api';
import ActivityTab from './ActivityTab.jsx';

const page = (action, count, prefix = 'a') => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}-${i}`, action, status: 'completed', timestamp: `2026-08-23T00:${String(59 - i).padStart(2, '0')}:00.000Z`,
}));

describe('ActivityTab filter paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the selected action for the first page and for Load More', async () => {
    api.getAgentActivityTimeline.mockImplementation(async (_l, _a, before) => page('post', 50, before ? 'more' : 'a'));

    render(<ActivityTab agentId="agent-1" />);
    await screen.findByText('Activity Log');
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(50, ['agent-1'], null, null);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by action'), { target: { value: 'post' } });
    });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(50, ['agent-1'], null, 'post');

    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Load More' })); });
    expect(api.getAgentActivityTimeline).toHaveBeenLastCalledWith(
      50, ['agent-1'], '2026-08-23T00:10:00.000Z', 'post'
    );
  });
});
