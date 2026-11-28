import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getContactsStatus: vi.fn(),
  checkContactsSetup: vi.fn(),
  syncContacts: vi.fn(),
  enrichTribeFromContacts: vi.fn(),
  suggestTribeFromContacts: vi.fn(),
  importContactToTribe: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../../services/apiContacts.js', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

const ContactsTab = (await import('./ContactsTab')).default;

beforeEach(() => {
  vi.clearAllMocks();
  api.getContactsStatus.mockResolvedValue({ cache: { contactCount: 2, sourceCount: 1 } });
});

describe('ContactsTab — Tribe import suggestions', () => {
  it('removes only the imported suggestion when suggestions have no contactId or handle', async () => {
    api.suggestTribeFromContacts.mockResolvedValueOnce({
      suggestions: [
        { displayName: 'Example One', phones: [], emails: [] },
        { displayName: 'Example Two', phones: [], emails: [] },
      ],
    });
    api.importContactToTribe.mockResolvedValueOnce({
      created: true,
      person: { name: 'Example One' },
    });

    render(
      <MemoryRouter>
        <ContactsTab />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load suggestions' }));
    expect(await screen.findByText('Example One')).toBeInTheDocument();
    expect(screen.getByText('Example Two')).toBeInTheDocument();

    const addButtons = screen.getAllByRole('button', { name: 'Add to Tribe' });
    fireEvent.click(addButtons[0]);

    await waitFor(() => expect(screen.queryByText('Example One')).not.toBeInTheDocument());
    expect(screen.getByText('Example Two')).toBeInTheDocument();
  });
});
