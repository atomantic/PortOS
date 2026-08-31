import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../ThemePickerPanel', () => ({
  default: () => <div>Theme picker</div>,
}));

import { getSettings, updateSettings } from '../../services/api';
import { GeneralTab } from './GeneralTab';

const SETTINGS = {
  timezone: 'UTC',
  location: { lat: 37.7749, lon: -122.4194 },
};
const CONFIRM = 'Discard your unsaved General settings changes?';

const timezoneCard = () => screen.getByRole('heading', { name: 'Timezone' }).parentElement;
const locationCard = () => screen.getByRole('heading', { name: 'Location' }).parentElement;

const renderTab = async ({ expectedTimezone = 'UTC' } = {}) => {
  const router = createMemoryRouter([
    { path: '/settings/general', element: <GeneralTab /> },
    { path: '/settings/security', element: <div>Security settings</div> },
  ], { initialEntries: ['/settings/general'] });
  render(<RouterProvider router={router} />);
  if (expectedTimezone === null) {
    await screen.findByLabelText('Timezone (IANA)');
  } else {
    await screen.findByDisplayValue(expectedTimezone);
  }
  return router;
};

const navigate = (router, to) => act(async () => { await router.navigate(to); });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(SETTINGS);
  updateSettings.mockResolvedValue({});
});

