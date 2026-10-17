import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FilmLookPanel from './FilmLookPanel.jsx';
import { filmLookPreset } from '../../lib/filmLook.js';
import { resetFilmLookPresetsCache } from '../../hooks/useFilmLookPresets.js';

const api = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../../services/apiSystem.js', () => api);

const scenes = [
  { sceneId: 'a', referenceImageId: 'a.png', sectionLabel: 'Intro' },
  { sceneId: 'b', referenceImageId: 'b.png', sectionLabel: 'Verse' },
  { sceneId: 'c' },
];

function Harness({ look = null, activeSceneId = null }) {
  const [project, setProject] = useState({ id: 'mv-example', scenes, filmLook: look });
  const apply = (patch) => setProject((current) => ({ ...current, ...patch }));
  return <FilmLookPanel project={project} activeSceneId={activeSceneId} onEditLocal={apply} onSave={apply} />;
}

beforeEach(() => {
  resetFilmLookPresetsCache();
  api.getSettings.mockReset().mockResolvedValue({ filmLookPresets: [] });
  api.updateSettings.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

it('previews the look on the selected shot still, and on any other shot picked from the sample list', async () => {
  render(<Harness look={filmLookPreset('polaroid')} activeSceneId="b" />);
  const sample = screen.getByLabelText('Sample');
  expect(sample).toHaveValue('b');
  // Shots without a still cannot be sampled.
  expect(within(sample).getAllByRole('option').map((option) => option.textContent)).toEqual(['Shot 1 · Intro', 'Shot 2 · Verse']);
  expect(screen.getByTestId('film-look-image')).toHaveAttribute('src', '/data/images/b.png');
  fireEvent.change(sample, { target: { value: 'a' } });
  expect(screen.getByTestId('film-look-image')).toHaveAttribute('src', '/data/images/a.png');
  await act(async () => {});
});

it('saves the current look under a name, reapplies it from its chip, and deletes it', async () => {
  const custom = { ...filmLookPreset('polaroid'), preset: 'custom', warmth: 0.5 };
  render(<Harness look={custom} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save as preset' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Warm dusk' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
  expect(api.updateSettings).toHaveBeenCalledTimes(1);
  const [saved] = api.updateSettings.mock.calls[0][0].filmLookPresets;
  expect(saved).toMatchObject({ label: 'Warm dusk', look: { preset: 'custom', warmth: 0.5 } });
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'VHS' }));
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Warm dusk' }));
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Delete saved look' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
  expect(api.updateSettings).toHaveBeenCalledTimes(2);
  expect(api.updateSettings.mock.calls[1][0]).toEqual({ filmLookPresets: [] });
  expect(screen.queryByRole('button', { name: 'Warm dusk' })).not.toBeInTheDocument();
});

it('puts the list back when the save is refused', async () => {
  const pending = Promise.withResolvers();
  api.updateSettings.mockReturnValueOnce(pending.promise);
  render(<Harness look={{ ...filmLookPreset('vhs'), preset: 'custom' }} />);
  try {
    fireEvent.click(await screen.findByRole('button', { name: 'Save as preset' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tape' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Tape' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => pending.reject(new Error('Refused')));
    expect(screen.queryByRole('button', { name: 'Tape' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as preset' })).toBeInTheDocument();
  } finally {
    await act(async () => pending.resolve({}));
  }
});

it('offers no save until the saved looks have been read, so a save never replaces looks it never saw', async () => {
  const kept = { id: 'kept-1', label: 'Kept', look: { ...filmLookPreset('polaroid'), preset: 'custom' } };
  const unavailable = Promise.withResolvers();
  const pending = Promise.withResolvers();
  api.getSettings.mockReturnValueOnce(unavailable.promise).mockReturnValueOnce(pending.promise);
  const first = render(<Harness look={{ ...filmLookPreset('vhs'), preset: 'custom' }} />);
  try {
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();
    await act(async () => unavailable.reject(new Error('Offline')));
    expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();
    first.unmount();

    // Starting the retry still does not mean its saved looks have rendered.
    render(<Harness look={{ ...filmLookPreset('vhs'), preset: 'custom' }} />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Save as preset' })).not.toBeInTheDocument();
    expect(api.updateSettings).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ filmLookPresets: [kept] }));
    expect(screen.getByRole('button', { name: 'Kept' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Save as preset' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tape' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings.mock.calls[0][0].filmLookPresets.map((preset) => preset.label)).toEqual(['Kept', 'Tape']);
  } finally {
    await act(async () => {
      unavailable.resolve({ filmLookPresets: [] });
      pending.resolve({ filmLookPresets: [kept] });
    });
  }
});
