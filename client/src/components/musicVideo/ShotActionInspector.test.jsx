import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TreatmentShotList from './TreatmentShotList.jsx';
import SceneCard from './SceneCard.jsx';

vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({ src: null }) }));

const contract = { version: 1, purpose: 'The listener decides to stay', startEmotion: 'distrust', endEmotion: 'resolve', activeSpeaker: 'Singer',
  actions: [{ startSec: 0, endSec: 1, subject: 'Singer', description: 'Offers a hand' }],
  reactions: [{ startSec: 1, endSec: 2, subject: 'Listener', description: 'Turns back' }],
  continuityRequirements: ['Both people remain visible'], acceptanceCriteria: ['The listener visibly changes their decision'],
};
const scene = { sceneId: 's', label: 'Example shot', startSec: 10, endSec: 14, prompt: '', direction: { actionContract: contract }, takes: [] };
const treatment = { arc: { beats: [] }, shotDirections: [{ sceneId: 's', mode: 'cutaway', route: 'generated', typographyRole: 'none', negativeSpace: 'none', actionContract: contract }] };

// Regression: intent was neither inspectable beside the preview nor editable as a validated treatment contract.
describe('shot intent in the treatment and scene board', () => {
  it('shows action, reaction and acceptance beside the shot preview', () => {
    render(<SceneCard scene={scene} index={0} isLast onEditLocal={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText(/Singer: Offers a hand/)).toBeTruthy();
    expect(screen.getByText(/Listener: Turns back/)).toBeTruthy();
    expect(screen.getByText(/Both people remain visible/)).toBeTruthy();
    expect(screen.getByText(/The listener visibly changes their decision/)).toBeTruthy();
    expect(screen.queryByText('Edit shot intent')).toBeNull();
  });

  it('rejects impossible times locally, saves the complete intent once and supports explicit clearing', async () => {
    const onSave = vi.fn(async () => treatment);
    render(<TreatmentShotList project={{ id: 'p', scenes: [scene] }} treatment={treatment} onSave={onSave} />);
    fireEvent.click(screen.getByText('Edit shot intent'));
    fireEvent.change(screen.getAllByLabelText('End (s)')[1], { target: { value: '9' } });
    fireEvent.click(screen.getByText('Save shot intent'));
    expect(screen.getByRole('alert').textContent).toContain('must fit inside');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getAllByLabelText('End (s)')[1], { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'The listener chooses to return' } });
    fireEvent.click(screen.getByText('Save shot intent'));
    await waitFor(() => expect(screen.queryByText('Save shot intent')).toBeNull());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ shotDirections: [{ sceneId: 's', actionContract: { ...contract, purpose: 'The listener chooses to return' } }] });
    fireEvent.click(screen.getByText('Edit shot intent'));
    fireEvent.click(screen.getByText('Clear shot intent'));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ shotDirections: [{ sceneId: 's', actionContract: null }] }));
  });
});
