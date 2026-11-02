import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
const api = vi.hoisted(() => ({
  listSignalConversations: vi.fn(), getSignalBlocklist: vi.fn(), setSignalBlocklist: vi.fn(),
  purgeSignalConversation: vi.fn(), blockSignalConversation: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));
import SignalManager from './SignalManager';
beforeEach(() => {
  vi.clearAllMocks();
  api.listSignalConversations.mockResolvedValue({ conversations: [{ conversationId: 'opaque:%_:id', title: 'Example group', eventCount: 2 }] });
  api.getSignalBlocklist.mockResolvedValue({ handles: [], conversationIds: [] });
  api.blockSignalConversation.mockResolvedValue({});
  api.setSignalBlocklist.mockImplementation(async (body) => body);
});
it('loads on demand, confirms block and purge, and saves handle/conversation exclusions', async () => {
  render(<SignalManager />);
  expect(api.listSignalConversations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Manage imported data' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Block and purge' }));
  expect(api.blockSignalConversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm purge' }));
  await waitFor(() => expect(api.blockSignalConversation).toHaveBeenCalledWith('opaque:%_:id'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm purge' })).toBeNull());
  fireEvent.change(screen.getByLabelText('Blocked handles (one per line)'), { target: { value: '+15551234567' } });
  fireEvent.change(screen.getByLabelText('Blocked conversation IDs (one per line)'), { target: { value: 'group' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save exclusions' }));
  await waitFor(() => expect(api.setSignalBlocklist).toHaveBeenCalledWith({ handles: ['+15551234567'], conversationIds: ['group'] }));
});
it('renders a failed management load without enabling mutation controls', async () => {
  api.getSignalBlocklist.mockRejectedValue(new Error('Exclusions unavailable'));
  render(<SignalManager />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage imported data' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Exclusions unavailable');
  expect(screen.queryByRole('button', { name: 'Save exclusions' })).toBeNull();
});

it('keeps unsaved exclusions through searches and conversation refreshes', async () => {
  render(<SignalManager />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage imported data' }));
  const handles = await screen.findByLabelText('Blocked handles (one per line)');
  fireEvent.change(handles, { target: { value: '+15551234567' } });
  fireEvent.change(screen.getByLabelText('Search Signal conversations'), { target: { value: 'example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => expect(api.listSignalConversations).toHaveBeenCalledWith('example'));
  expect(handles.value).toBe('+15551234567');
  expect(api.getSignalBlocklist).toHaveBeenCalledTimes(1);
});
