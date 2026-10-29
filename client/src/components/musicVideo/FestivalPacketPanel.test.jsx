import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
const FESTIVAL_FIELDS = [{ id: 'title', label: 'Title', group: 'Film' }, { id: 'director', label: 'Director', group: 'Credits' }];
const FESTIVAL_NOTE_FIELDS = [{ id: 'name', label: 'Festival name' }];
const FESTIVAL_RIGHTS_LABELS = { rights: 'Rights status', musicRights: 'Music rights status', consent: 'Likeness / consent status' };
const emptyFestivalPacket = () => ({ version: 1, fields: {}, include: [], festivals: [], rights: 'unknown', musicRights: 'unknown', consent: 'unknown' });

const api = vi.hoisted(() => ({ getMusicVideoFestivalPacket: vi.fn(), saveMusicVideoFestivalPacket: vi.fn(), previewMusicVideoFestivalPacket: vi.fn() }));
const clipboard = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../lib/clipboard.js', () => ({ copyToClipboard: clipboard }));
vi.mock('../../lib/downloadBlob.js', () => ({ downloadBlob: download }));
import FestivalPacketPanel from './FestivalPacketPanel.jsx';

let stored;
const measured = { status: 'current', width: 1920, height: 1080, durationSec: 90 };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); stored = emptyFestivalPacket();
  api.getMusicVideoFestivalPacket.mockImplementation(async () => ({ packet: structuredClone(stored), fields: FESTIVAL_FIELDS, festivalFields: FESTIVAL_NOTE_FIELDS, rightsLabels: FESTIVAL_RIGHTS_LABELS,
    suggestions: [{ field: 'title', value: 'Source title', source: 'Project title' }], measurements: measured, assets: { render: true, still: false, poster: false, captions: false } }));
  api.saveMusicVideoFestivalPacket.mockImplementation(async (_id, packet) => { stored = structuredClone(packet); return { packet: structuredClone(stored) }; });
  api.previewMusicVideoFestivalPacket.mockImplementation(async (_id, packet) => ({ text: packet.include.includes('title') ? `Title: ${packet.fields.title}` : 'Festival packet: no fields selected', measurements: measured }));
});
const project = { id: 'mv-festival', renderHistoryId: 'render-a' };

describe('Festival packet editing and selected export', () => {
  it('requires explicit suggestions, saves/reopens edits and copies/downloads exactly the selected preview', async () => {
    const first = render(<FestivalPacketPanel project={project} />);
    await screen.findByLabelText('Title');
    expect(screen.getByLabelText('Title')).toHaveValue('');
    fireEvent.click(screen.getByText('Suggestions from project sources'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply Project title suggestion' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Source title');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Festival title' } });
    fireEvent.click(screen.getByLabelText('Include Title'));
    fireEvent.click(screen.getByRole('button', { name: 'Save festival packet' }));
    await waitFor(() => expect(screen.getByText('Packet saved')).toBeTruthy());
    first.unmount();
    const second = render(<FestivalPacketPanel project={project} />);
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue('Festival title'));
    expect(screen.getByLabelText('Rights status')).toHaveValue('unknown');
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected export' }));
    const preview = await screen.findByLabelText('Exact text to copy or download');
    expect(preview.value).toContain('Festival title');
    expect(preview.value).not.toContain('Director:');
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected packet' }));
    expect(clipboard).toHaveBeenCalledWith(preview.value);
    fireEvent.click(screen.getByRole('button', { name: 'Download selected packet' }));
    expect(download).toHaveBeenCalledWith(preview.value, 'festival-packet.txt', 'text/plain;charset=utf-8');
    await act(async () => { second.rerender(<FestivalPacketPanel project={{ ...project, renderHistoryId: 'render-b' }} />); });
    expect(screen.getByRole('button', { name: 'Copy selected packet' })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveValue('Festival title');
    await act(async () => { second.rerender(<FestivalPacketPanel project={project} />); });
    expect(screen.getByRole('button', { name: 'Copy selected packet' })).toBeDisabled();
  });

  it('drops an in-flight preview after switching renders away and back', async () => {
    let finishPreview;
    api.previewMusicVideoFestivalPacket.mockImplementationOnce(() => new Promise(resolve => { finishPreview = resolve; }));
    const view = render(<FestivalPacketPanel project={project} />);
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected export' }));
    await act(async () => { view.rerender(<FestivalPacketPanel project={{ ...project, renderHistoryId: 'render-b' }} />); });
    await act(async () => { view.rerender(<FestivalPacketPanel project={project} />); });
    await act(async () => { finishPreview({ text: 'Stale preview', measurements: measured }); });
    expect(screen.queryByLabelText('Exact text to copy or download')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy selected packet' })).toBeDisabled();
  });

  it('removes a festival note at the limit and saves the removal', async () => {
    stored.festivals = Array.from({ length: 50 }, (_, i) => ({ name: `Festival ${i + 1}`, include: false }));
    render(<FestivalPacketPanel project={project} />);
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByText('Festival-specific notes (50)'));
    expect(screen.getByRole('button', { name: 'Add festival notes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove festival 1 notes', exact: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add festival notes' })).toBeEnabled());
    expect(screen.getByText('Festival-specific notes (49)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save festival packet' }));
    await waitFor(() => expect(screen.getByText('Packet saved')).toBeTruthy());
    expect(stored.festivals).toHaveLength(49);
    expect(stored.festivals[0].name).toBe('Festival 2');
  });

  it('retains failed saves and invalidates export when fields or selection change', async () => {
    render(<FestivalPacketPanel project={project} />);
    await screen.findByLabelText('Title');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft' } });
    api.saveMusicVideoFestivalPacket.mockRejectedValueOnce(new Error('Save unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save festival packet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable');
    expect(screen.getByLabelText('Title')).toHaveValue('Draft');
    expect(screen.getByText('Unsaved packet changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview selected export' }));
    await screen.findByLabelText('Exact text to copy or download');
    fireEvent.click(screen.getByLabelText('Include Title'));
    expect(screen.getByRole('button', { name: 'Download selected packet' })).toBeDisabled();
  });
});
