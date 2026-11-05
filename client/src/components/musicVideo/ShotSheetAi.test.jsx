import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ShotSheetAi from './ShotSheetAi.jsx';
import { proposeMusicVideoShotSheet } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ proposeMusicVideoShotSheet: vi.fn() }));
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({ providers: [], selectedProviderId: 'p1', selectedModel: '', availableModels: [], loading: false, setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector.jsx', () => ({ default: () => null }));
vi.mock('../media/SentPromptPanel.jsx', () => ({ default: () => null }));

const row = (sceneId, label, shotSheet, extra = {}) => ({ scene: { sceneId, label, shotSheet, framePrompt: 'Old frame', prompt: 'Old motion', ...extra }, sheet: shotSheet || {} });
const projectOf = (rows) => ({ id: 'p', cameras: [{ id: 'vhs', name: 'VHS', kind: 'in-world' }], scenes: rows.map((entry) => entry.scene) });
beforeEach(() => vi.clearAllMocks());

describe('ShotSheetAi', () => {
  // Catches a backfill overwriting the director's work, saving before review, or sending checked shots.
  it('proposes only empty columns on unchecked shots and saves only on Apply', async () => {
    proposeMusicVideoShotSheet.mockResolvedValue({ shots: [{ sceneId: 'a', sheet: { emotion: 'AI emotion', location: 'Street', cameraId: 'vhs' } }] });
    const onApply = vi.fn(async () => true);
    const rows = [row('a', 'Shot 1', { emotion: 'My emotion' }), row('b', 'Shot 2', { checked: true, emotion: 'Done' })];
    render(<ShotSheetAi project={projectOf(rows)} disabled={false} onApply={onApply} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Fill empty columns from prompts \(1 unchecked\)/ }));
    await screen.findByLabelText('Apply Shot 1');
    expect(proposeMusicVideoShotSheet.mock.calls[0][1]).toMatchObject({ direction: 'from-prompts', sceneIds: ['a'] });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByText('AI emotion')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('a', { shotSheet: { emotion: 'My emotion', location: 'Street', cameraId: 'vhs' } }));
  });

  // Catches the director's edit to a proposal being lost, or a deselected shot being saved.
  it('applies the director’s edit of a proposed prompt and skips deselected shots', async () => {
    proposeMusicVideoShotSheet.mockResolvedValue({ shots: [{ sceneId: 'a', prompt: 'AI motion' }, { sceneId: 'b', framePrompt: 'AI frame' }] });
    const onApply = vi.fn(async () => true);
    const rows = [row('a', 'Shot 1', { checked: true }), row('b', 'Shot 2', { checked: true })];
    render(<ShotSheetAi project={projectOf(rows)} disabled={false} onApply={onApply} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Propose prompts from sheet \(2 checked\)/ }));
    const motion = await screen.findByLabelText('Shot 1 Motion prompt proposed');
    expect(proposeMusicVideoShotSheet.mock.calls[0][1].direction).toBe('to-prompts');
    expect(screen.getByText('Old motion')).toBeInTheDocument();
    fireEvent.change(motion, { target: { value: 'My motion' } });
    fireEvent.click(screen.getByLabelText('Apply Shot 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 selected' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith('a', { prompt: 'My motion' });
  });

  // Catches a long video being sent in one request, or an earlier batch's work being lost when a later one fails.
  it('sends batches and keeps earlier results when a batch fails', async () => {
    const rows = Array.from({ length: 16 }, (_, at) => row(`s${at}`, `Shot ${at + 1}`, {}));
    proposeMusicVideoShotSheet.mockResolvedValueOnce({ shots: [{ sceneId: 's0', sheet: { emotion: 'Joy' } }] }).mockRejectedValueOnce(new Error('Provider down'));
    render(<ShotSheetAi project={projectOf(rows)} disabled={false} onApply={vi.fn()} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Fill empty columns/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider down');
    expect(proposeMusicVideoShotSheet.mock.calls[0][1].sceneIds).toHaveLength(15);
    expect(proposeMusicVideoShotSheet.mock.calls[1][1].sceneIds).toEqual(['s15']);
    expect(screen.getByLabelText('Apply Shot 1')).toBeChecked();
  });

  // Catches a stale proposal overwriting what the director did while it waited, or a filtered-out shot being skipped.
  it('merges a backfill against the shot as it is at Apply', async () => {
    proposeMusicVideoShotSheet.mockResolvedValue({ shots: [
      { sceneId: 'a', sheet: { location: 'AI street', emotion: 'Joy' } },
      { sceneId: 'b', sheet: { location: 'AI lot' } },
    ] });
    const onApply = vi.fn(async () => true);
    const rows = [row('a', 'Shot 1', {}), row('b', 'Shot 2', {})];
    const { rerender } = render(<ShotSheetAi project={projectOf(rows)} disabled={false} onApply={onApply} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Fill empty columns/ }));
    await screen.findByText('AI street');
    const edited = [row('a', 'Shot 1', { location: 'Director house', checked: true }), row('b', 'Shot 2', { location: 'Director lot' })];
    rerender(<ShotSheetAi project={projectOf(edited)} disabled={false} onApply={onApply} rows={[]} />);
    expect(screen.queryByText('AI street')).not.toBeInTheDocument();
    expect(screen.getByText('Joy')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 selected' }));
    await waitFor(() => expect(screen.queryByLabelText('Apply Shot 1')).not.toBeInTheDocument());
    expect(onApply.mock.calls).toEqual([['a', { shotSheet: { location: 'Director house', checked: true, emotion: 'Joy' } }]]);
  });

  // Catches a later batch's arrival discarding what the director changed in an earlier one.
  it('keeps an edit to an earlier batch when a later batch arrives', async () => {
    const rows = Array.from({ length: 16 }, (_, at) => row(`s${at}`, `Shot ${at + 1}`, { checked: true }));
    let finishSecond;
    proposeMusicVideoShotSheet.mockResolvedValueOnce({ shots: [{ sceneId: 's0', prompt: 'AI one' }] })
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve; }));
    render(<ShotSheetAi project={projectOf(rows)} disabled={false} onApply={vi.fn()} rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: /Propose prompts/ }));
    fireEvent.change(await screen.findByLabelText('Shot 1 Motion prompt proposed'), { target: { value: 'My one' } });
    finishSecond({ shots: [{ sceneId: 's15', prompt: 'AI two' }] });
    await screen.findByLabelText('Shot 16 Motion prompt proposed');
    expect(screen.getByLabelText('Shot 1 Motion prompt proposed')).toHaveValue('My one');
  });
});
