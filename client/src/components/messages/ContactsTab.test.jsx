import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { getContactsStatus } from '../../services/apiContacts.js';
import ContactsTab from './ContactsTab';

vi.mock('../../services/apiContacts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getContactsStatus: vi.fn(),
}));

it.each([false, true])('retries unread Contacts status (has a cache: %s)', async (hasCache) => {
  const cache = hasCache ? { contactCount: 37, sourceCount: 2, syncedAt: '2026-01-01T00:00:00Z' } : null;
  getContactsStatus.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ cache, state: {} });
  render(<MemoryRouter><ContactsTab /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Contacts status');
  expect(screen.getByText('Contacts').nextElementSibling).toHaveTextContent('—');
  expect(screen.queryByText('Never')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasCache ? '37' : 'Never')).toBeInTheDocument();
  expect(screen.getByText('Contacts').nextElementSibling).toHaveTextContent(hasCache ? '37' : '0');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
