/**
 * Music Video stage saves that apply the server's edit result (#16402): creative setup, style references,
 * visual spec, automation and lyric import each send one request carrying this tab's origin and patch the
 * board from its reply, with no follow-up `GET /:id`. The reply's readiness reaches the screen (the
 * "Changed since approval" notice), and a change from another tab still reloads through the socket.
 * Drives the real page through the shared scaffold in `test/musicVideoPageMocks.jsx`.
 */
import { describe, it, expect } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_ANALYZED,
  openProject,
  openSettings,
  pushSocket,
  editResult,
  installMusicVideoPageHooks,
} from '../../../test/musicVideoPageMocks.jsx';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import socket from '../../../services/socket.js';
import {
  getMusicVideoProject, updateMusicVideoProject, importMusicVideoLyrics, importMusicVideoTrackLyrics, analyzeMusicVideoProject,
  planMusicVideoProject, separateMusicVideoVocals,
} from '../../../services/apiMusicVideo.js';

installMusicVideoPageHooks();

const APPROVED = { readyForProduction: false, basis: {}, art: { approved: true, stale: null, problems: [] }, storyboard: { approved: false, problems: [] }, proof: { approved: false, problems: [] } };
const STALE = { ...APPROVED, art: { approved: true, stale: { approvedAt: '2026-01-01T00:00:00.000Z', changedFields: ['concept'] }, problems: [] } };
const WORD = 'Changed since approval';
const ORIGIN = { headers: { 'X-PortOS-Origin': 'tab-one' } };

const openWithOrigin = async (project, stage) => {
  socket.id = 'tab-one';
  await openProject(project, stage);
  // The first read of the board is not part of any save.
  await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalled());
  return getMusicVideoProject.mock.calls.length;
};
const reads = (baseline) => getMusicVideoProject.mock.calls.length - baseline;
// The saved reply: the changed fields and the readiness the server computed from them.
const reply = (project, changed) => ({ edit: editResult(project.scenes || [], [], { updatedAt: '2026-02-01T00:00:00.000Z', project: { ...changed, productionReadiness: STALE } }) });

