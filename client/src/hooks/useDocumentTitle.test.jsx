import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNavPageForPath } from '../../../server/lib/navManifest.js';

vi.mock('../services/apiSystem.js', () => ({ getSelfInstance: vi.fn() }));
vi.mock('../services/shellBootstrap.js', () => ({ readShellBootstrap: (_key, fetcher) => fetcher() }));

import { getSelfInstance } from '../services/apiSystem.js';
import useDocumentTitle, { setDocumentTitleInstanceName } from './useDocumentTitle.js';

function TitleFixture() {
  const navigate = useNavigate();
  useDocumentTitle();
  return <div>
    <button onClick={() => navigate('/brain/inbox')}>Brain</button>
    <button onClick={() => navigate('/not-a-route')}>Unknown</button>
    <button onClick={() => navigate('/settings/general')}>Settings</button>
  </div>;
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    vi.mocked(getSelfInstance).mockResolvedValue({ name: 'Studio' });
  });

  it('tracks route labels, falls back for unknown paths, and preserves the page on rename', async () => {
    render(<MemoryRouter initialEntries={['/cos/tasks']}><TitleFixture /></MemoryRouter>);
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/cos/tasks').breadcrumb} · PortOS: Studio`));

    fireEvent.click(screen.getByRole('button', { name: 'Brain' }));
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/brain/inbox').breadcrumb} · PortOS: Studio`));

    fireEvent.click(screen.getByRole('button', { name: 'Unknown' }));
    await waitFor(() => expect(document.title).toBe('PortOS: Studio'));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/settings/general').breadcrumb} · PortOS: Studio`));
    act(() => setDocumentTitleInstanceName('New name'));
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/settings/general').breadcrumb} · PortOS: New name`));
  });
});
