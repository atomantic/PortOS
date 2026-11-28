import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { getContactsStatus, importContactToTribe, suggestTribeFromContacts } from '../../services/apiContacts.js';
import ContactsTab from './ContactsTab';

vi.mock('../../services/apiContacts.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getContactsStatus: vi.fn(),
  importContactToTribe: vi.fn(),
  suggestTribeFromContacts: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

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

it('removes only the imported suggestion even when multiple suggestions share a name without IDs or handles', async () => {
  getContactsStatus.mockResolvedValueOnce({ cache: { contactCount: 2, sourceCount: 1 }, state: {} });
  suggestTribeFromContacts.mockResolvedValueOnce({
    suggestions: [
      { displayName: 'Example Person', organization: 'Org A', phones: [], emails: [] },
      { displayName: 'Example Person', organization: 'Org B', phones: [], emails: [] },
    ],
  });
  importContactToTribe.mockResolvedValueOnce({
    created: true,
    person: { name: 'Example Person' },
  });

  render(<MemoryRouter><ContactsTab /></MemoryRouter>);

  fireEvent.click(await screen.findByRole('button', { name: 'Load suggestions' }));
  expect(await screen.findByText('Org A')).toBeInTheDocument();
  expect(screen.getByText('Org B')).toBeInTheDocument();

  fireEvent.click(screen.getAllByRole('button', { name: 'Add to Tribe' })[0]);

  await waitFor(() => expect(screen.queryByText('Org A')).not.toBeInTheDocument());
  expect(screen.getByText('Org B')).toBeInTheDocument();
});
