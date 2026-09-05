import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  getEidoverseDestinations: vi.fn(async () => ({
    destinations: [{ peerId: 'example-peer', label: 'Example world' }],
  })),
  departEidoverse: vi.fn(),
}));

import { departEidoverse } from '../../services/api';
import EidoverseTravel from './EidoverseTravel';

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
