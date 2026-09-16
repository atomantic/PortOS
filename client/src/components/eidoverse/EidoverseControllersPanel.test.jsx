/**
 * The controllers panel is the only surface that lets a user see and manage
 * what is ticking in their own Eidoverse world without a mind in the loop
 * (#7488). The regression this pins that a status-code check cannot: a
 * supervisor-disarmed reason silently dropped instead of rendered verbatim,
 * and an install refusal collapsing into a generic failure.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  listEidoverseControllers: vi.fn(),
  installEidoverseController: vi.fn(),
  setEidoverseControllerArmed: vi.fn(),
  retireEidoverseController: vi.fn(),
}));

import {
  installEidoverseController,
  listEidoverseControllers,
  retireEidoverseController,
  setEidoverseControllerArmed,
} from '../../services/api';
import EidoverseControllersPanel from './EidoverseControllersPanel';

const definition = (overrides = {}) => ({
  id: 'resource-tick',
  title: 'Resource tick',
  summary: 'Ticks a resource counter forward.',
  exampleConfig: { rate: 1 },
  ...overrides,
});

const install = (overrides = {}) => ({
  id: 'tide-beacon',
  controllerId: 'resource-tick',
  armed: true,
  deliverEffects: false,
  tickIntervalMs: 300000,
  placement: { districtId: null, anchorEntityId: null },
  installedBy: 'user',
  installedAt: '2026-03-04T05:06:07.000Z',
  tick: 3,
  lastTickAt: '2026-03-04T06:00:00.000Z',
  nextTickAt: '2026-03-04T06:05:00.000Z',
  lastTickOk: true,
  lastTickReason: null,
  consecutiveFailures: 0,
  disarmedReason: null,
  note: null,
  recentEffects: [],
  ...overrides,
});

const listing = (installs, overrides = {}) => ({
  available: [definition()],
  counts: { total: installs.length, armed: installs.filter((entry) => entry.armed).length, delivering: 0 },
  installs,
  ...overrides,
});

// Settle the initial load OUTSIDE the act() a click needs, same reasoning as
// the foundations panel test: React does not commit while an async act
// callback is still running, so a findBy* inside one never sees the fetched list.
const renderPanel = async () => {
  const view = render(<MemoryRouter><EidoverseControllersPanel /></MemoryRouter>);
  await act(async () => {});
  return view;
};

afterEach(() => { vi.clearAllMocks(); });

describe('the Eidoverse controllers panel', () => {
  it('renders a supervisor-disarmed controller with its reason verbatim, and offers to re-arm it', async () => {
    listEidoverseControllers.mockResolvedValue(listing([
      install({ armed: false, disarmedReason: 'failed 3 consecutive ticks: step() threw a TypeError' }),
    ]));
    await renderPanel();

    expect(screen.getByText(/failed 3 consecutive ticks: step\(\) threw a TypeError/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Arm/ })).toBeInTheDocument();
  });

  it('shows an install refusal with its reasons beside the form, without installing anything', async () => {
    listEidoverseControllers.mockResolvedValue(listing([]));
    installEidoverseController.mockResolvedValue({
      outcome: 'refused',
      install: null,
      reasons: ['no controller is registered under "ghost-controller"'],
    });
    await renderPanel();

    fireEvent.change(screen.getByLabelText('Install id (lowercase slug)'), { target: { value: 'tide-beacon' } });
    fireEvent.change(screen.getByLabelText('Controller'), { target: { value: 'resource-tick' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });

    expect(screen.getByText(/no controller is registered under "ghost-controller"/)).toBeInTheDocument();
    expect(screen.getByText('Refused — nothing changed.')).toBeInTheDocument();
  });

  it('refuses to submit an unparseable config instead of sending it to the install gate', async () => {
    listEidoverseControllers.mockResolvedValue(listing([]));
    await renderPanel();

    fireEvent.change(screen.getByLabelText('Install id (lowercase slug)'), { target: { value: 'tide-beacon' } });
    fireEvent.change(screen.getByLabelText('Controller'), { target: { value: 'resource-tick' } });
    fireEvent.change(screen.getByLabelText(/Config/), { target: { value: '{ not json' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });

    expect(screen.getByRole('alert')).toHaveTextContent('Config is not valid JSON');
    expect(installEidoverseController).not.toHaveBeenCalled();
  });

  it('installs a controller with deliverEffects off by default, and shows it in the list after refresh', async () => {
    listEidoverseControllers
      .mockResolvedValueOnce(listing([]))
      .mockResolvedValueOnce(listing([install()]));
    installEidoverseController.mockResolvedValue({ outcome: 'installed', install: install(), reasons: [] });
    await renderPanel();

    fireEvent.change(screen.getByLabelText('Install id (lowercase slug)'), { target: { value: 'tide-beacon' } });
    fireEvent.change(screen.getByLabelText('Controller'), { target: { value: 'resource-tick' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Install' })); });

    expect(installEidoverseController).toHaveBeenCalledWith(expect.objectContaining({
      id: 'tide-beacon', controllerId: 'resource-tick', deliverEffects: false,
    }), { silent: true });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'tide-beacon' })).toBeInTheDocument());
  });

  it('arms and disarms an installed controller from the list', async () => {
    listEidoverseControllers.mockResolvedValue(listing([install()]));
    setEidoverseControllerArmed.mockResolvedValue({ outcome: 'updated', install: install({ armed: false }), reasons: [] });
    await renderPanel();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Disarm/ })); });

    expect(setEidoverseControllerArmed).toHaveBeenCalledWith('tide-beacon', false, { silent: true });
  });

  it('retires an installed controller only after a second confirming click', async () => {
    listEidoverseControllers.mockResolvedValue(listing([install()]));
    retireEidoverseController.mockResolvedValue({ outcome: 'retired', install: install(), reasons: [] });
    await renderPanel();

    fireEvent.click(screen.getByRole('button', { name: /Retire/ }));
    expect(retireEidoverseController).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm retire' })); });

    expect(retireEidoverseController).toHaveBeenCalledWith('tide-beacon', { silent: true });
  });
});