describe('GeneralTab unsaved changes', () => {
  it('guards edits made against the displayed fallback after loading fails', async () => {
    getSettings.mockRejectedValueOnce(new Error('settings offline'));
    const router = await renderTab({ expectedTimezone: null });
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });

    expect(within(timezoneCard()).getByText('Unsaved changes')).toBeInTheDocument();
    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  });

  it('ignores an older StrictMode load failure after the current load succeeds', async () => {
    const olderLoad = deferred();
    const currentLoad = deferred();
    getSettings
      .mockReturnValueOnce(olderLoad.promise)
      .mockReturnValueOnce(currentLoad.promise);
    const router = createMemoryRouter([
      { path: '/settings/general', element: <GeneralTab /> },
    ], { initialEntries: ['/settings/general'] });
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);

    await act(async () => { currentLoad.resolve(SETTINGS); });
    expect(await screen.findByDisplayValue('UTC')).toBeInTheDocument();
    await act(async () => { olderLoad.reject(new Error('stale settings request')); });

    expect(screen.queryByText('Unsaved changes')).toBeNull();
    expect(screen.getByLabelText('Timezone (IANA)')).toHaveValue('UTC');
    expect(screen.getByLabelText('Latitude (-90 to 90)')).toHaveValue(String(SETTINGS.location.lat));
  });

  it('marks each edited section dirty, arms beforeunload, and clears when values are restored', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await renderTab();

    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });
    expect(within(timezoneCard()).getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Timezone has unsaved changes' })).toBeInTheDocument();
    expect(within(locationCard()).queryByText('Unsaved changes')).toBeNull();

    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: '40.7128' },
    });
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Location has unsaved changes' })).toBeInTheDocument();
    await waitFor(() => {
      expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    });

    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: SETTINGS.timezone },
    });
    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: String(SETTINGS.location.lat) },
    });
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    await waitFor(() => {
      expect(remove.mock.calls.some(([type]) => type === 'beforeunload')).toBe(true);
    });
  });

  it('keeps the current route and draft when navigation is canceled', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByText(CONFIRM)).toBeNull());
    expect(router.state.location.pathname).toBe('/settings/general');
    expect(screen.getByLabelText('Timezone (IANA)')).toHaveValue('America/New_York');
  });

  it('discards the draft and runs the parked Settings navigation', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Longitude (-180 to 180)'), {
      target: { value: '-74.006' },
    });

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText('Security settings')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/security');
  });

  it('resets the draft when Settings preserves General across a stale tab route', async () => {
    const router = createMemoryRouter([
      { path: '/settings/:tab', element: <GeneralTab /> },
    ], { initialEntries: ['/settings/old-tab'] });
    render(<RouterProvider router={router} />);
    const timezoneInput = await screen.findByDisplayValue('UTC');
    fireEvent.change(timezoneInput, { target: { value: 'America/New_York' } });

    await navigate(router, '/settings/general');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/general'));
    expect(screen.getByLabelText('Timezone (IANA)')).toHaveValue('UTC');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('advances only the successful section baseline', async () => {
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.change(screen.getByLabelText('Latitude (-90 to 90)'), {
      target: { value: '40.7128' },
    });

    await act(async () => {
      fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));
    });
    expect(updateSettings).toHaveBeenCalledWith(
      { timezone: 'America/New_York' },
      { silent: true },
    );
    expect(within(timezoneCard()).queryByText('Unsaved changes')).toBeNull();
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await act(async () => {
      fireEvent.click(within(locationCard()).getByRole('button', { name: 'Save' }));
    });
    expect(updateSettings).toHaveBeenLastCalledWith(
      { location: { lat: 40.7128, lon: SETTINGS.location.lon } },
      { silent: true },
    );
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('locks each section during its save without hiding another section\'s discard prompt', async () => {
    const timezoneSave = deferred();
    const locationSave = deferred();
    updateSettings
      .mockReturnValueOnce(timezoneSave.promise)
      .mockReturnValueOnce(locationSave.promise);
    const router = await renderTab();
    const timezoneInput = screen.getByLabelText('Timezone (IANA)');
    const latitudeInput = screen.getByLabelText('Latitude (-90 to 90)');
    const longitudeInput = screen.getByLabelText('Longitude (-180 to 180)');
    fireEvent.change(timezoneInput, { target: { value: 'America/New_York' } });
    fireEvent.change(latitudeInput, { target: { value: '40.7128' } });

    fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));
    expect(timezoneInput).toBeDisabled();
    expect(latitudeInput).not.toBeDisabled();
    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    await act(async () => { timezoneSave.resolve({}); });
    fireEvent.click(within(locationCard()).getByRole('button', { name: 'Save' }));
    expect(latitudeInput).toBeDisabled();
    expect(longitudeInput).toBeDisabled();
    await navigate(router, '/settings/security');
    expect(screen.queryByText(CONFIRM)).toBeNull();
    await act(async () => { locationSave.resolve({}); });
    expect(await screen.findByText('Security settings')).toBeInTheDocument();
  });

  it('discards only the unsaved section while another section save is in flight', async () => {
    const timezoneSave = deferred();
    updateSettings.mockReturnValueOnce(timezoneSave.promise);
    const router = createMemoryRouter([
      { path: '/settings/:tab', element: <GeneralTab /> },
    ], { initialEntries: ['/settings/old-tab'] });
    render(<RouterProvider router={router} />);
    const timezoneInput = await screen.findByDisplayValue('UTC');
    const latitudeInput = screen.getByLabelText('Latitude (-90 to 90)');
    fireEvent.change(timezoneInput, { target: { value: 'America/New_York' } });
    fireEvent.change(latitudeInput, { target: { value: '40.7128' } });
    fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));

    await navigate(router, '/settings/general');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/general'));
    expect(timezoneInput).toHaveValue('America/New_York');
    expect(timezoneInput).toBeDisabled();
    expect(latitudeInput).toHaveValue(String(SETTINGS.location.lat));
    await act(async () => { timezoneSave.resolve({}); });
    expect(timezoneInput).toHaveValue('America/New_York');
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('keeps a failed timezone save dirty and guarded', async () => {
    updateSettings.mockRejectedValueOnce(new Error('timezone offline'));
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Timezone (IANA)'), {
      target: { value: 'America/New_York' },
    });

    await act(async () => {
      fireEvent.click(within(timezoneCard()).getByRole('button', { name: 'Save' }));
    });
    expect(within(timezoneCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  });

  it('keeps a failed location save dirty and guarded', async () => {
    updateSettings.mockRejectedValueOnce(new Error('location offline'));
    const router = await renderTab();
    fireEvent.change(screen.getByLabelText('Longitude (-180 to 180)'), {
      target: { value: '-74.006' },
    });

    await act(async () => {
      fireEvent.click(within(locationCard()).getByRole('button', { name: 'Save' }));
    });
    expect(within(locationCard()).getByText('Unsaved changes')).toBeInTheDocument();

    await navigate(router, '/settings/security');
    expect(screen.getByText(CONFIRM)).toBeInTheDocument();
  });
});
