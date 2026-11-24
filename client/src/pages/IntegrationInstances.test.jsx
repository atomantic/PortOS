import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import api from '../services/apiCore.js';
import DataDog from './DataDog';
import Jira from './Jira';

vi.mock('../services/apiCore.js', async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, default: { ...original.default, get: vi.fn() } };
});

it.each([
  ['DataDog', '/datadog/instances', true, DataDog],
  ['DataDog', '/datadog/instances', false, DataDog],
  ['JIRA', '/jira/instances', true, Jira],
  ['JIRA', '/jira/instances', false, Jira],
])('%s retries a failed instances read from %s (loaded rows: %s)', async (title, endpoint, hasInstances, Page) => {
  const instances = hasInstances ? { example: { id: 'example', name: 'Example instance' } } : {};
  const empty = `No ${title} instances configured.`;
  api.get.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ instances });
  render(<MemoryRouter><Page /></MemoryRouter>);

  expect(await screen.findByRole('alert')).toHaveTextContent(`Could not load ${title} instances`);
  expect(screen.queryByText(empty)).not.toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith(endpoint, { silent: true });

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasInstances ? 'Example instance' : empty)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
