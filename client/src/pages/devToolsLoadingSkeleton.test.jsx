import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IntegrationInstancesPage from '../components/integrations/IntegrationInstancesPage';
import api from '../services/apiCore.js';
import * as historyApi from '../services/apiHistory.js';
import * as mediaApi from '../services/apiMedia.js';
import { HistoryPage } from './HistoryPage';
import Uploads from './Uploads';

afterEach(() => vi.restoreAllMocks());

describe('full-width Dev Tools loading skeletons', () => {
  it.each([
    {
      label: 'Loading uploads',
      page: <Uploads />,
      mockFetch: promise => vi.spyOn(mediaApi, 'listUploads').mockReturnValue(promise),
    },
    {
      label: 'Loading history',
      page: <HistoryPage />,
      mockFetch: promise => {
        vi.spyOn(historyApi, 'getHistoryActions').mockReturnValue(promise);
        vi.spyOn(historyApi, 'getHistoryStats').mockReturnValue(promise);
        return vi.spyOn(historyApi, 'getHistory').mockReturnValue(promise);
      },
    },
    {
      label: 'Loading Example Integration',
      page: <IntegrationInstancesPage title="Example Integration" apiBase="/example" />,
      mockFetch: promise => vi.spyOn(api, 'get').mockReturnValue(promise),
    },
  ])('renders a full-height loading bar and padded scroll body for $label', ({ label, page, mockFetch }) => {
    const { promise } = Promise.withResolvers();
    const request = mockFetch(promise);
    render(page);

    expect(request).toHaveBeenCalledOnce();
    const skeleton = screen.getByRole('status', { name: label });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveClass('h-full');
    expect(skeleton.firstElementChild).toHaveClass('border-b', 'border-port-border');
    expect(skeleton.lastElementChild).toHaveClass('overflow-y-auto', 'p-3', 'sm:p-4');
  });
});
