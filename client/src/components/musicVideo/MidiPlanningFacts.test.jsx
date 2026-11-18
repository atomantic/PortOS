import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MidiPlanningFacts from './MidiPlanningFacts.jsx';

vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoMidiPlanning: vi.fn() }));
const api = await import('../../services/apiMusicVideo.js');

const project = (extra = {}) => ({ id: 'example-project', audioAnalysis: { sections: [{ startSec: 0, endSec: 12 }] }, ...extra });

describe('MidiPlanningFacts', () => {
  beforeEach(() => api.getMusicVideoMidiPlanning.mockReset());

  it('shows the exact song and section lines planning quotes from the transcription', async () => {
    api.getMusicVideoMidiPlanning.mockResolvedValue({ facts: {
      summary: 'Audio-to-MIDI transcription of the song: 2 parts',
      sections: [{ index: 0, label: 'Intro', startSec: 0, endSec: 12, facts: 'transcription: sparse; enters: pad' }],
    } });
    render(<MidiPlanningFacts project={project({ midiTranscription: { filename: 'example-midi.mid' } })} />);
    fireEvent.click(screen.getByText('What planning reads from the MIDI'));
    await waitFor(() => expect(screen.getByText('Audio-to-MIDI transcription of the song: 2 parts')).toBeInTheDocument());
    expect(screen.getByText(/transcription: sparse; enters: pad/)).toBeInTheDocument();
    expect(api.getMusicVideoMidiPlanning).toHaveBeenCalledWith('example-project', { silent: true });
  });

  it('renders nothing and asks nothing without a transcription', () => {
    const { container } = render(<MidiPlanningFacts project={project()} />);
    expect(container).toBeEmptyDOMElement();
    expect(api.getMusicVideoMidiPlanning).not.toHaveBeenCalled();
  });
});
