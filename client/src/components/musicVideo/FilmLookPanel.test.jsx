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
  await waitFor(() => expect(api.getSettings).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Warm dusk' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1));
  const [saved] = api.updateSettings.mock.calls[0][0].filmLookPresets;
  expect(saved).toMatchObject({ label: 'Warm dusk', look: { preset: 'custom', warmth: 0.5 } });
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'VHS' }));
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Warm dusk' }));
  expect(screen.getByRole('button', { name: 'Warm dusk' })).toHaveAttribute('aria-pressed', 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Delete saved look' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
  expect(api.updateSettings.mock.calls[1][0]).toEqual({ filmLookPresets: [] });
  expect(screen.queryByRole('button', { name: 'Warm dusk' })).not.toBeInTheDocument();
});

it('puts the list back when the save is refused', async () => {
  api.updateSettings.mockRejectedValueOnce(new Error('Refused'));
  render(<Harness look={{ ...filmLookPreset('vhs'), preset: 'custom' }} />);
  await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tape' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Tape' })).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Save as preset' })).toBeInTheDocument();
});
