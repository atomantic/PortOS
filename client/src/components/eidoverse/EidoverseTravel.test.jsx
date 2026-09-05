import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  getEidoverseDestinations: vi.fn(async () => ({
    destinations: [{ peerId: 'example-peer', label: 'Example world' }],
  })),
  departEidoverse: vi.fn(),
}));

import { departEidoverse } from '../../services/api';
import EidoverseTravel from './EidoverseTravel';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('enters the admitted destination only after the current world leaves, and stays put if departure fails', async () => {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  const url = 'https://example.com/eidoverse/guest#example-ticket';
  departEidoverse.mockResolvedValue({ url });
  let finish;
  const beforeDeparture = vi.fn().mockRejectedValueOnce(new Error('World is still closing'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<EidoverseTravel enabled travelRef={createRef()} beforeDeparture={beforeDeparture} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Example world' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('World is still closing');
  expect(assign).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Example world' })); });
  expect(screen.getByRole('button', { name: 'Opening guest visit…' })).toBeDisabled();
  expect(assign).not.toHaveBeenCalled();
  await act(async () => { finish(); });
  expect(assign).toHaveBeenCalledExactlyOnceWith(url);
});

it('restores departure controls after a pending visit settles across a renderer restart', async () => {
  let finishDeparture;
  departEidoverse.mockReturnValueOnce(new Promise((resolve) => { finishDeparture = resolve; }));
  const travelRef = createRef();
  const view = render(<EidoverseTravel enabled travelRef={travelRef} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Example world' }));
  expect(screen.getByRole('button', { name: 'Opening guest visit…' })).toBeDisabled();

  view.rerender(<EidoverseTravel enabled={false} travelRef={travelRef} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  view.rerender(<EidoverseTravel enabled travelRef={travelRef} />);
  expect(screen.getByRole('button', { name: 'Opening guest visit…' })).toBeDisabled();

  await act(async () => {
    finishDeparture({ url: 'https://example.com/eidoverse/guest#expired-visit' });
  });
  expect(screen.getByRole('button', { name: 'Example world' })).toBeEnabled();
  expect(departEidoverse).toHaveBeenCalledExactlyOnceWith('example-peer', { silent: true });
});
