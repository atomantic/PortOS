import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => {
  const listeners = new Map();
  return {
    emit: vi.fn(),
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off: (event, fn) => listeners.get(event)?.delete(fn),
    receive: (event, payload) => {
      for (const fn of listeners.get(event) || []) fn(payload);
    },
  };
});
vi.mock('../../services/socket', () => ({ default: socket }));

vi.mock('../../services/api', () => ({
  getEidoverseDestinations: vi.fn(async () => ({
    destinations: [{ peerId: 'example-peer', label: 'Example world' }],
  })),
  departEidoverse: vi.fn(),
}));

import { departEidoverse, getEidoverseDestinations } from '../../services/api';
import EidoverseTravel from './EidoverseTravel';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

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

it('pushes destinations without polling and reconciles once on reconnect and reshow', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const changed = vi.fn();
  const travelRef = createRef();
  const view = render(<EidoverseTravel enabled travelRef={travelRef} onDestinationsChange={changed} />);
  await act(async () => {});
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(1);
  expect(socket.emit).toHaveBeenCalledWith('eidoverse-travel:subscribe');
  expect(screen.getByRole('button', { name: 'Example world' })).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(1);

  await act(async () => socket.receive('eidoverse-travel:destinations', {
    destinations: [{ peerId: 'other-peer', label: 'Other world' }],
  }));
  expect(screen.getByRole('button', { name: 'Other world' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Example world' })).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(1);

  await act(async () => socket.receive('connect'));
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(socket.emit).toHaveBeenCalledWith('eidoverse-travel:unsubscribe');
  await act(async () => {
    socket.receive('connect');
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(3);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(3);
  view.rerender(<EidoverseTravel enabled={false} travelRef={travelRef} />);
  await act(async () => {
    socket.receive('connect');
    socket.receive('eidoverse-travel:destinations', { destinations: [] });
    await vi.advanceTimersByTimeAsync(90_000);
  });
  expect(getEidoverseDestinations).toHaveBeenCalledTimes(3);
});

it('keeps a pushed destination snapshot when an older read finishes later', async () => {
  let finish;
  getEidoverseDestinations.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<EidoverseTravel enabled travelRef={createRef()} />);
  await act(async () => socket.receive('eidoverse-travel:destinations', {
    destinations: [{ peerId: 'current-peer', label: 'Current world' }],
  }));
  await act(async () => finish({ destinations: [] }));
  expect(screen.getByRole('button', { name: 'Current world' })).toBeInTheDocument();
});
