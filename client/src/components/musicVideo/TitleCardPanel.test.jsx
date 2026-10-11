import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const api = vi.hoisted(() => ({ getMusicVideoPublishPlatforms: vi.fn() }));
vi.mock('../../services/apiMusicVideo.js', () => api);

import TitleCardPanel from './TitleCardPanel.jsx';

const base = {
  id: 'mv-1', name: 'Example Song v2', composition: { mode: 'document' },
  lyricCues: [{ id: 'l1', text: 'first line', startSec: 7, endSec: 9 }],
};

// The board's local edit + save, as MusicVideo.jsx wires them.
function Harness({ initial, onSave }) {
  const [project, setProject] = useState(initial);
  return <TitleCardPanel project={project} onEditLocal={(patch) => setProject((p) => ({ ...p, ...patch }))} onSave={onSave} onPreview={() => {}} />;
}

beforeEach(() => {
  api.getMusicVideoPublishPlatforms.mockReset();
  api.getMusicVideoPublishPlatforms.mockResolvedValue({ distrokid: { enabled: true, account: 'Example Artist' } });
});

describe('TitleCardPanel', () => {
  it('turns on prefilled with the song title, the DistroKid artist, this year and a window ending before the first sung line', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<Harness initial={base} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText(/Off/));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].titleCard).toMatchObject({
      enabled: true, title: 'Example Song', artist: 'Example Artist', year: String(new Date().getFullYear()), startSec: 1.5, endSec: 6.5, position: 'lower-left',
    });
    expect(await screen.findByLabelText('Song title')).toHaveValue('Example Song');
    expect(screen.queryByText(/A sung line starts/)).toBeNull();
  });

  it('flags a sung line under the card and ends the card before it in one tap', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<Harness initial={{ ...base, titleCard: { enabled: true, title: 'Example Song', startSec: 2, endSec: 10 } }} onSave={onSave} />);
    expect(screen.getByText(/A sung line starts at 0:07 /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'end it at 0:06.5' }));
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ startSec: 2, endSec: 6.5 }) });
    expect(screen.queryByText(/A sung line starts/)).toBeNull();
  });

  it('keeps the text when switched off and saves typed edits on blur', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<Harness initial={{ ...base, titleCard: { enabled: true, title: 'Example Song', startSec: 1, endSec: 5 } }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1984' } });
    fireEvent.blur(screen.getByLabelText('Year'));
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ year: '1984' }) });
    fireEvent.click(screen.getByLabelText(/Live in the preview/));
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ enabled: false, title: 'Example Song', year: '1984' }) });
    expect(screen.queryByLabelText('Song title')).toBeNull();
  });
});
