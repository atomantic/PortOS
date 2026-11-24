import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getGoalScorecardRules, saveGoalScorecardRules } from '../../services/apiSystem.js';
import GoalScorecardTab from './GoalScorecardTab.jsx';

vi.mock('../../services/apiSystem.js', () => ({
  getGoalScorecard: vi.fn().mockResolvedValue({ available: true }),
  getGoalScorecardSettings: vi.fn().mockResolvedValue({}),
  getGoalScorecardRules: vi.fn(),
  saveGoalScorecardRules: vi.fn(),
  refreshGoalScorecardNarrative: vi.fn(),
}));

vi.mock('../../services/apiProviders.js', () => ({
  getProviders: vi.fn().mockResolvedValue([]),
}));

it('requires a successful mapping read and keeps edits after a failed save', async () => {
  const overrides = {
    writing: { keywords: ['draft'], personIds: ['person-1'], subcalendarIds: ['calendar-1'] },
    archived: { enabled: false, personIds: ['person-2'] },
  };
  getGoalScorecardRules
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValueOnce({
      rules: [{ id: 'writing', title: 'Writing', keywords: ['write'] }],
      overrides,
    });
  saveGoalScorecardRules.mockRejectedValueOnce(new Error('Write failed')).mockResolvedValueOnce({});

  render(<GoalScorecardTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mapping' }));

  expect(screen.queryByRole('button', { name: 'Save keywords' })).toBeNull();
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed');
  expect(screen.queryByText('No active goals found.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save keywords' })).toBeNull();
  expect(saveGoalScorecardRules).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const input = await screen.findByRole('textbox', { name: 'Extra keywords for Writing' });
  expect(input).toHaveValue('draft');
  fireEvent.change(input, { target: { value: 'draft, outline' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save keywords' }));

  const save = await screen.findByRole('button', { name: 'Save keywords' });
  expect(save).toBeEnabled();
  expect(input).toHaveValue('draft, outline');
  const expected = {
    ...overrides,
    writing: { ...overrides.writing, keywords: ['draft', 'outline'] },
  };
  expect(saveGoalScorecardRules).toHaveBeenNthCalledWith(1, expected);

  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Extra keywords for Writing' })).toBeNull());
  expect(saveGoalScorecardRules).toHaveBeenNthCalledWith(2, expected);
});
