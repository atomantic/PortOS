import { act, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ReviewerGroupsEditor from './ReviewerGroupsEditor';

afterEach(() => vi.useRealTimers());

it('shows partial pauses, healthy later tiers, all-paused fallback and expiry without emitting configuration', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const onChange = vi.fn();
  const onGroupsChange = vi.fn();
  const props = {
    groups: [
      { id: 'primary', reviewers: ['codex', 'ollama'] },
      { id: 'second', reviewers: ['lmstudio'] },
      { id: 'third', reviewers: ['claude'] },
    ],
    onChange, onGroupsChange,
    reviewerHealth: { codex: { pausedUntil: 2000 }, lmstudio: { pausedUntil: 1500 } },
  };
  const view = render(<ReviewerGroupsEditor {...props} />);
  const primary = screen.getByRole('region', { name: 'Primary' });
  expect(primary).toHaveTextContent('Paused members');
  expect(screen.getByRole('region', { name: 'Fallback 2' })).toHaveTextContent('Active tier');
  // Display is the runtime's stable partition, without changing saved order.
  const rowHandles = within(primary).getAllByRole('button', { name: /^Drag .* in Primary$/ });
  expect(rowHandles.map(node => node.getAttribute('aria-label'))).toEqual(['Drag ollama in Primary', 'Drag codex in Primary']);
  expect(within(primary).getByLabelText('Move Codex earlier')).toBeDisabled();
  expect(within(primary).getByLabelText('Move Ollama later')).toBeDisabled();
  act(() => vi.advanceTimersByTime(499));
  expect(screen.getByRole('region', { name: 'Fallback 2' })).toHaveTextContent('Active tier');
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('region', { name: 'Fallback 1' })).toHaveTextContent('Active tier');
  act(() => vi.advanceTimersByTime(500));
  expect(primary).toHaveTextContent('Active tier');
  view.rerender(<ReviewerGroupsEditor {...props} reviewerHealth={{ codex: { pausedUntil: 3000 }, lmstudio: { pausedUntil: 3000 }, claude: { pausedUntil: 3000 } }} />);
  expect(primary).toHaveTextContent('Selected · paused members');
  expect(onChange).not.toHaveBeenCalled();
  expect(onGroupsChange).not.toHaveBeenCalled();
});

it('compacts desktop tier controls while retaining touch targets on mobile', () => {
  const props = {
    groups: [
      { id: 'primary', reviewers: ['codex'] },
      { id: 'second', reviewers: ['claude'] },
    ],
    onChange: vi.fn(),
    onGroupsChange: vi.fn(),
  };
  render(<ReviewerGroupsEditor {...props} />);
  const primary = screen.getByRole('region', { name: 'Primary' });
  const earlierBtn = within(primary).getByRole('button', { name: 'Move Primary earlier' });
  const laterBtn = within(primary).getByRole('button', { name: 'Move Primary later' });
  const removeBtn = within(primary).getByRole('button', { name: 'Remove Primary' });
  const addTierBtn = screen.getByRole('button', { name: 'Add tier' });
  const tierSelect = within(primary).getByRole('combobox', { name: 'Tier for codex in Primary' });
  const dragHandle = within(primary).getByRole('button', { name: 'Drag Primary' });

  for (const control of [earlierBtn, laterBtn, removeBtn, addTierBtn, tierSelect, dragHandle]) {
    expect(control.className).toContain('min-h-11');
    expect(control.className).toContain('sm:min-h-0');
  }
});