describe('stage saves apply the edit result', () => {
  it('a visual-spec save sends one request with the tab origin and shows the readiness it answers with', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-spec', name: 'Spec project', productionReadiness: APPROVED,
      visualSpec: { references: [{ id: 'r0', imageId: 'harbor.png', role: 'mood', condition: false }] } };
    updateMusicVideoProject.mockImplementation(async () => reply(project, { visualSpec: { references: [{ id: 'r0', imageId: 'harbor.png', role: 'mood', condition: true }] } }));
    const baseline = await openWithOrigin(project, 'cast-sets');
    expect(screen.queryByText(WORD)).toBeNull();
    fireEvent.click(await screen.findByText('Mood board & other asset links'));
    fireEvent.click(screen.getAllByLabelText('Condition frames')[0]);
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-spec', { visualSpec: { references: [{ id: 'r0', imageId: 'harbor.png', role: 'mood', condition: true }] } }, { silent: true, edit: true, ...ORIGIN });
    expect((await screen.findAllByText(WORD)).length).toBeGreaterThan(0);
    expect(reads(baseline)).toBe(0);
    expect(screen.getAllByLabelText('Condition frames')[0]).toBeChecked();
  });

  it('a creative-setup save sends one request and shows the art notice from its reply', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-setup', name: 'Setup project', productionReadiness: APPROVED };
    updateMusicVideoProject.mockImplementation(async () => reply(project, { productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 } }));
    const baseline = await openWithOrigin(project, 'setup');
    await openSettings('Project');
    fireEvent.change(await screen.findByLabelText('Production strategy'), { target: { value: 'code-first' } });
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-setup', { productionPolicy: expect.objectContaining({ strategy: 'code-first' }) }, { silent: true, edit: true, ...ORIGIN });
    expect((await screen.findAllByText(WORD)).length).toBeGreaterThan(0);
    expect(reads(baseline)).toBe(0);
  });

  it('a style-reference save sends one request and shows the art notice from its reply', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-style', name: 'Style project', productionReadiness: APPROVED, styleReferences: [{ imageId: 'grain.png', caption: '' }] };
    updateMusicVideoProject.mockImplementation(async () => reply(project, { styleReferences: [{ imageId: 'grain.png', caption: 'Fine grain' }] }));
    const baseline = await openWithOrigin(project, 'cast-sets');
    fireEvent.click(await screen.findByText('Mood board & other asset links'));
    fireEvent.change(await screen.findByLabelText('Style caption 1'), { target: { value: 'Fine grain' } });
    fireEvent.click(screen.getByText('Save style uploads'));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-style', { styleReferences: [{ imageId: 'grain.png', caption: 'Fine grain' }] }, { silent: true, edit: true, ...ORIGIN });
    expect((await screen.findAllByText(WORD)).length).toBeGreaterThan(0);
    expect(reads(baseline)).toBe(0);
  });

  it('an automation save sends one request, with autonomous mode, and applies the reply', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-auto', name: 'Auto project', mediaMode: 'code-images-video', productionReadiness: APPROVED,
      automation: { tools: ['image:local'], guidance: 'g', budgetUsd: 5, checkins: { castAndSets: 'review' } } };
    updateMusicVideoProject.mockImplementation(async (_id, patch) => reply(project, { automation: patch.automation, mode: 'autonomous' }));
    const baseline = await openWithOrigin(project, 'setup');
    await openSettings('Project');
    fireEvent.click(await screen.findByLabelText('Local video gen'));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledTimes(1));
    expect(updateMusicVideoProject).toHaveBeenCalledWith('mv-auto', expect.objectContaining({
      mode: 'autonomous', automation: expect.objectContaining({ tools: ['image:local', 'video:local'] }),
    }), { silent: true, edit: true, ...ORIGIN });
    expect((await screen.findAllByText(WORD)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByLabelText('Local video gen')).toBeChecked());
    expect(reads(baseline)).toBe(0);
  });

  it('pasted lyrics import in one request and the cues come from the reply', async () => {
    const cues = [{ id: 'lc-1', text: 'first line', startSec: 1, endSec: 3 }];
    importMusicVideoLyrics.mockResolvedValue({ edit: editResult([], [], { updatedAt: '2026-02-01T00:00:00.000Z', project: { lyricCues: cues, lyricMarkers: [] } }), imported: 1, format: 'lrc' });
    const baseline = await openWithOrigin(PROJECT_ANALYZED, 'setup');
    fireEvent.change(screen.getByLabelText('Lyrics to import'), { target: { value: '[00:01.00]first line' } });
    fireEvent.click(screen.getByRole('button', { name: /^Import lyrics$/ }));
    expect(await screen.findByLabelText('Line 1 text')).toHaveValue('first line');
    expect(importMusicVideoLyrics).toHaveBeenCalledTimes(1);
    expect(importMusicVideoLyrics).toHaveBeenCalledWith('mv-3', expect.any(Object), { silent: true, edit: true, ...ORIGIN });
    expect(reads(baseline)).toBe(0);
  });

  it('"Use track lyrics" imports in one request and the cues come from the reply', async () => {
    const project = { ...PROJECT_ANALYZED, trackId: 'track-1' };
    const cues = [{ id: 'lc-1', text: 'sung line', startSec: 1, endSec: 3 }];
    importMusicVideoTrackLyrics.mockResolvedValue({ edit: editResult([], [], { updatedAt: '2026-02-01T00:00:00.000Z', project: { lyricCues: cues, lyricMarkers: [] } }), imported: 1, markers: 0, skipped: null });
    const baseline = await openWithOrigin(project, 'setup');
    fireEvent.click(await screen.findByRole('button', { name: /Use track lyrics/ }));
    expect(await screen.findByLabelText('Line 1 text')).toHaveValue('sung line');
    expect(importMusicVideoTrackLyrics).toHaveBeenCalledTimes(1);
    expect(importMusicVideoTrackLyrics).toHaveBeenCalledWith('mv-3', { mode: 'replace' }, { silent: true, edit: true, ...ORIGIN });
    expect(reads(baseline)).toBe(0);
  });

  it('the autopilot kickoff carries the imported cues forward from the edit result', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-kick', name: 'Kick project', trackId: 'track-1', lyricCues: [], scenes: [], castAndSets: { status: 'skipped' }, automation: { tools: ['image:local'], guidance: '', budgetUsd: null } };
    const cues = [{ id: 'lc-1', text: 'sung line', startSec: 1, endSec: 3 }];
    analyzeMusicVideoProject.mockResolvedValue(project);
    importMusicVideoTrackLyrics.mockResolvedValue({ edit: editResult([], [], { updatedAt: '2026-02-01T00:00:00.000Z', project: { lyricCues: cues, lyricMarkers: [] } }), imported: 1, markers: 0, skipped: null });
    planMusicVideoProject.mockResolvedValue({ project, scenesAdded: 1, promptsSeeded: true });
    await openWithOrigin(project);
    await openSettings('Autopilot');
    fireEvent.click(screen.getByRole('button', { name: /Analyze & plan/ }));
    // Cues now exist on the kickoff's copy, so it moves on to separating the vocal.
    await waitFor(() => expect(separateMusicVideoVocals).toHaveBeenCalled());
    expect(importMusicVideoTrackLyrics).toHaveBeenCalledWith('mv-kick', { mode: 'if-empty' }, { silent: true, edit: true, ...ORIGIN });
  });

  it('a change made in another tab still reloads the open project', async () => {
    const project = { ...PROJECT_ANALYZED, id: 'mv-other', name: 'Other tab project' };
    const baseline = await openWithOrigin(project, 'cast-sets');
    await pushSocket('music-video:project:changed', { id: 'mv-other', origin: 'tab-two' });
    await waitFor(() => expect(reads(baseline)).toBe(1));
    // This tab's own write is skipped.
    await pushSocket('music-video:project:changed', { id: 'mv-other', origin: 'tab-one' });
    expect(reads(baseline)).toBe(1);
  });
});
