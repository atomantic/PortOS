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

  it('re-enables the switch when the first save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('offline'));
    render(<Harness initial={base} onSave={onSave} />);
    const toggle = screen.getByLabelText(/Off/);
    fireEvent.click(toggle);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Live in the preview/ })).not.toBeDisabled());
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

  it('switches to the classic MTV lower third and offers its bar colour', () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<Harness initial={{ ...base, titleCard: { enabled: true, title: 'Example Song', startSec: 1, endSec: 5 } }} onSave={onSave} />);
    expect(screen.queryByLabelText('Bar')).toBeNull();
    fireEvent.change(screen.getByLabelText('Look'), { target: { value: 'mtv' } });
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ style: 'mtv', title: 'Example Song' }) });
    expect(screen.getByLabelText('Bar')).toBeInTheDocument();
  });

  it('optionally shows the card again at the end, timed from the song length', () => {
    const onSave = vi.fn().mockResolvedValue({});
    const card = { enabled: true, title: 'Example Song', startSec: 2, endSec: 6 };
    const { unmount } = render(<Harness initial={{ ...base, titleCard: card }} onSave={onSave} />);
    expect(screen.getByLabelText(/Also at the end/)).toBeDisabled();
    unmount();
    render(<Harness initial={{ ...base, audioAnalysis: { durationSec: 200 }, titleCard: card }} onSave={onSave} />);
    const outro = screen.getByLabelText(/Also at the end · Optional/);
    expect(outro).not.toBeChecked();
    expect(screen.queryByLabelText('End in (s)')).toBeNull();
    fireEvent.click(outro);
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ outro: true, outroStartSec: 195, outroEndSec: 199 }) });
    expect(screen.getByLabelText('End in (s)')).toHaveValue(195);
    fireEvent.change(screen.getByLabelText('End out (s)'), { target: { value: '198' } });
    fireEvent.blur(screen.getByLabelText('End out (s)'));
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ outroStartSec: 195, outroEndSec: 198 }) });
  });

  it('picks a font from swatches drawn in each face', () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<Harness initial={{ ...base, titleCard: { enabled: true, title: 'Example Song', startSec: 1, endSec: 5 } }} onSave={onSave} />);
    const pacifico = screen.getByRole('radio', { name: 'Pacifico' });
    expect(pacifico.style.fontFamily).toContain('MV Title Pacifico');
    fireEvent.click(pacifico);
    expect(onSave).toHaveBeenLastCalledWith({ titleCard: expect.objectContaining({ font: 'pacifico' }) });
    expect(screen.getByRole('radio', { name: 'Pacifico' })).toHaveAttribute('aria-checked', 'true');
  });
});
