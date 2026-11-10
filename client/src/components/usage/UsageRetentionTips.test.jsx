import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getUsageTips: vi.fn(), dismissUsageTip: vi.fn() }));
vi.mock('../../services/api', () => api);

const { default: UsageRetentionTips } = await import('./UsageRetentionTips');

const tip = {
  id: 'example-tip',
  label: 'Keep example sessions',
  text: 'Example CLI deletes sessions.',
  file: '~/.example/settings.json',
  snippet: '"keepDays": 100',
  docsUrl: 'https://example.com/docs',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getUsageTips.mockResolvedValue({ tips: [tip] });
  api.dismissUsageTip.mockResolvedValue({ tips: [] });
});

describe('UsageRetentionTips', () => {
  it('shows an open tip with its setting and hides it once the user says it is done', async () => {
    render(<UsageRetentionTips />);
    expect(await screen.findByText('"keepDays": 100')).toBeTruthy();
    expect(screen.getByText('~/.example/settings.json')).toBeTruthy();
    expect(api.getUsageTips).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: "I've added it" }));
    await waitFor(() => expect(screen.queryByText('Keep example sessions')).toBeNull());
    expect(api.dismissUsageTip).toHaveBeenCalledWith('example-tip');
  });

  it('renders nothing when every tip is applied or dismissed', async () => {
    api.getUsageTips.mockResolvedValue({ tips: [] });
    const { container } = render(<UsageRetentionTips />);
    await waitFor(() => expect(api.getUsageTips).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
