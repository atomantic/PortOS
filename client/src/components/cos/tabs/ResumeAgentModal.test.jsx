import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ResumeAgentModal from './ResumeAgentModal.jsx';

vi.mock('../../../services/apiCore.js', () => ({ request: vi.fn().mockResolvedValue({ options: [] }) }));

const providers = [
  { id: 'first', name: 'First', enabled: true, models: ['first-model'] },
  { id: 'second', name: 'Second', enabled: true, models: ['second-model'] },
];

it('clears provider-scoped execution options when resuming on a different provider', async () => {
  const onSubmit = vi.fn().mockResolvedValue({});
  render(<ResumeAgentModal
    agent={{ id: 'example-agent', status: 'paused', metadata: {
      provider: 'first', model: 'first-model', executionOptions: { serviceTier: 'fast' },
    } }}
    providers={providers} apps={[]} onSubmit={onSubmit} onClose={vi.fn()}
  />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resume Agent' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'second', model: '', executionOptions: {},
  })));
});

it('sorts target apps and retains an archived app only while selected', async () => {
  const onSubmit = vi.fn().mockResolvedValue({});
  render(<ResumeAgentModal
    agent={{ id: 'example-agent', status: 'paused', metadata: { taskApp: 'retired' } }}
    providers={providers}
    apps={[
      { id: 'zed', name: 'Zed' },
      { id: 'old', name: 'Old App', archived: true },
      { id: 'alpha', name: 'Alpha' },
      { id: 'retired', name: 'Retired App', archived: true },
    ]}
    onSubmit={onSubmit}
    onClose={vi.fn()}
  />);

  const app = screen.getByRole('combobox', { name: 'Target App' });
  expect(app).toHaveValue('retired');
  expect(Array.from(app.options, option => option.text)).toEqual(['PortOS (default)', 'Alpha', 'Retired App', 'Zed']);

  fireEvent.change(app, { target: { value: 'alpha' } });
  expect(Array.from(app.options, option => option.text)).toEqual(['PortOS (default)', 'Alpha', 'Zed']);
  fireEvent.click(screen.getByRole('button', { name: 'Resume Agent' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ app: 'alpha' })));
});
