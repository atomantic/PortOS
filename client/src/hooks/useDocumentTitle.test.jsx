import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getNavPageForPath } from '../../../server/lib/navManifest.js';

vi.mock('../services/apiSystem.js', () => ({ getSelfInstance: vi.fn() }));
vi.mock('../services/shellBootstrap.js', () => ({ readShellBootstrap: (_key, fetcher) => fetcher() }));

import { getSelfInstance } from '../services/apiSystem.js';
import useDocumentTitle, { setDocumentTitleInstanceName } from './useDocumentTitle.js';

describe('useDocumentTitle', () => {
  beforeEach(() => {
    vi.mocked(getSelfInstance).mockResolvedValue({ name: 'Studio' });
  });

  it('tracks route labels, falls back for unknown paths, and preserves the page on rename', async () => {
    const { rerender } = renderHook(({ pathname }) => useDocumentTitle(pathname), {
      initialProps: { pathname: '/cos/tasks' },
    });
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/cos/tasks').breadcrumb} · PortOS: Studio`));

    rerender({ pathname: '/brain/inbox' });
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/brain/inbox').breadcrumb} · PortOS: Studio`));

    rerender({ pathname: '/not-a-route' });
    await waitFor(() => expect(document.title).toBe('PortOS: Studio'));

    rerender({ pathname: '/settings/general' });
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/settings/general').breadcrumb} · PortOS: Studio`));
    act(() => setDocumentTitleInstanceName('New name'));
    await waitFor(() => expect(document.title).toBe(`${getNavPageForPath('/settings/general').breadcrumb} · PortOS: New name`));
  });
});
