/**
 * Music Video page routing and shell: project load and index, the header and
 * picker, deep links and stage routing, the header's next action, the docked
 * preview and the attention row. Each step's own wiring is covered beside its
 * container in `components/musicVideo/stages/use*StageWiring.test.jsx`.
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
// The scaffold registers the mocks, so it loads before any mocked module.
import {
  PROJECT_WITH_CLIP,
  providerModelsState,
  PROJECT_NO_CLIP,
  pushSocket,
  PROJECT_ANALYZED,
  MV_ROUTES,
  renderMV,
  settle,
  selectProject,
  STAGE_TABS,
  openSettings,
  closeSettings,
  openStage,
  openProject,
  LocationProbe,
  NavTo,
  installMusicVideoPageHooks,
} from '../test/musicVideoPageMocks.jsx';
import { MUSIC_VIDEO_STAGES } from '../lib/musicVideoStages.js';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { createMusicVideoProject, startAutonomousMusicVideo, listMusicVideoProjects, listMusicVideoProjectSummaries, listMusicVideoProjectVersions, cloneMusicVideoProject, renderMusicVideoProject, planMusicVideoProject, updateMusicVideoProject, updateMusicVideoScene, deleteMusicVideoProject, analyzeMusicVideoProject, importMusicVideoTrackLyrics, getMusicVideoProject, resumeMusicVideoRevision, cancelMusicVideoRevision, approveMusicVideoCastAndSets, stopMusicVideoProduction, buildMusicVideoPublishKit, getMusicVideoCatalogCompletion } from '../services/apiMusicVideo.js';
import { listTracks } from '../services/apiTracks.js';

import toast from '../components/ui/Toast';
import socket from '../services/socket';

installMusicVideoPageHooks();
beforeAll(async () => {
  // Keep cold Vite transforms out of interaction waits on a loaded test host.
  await Promise.all([
    import('../components/musicVideo/ProjectWorkspace.jsx'),
    import('../components/musicVideo/stages/ReviewStage.jsx'),
  ]);
});

describe('MusicVideo project load recovery (#9761)', () => {
  it.each(['/music-video', '/music-video/mv-2/board'])('keeps failures visible and recovers without changing %s', async (path) => {
    let resolveRetry;
    listMusicVideoProjects
      .mockRejectedValueOnce(new Error('Connection unavailable'))
      .mockRejectedValueOnce(new Error('Still unavailable'))
      .mockImplementationOnce(() => new Promise(resolve => { resolveRetry = resolve; }));
    render(
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Connection unavailable');
    expect(screen.queryByText(/No projects in progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(path);
    if (path === '/music-video') {
      expect(listMusicVideoProjectSummaries).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 30 }),
        expect.objectContaining({ silent: true }),
      );
    } else {
      expect(getMusicVideoProject).toHaveBeenCalledWith('mv-2', { silent: true });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Still unavailable'));
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    fireEvent.click(retry);
    expect(path === '/music-video' ? listMusicVideoProjectSummaries : getMusicVideoProject).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/No projects in progress/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();

    await act(async () => resolveRetry([PROJECT_NO_CLIP]));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(path);
    if (path === '/music-video') {
      expect(screen.getByTestId('mv-project-grid')).toHaveTextContent(PROJECT_NO_CLIP.name);
    } else {
      // The workspace is its own chunk (#16565), so it renders once that import settles.
      expect(await screen.findByRole('heading', { level: 2, name: PROJECT_NO_CLIP.name })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^Storyboard/ })).toHaveAttribute('aria-selected', 'true');
    }
  });

  it.each([
    ['/music-video', /No projects in progress/],
    ['/music-video/missing-project', /Project not found/],
  ])('shows absence only after a successful read at %s', async (path, message) => {
    listMusicVideoProjects.mockResolvedValue(path === '/music-video' ? [] : [PROJECT_NO_CLIP]);
    render(<MemoryRouter initialEntries={[path]}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('MusicVideo project status filter', () => {
  it('moves a Blender project out of Completed when its on-disk film becomes stale', async () => {
    const completed = { ...PROJECT_NO_CLIP, status: 'complete', isCompleted: true, renderHistoryId: 'final', composition: { mode: 'blender' } };
    const stale = { ...completed, isCompleted: false };
    let current = completed;
    listMusicVideoProjectSummaries.mockImplementation(async ({ statusFilter }) => {
      const items = !statusFilter || current.isCompleted === (statusFilter === 'completed') ? [current] : [];
      return { items, total: items.length, nextCursor: null };
    });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    await screen.findByRole('heading', { name: completed.name });
    current = stale;
    getMusicVideoProject.mockResolvedValue({ ...stale, isCompleted: undefined, renderDependencyState: { status: 'stale' } });
    await pushSocket('music-video:blender', { projectId: completed.id, kind: 'state' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: completed.name })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }));
    expect(await screen.findByRole('heading', { name: completed.name })).toBeInTheDocument();
  });

  it('does not trust an unpresented run event to reclassify a stale project', async () => {
    const stale = { ...PROJECT_NO_CLIP, status: 'complete', isCompleted: false, renderHistoryId: 'final', composition: { mode: 'blender' } };
    listMusicVideoProjectSummaries.mockResolvedValue({ items: [stale], total: 1, nextCursor: null });
    getMusicVideoProject.mockResolvedValue({ ...stale, isCompleted: undefined, renderDependencyState: { status: 'stale' } });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { name: stale.name });
    await pushSocket('music-video:production', { projectId: stale.id, project: { ...stale, isCompleted: undefined } });
    await waitFor(() => expect(getMusicVideoProject).toHaveBeenCalledWith(stale.id, { silent: true }));
    expect(screen.getByRole('heading', { name: stale.name })).toBeInTheDocument();
  });

  it('reconciles an unlisted Blender project as it enters, leaves, and re-enters', async () => {
    const listed = { ...PROJECT_WITH_CLIP, id: 'mv-listed', name: 'Listed', status: 'complete', isCompleted: true };
    const hidden = { ...PROJECT_NO_CLIP, id: 'mv-hidden', name: 'Hidden', status: 'complete', isCompleted: false };
    let projects = [listed, hidden];
    listMusicVideoProjectSummaries.mockImplementation(async ({ statusFilter }) => {
      const items = projects.filter((p) => !statusFilter || p.isCompleted === (statusFilter === 'completed'));
      return { items, total: items.length, nextCursor: null };
    });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    await screen.findByRole('heading', { name: listed.name });
    projects = [listed, { ...hidden, isCompleted: true }];
    getMusicVideoProject.mockResolvedValue({ ...hidden, isCompleted: undefined, renderDependencyState: { status: 'current' } });
    await pushSocket('music-video:blender', { projectId: hidden.id, kind: 'state' });
    expect(await screen.findByRole('heading', { name: hidden.name })).toBeInTheDocument();
    const calls = listMusicVideoProjectSummaries.mock.calls.length;
    await pushSocket('music-video:blender', { projectId: hidden.id, kind: 'state' });
    await waitFor(() => expect(getMusicVideoProject.mock.calls.filter(([id]) => id === hidden.id)).toHaveLength(2));
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledTimes(calls);
    projects = [listed, hidden];
    getMusicVideoProject.mockResolvedValue({ ...hidden, isCompleted: undefined, renderDependencyState: { status: 'stale' } });
    await pushSocket('music-video:blender', { projectId: hidden.id, kind: 'state' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: hidden.name })).not.toBeInTheDocument());
    projects = [listed, { ...hidden, isCompleted: true }];
    getMusicVideoProject.mockResolvedValue({ ...hidden, isCompleted: undefined, renderDependencyState: { status: 'current' } });
    await pushSocket('music-video:blender', { projectId: hidden.id, kind: 'state' });
    expect(await screen.findByRole('heading', { name: hidden.name })).toBeInTheDocument();
  });

  it('batches linked catalog updates, adds an unlisted match and removes a match from a loaded later page', async () => {
    const first = { ...PROJECT_WITH_CLIP, id: 'mv-first', name: 'First Page' };
    const second = { ...PROJECT_NO_CLIP, id: 'mv-second', name: 'Second Page', status: 'complete', isCompleted: false };
    const kept = { ...first, id: 'mv-kept', name: 'Kept Page' };
    const hidden = { ...second, id: 'mv-hidden', name: 'Previously Completed', isCompleted: true };
    let projects = [hidden, first, second, kept];
    listMusicVideoProjectSummaries.mockImplementation(async ({ cursor, statusFilter }) => {
      const matching = projects.filter(project => !statusFilter || project.isCompleted !== true);
      const offset = Number(cursor ?? 0);
      return { items: matching.slice(offset, offset + 1), total: matching.length,
        nextCursor: offset + 1 < matching.length ? String(offset + 1) : null };
    });
    const filteredReads = () => listMusicVideoProjectSummaries.mock.calls.filter(([args]) => args.statusFilter);
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { name: first.name });
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    await screen.findByRole('heading', { name: second.name });
    fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
    await screen.findByRole('heading', { name: kept.name });
    const reads = filteredReads().length;

    const unrelated = vi.fn(async () => []);
    getMusicVideoCatalogCompletion.mockImplementationOnce(unrelated);
    await pushSocket('catalog:assets-changed', { ingredientId: 'cat-unrelated' });
    await waitFor(() => expect(unrelated).toHaveBeenCalledTimes(1));
    expect(filteredReads()).toHaveLength(reads);

    const entering = { ...hidden, isCompleted: false };
    const leaving = { ...second, isCompleted: true };
    projects = [entering, first, leaving, kept];
    const completionRead = vi.fn(async () => [entering, leaving]);
    getMusicVideoCatalogCompletion.mockImplementationOnce(completionRead);
    await act(async () => {
      await pushSocket('catalog:assets-changed', { ingredientId: 'cat-first' });
      await pushSocket('catalog:primitive-changed', { ingredientId: 'cat-first' });
      await pushSocket('catalog:assets-changed', { ingredientId: 'cat-second' });
    });
    expect(await screen.findByRole('heading', { name: entering.name })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: leaving.name })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: kept.name })).toBeInTheDocument();
    expect(completionRead).toHaveBeenCalledExactlyOnceWith(['cat-first', 'cat-second'], expect.objectContaining({ silent: true }));
    expect(filteredReads()).toHaveLength(reads + 1);
    expect(getMusicVideoProject).not.toHaveBeenCalled();
  });

  it('keeps the grid on a failed catalog lookup and retries the same ingredients', async () => {
    const completed = { ...PROJECT_NO_CLIP, status: 'complete', isCompleted: true };
    const stale = { ...completed, isCompleted: false };
    let current = completed;
    listMusicVideoProjectSummaries.mockImplementation(async ({ statusFilter }) => {
      const items = !statusFilter || current.isCompleted === (statusFilter === 'completed') ? [current] : [];
      return { items, total: items.length, nextCursor: null };
    });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    await screen.findByRole('heading', { name: completed.name });
    current = stale;
    getMusicVideoCatalogCompletion.mockRejectedValueOnce(new Error('Catalog temporarily unavailable')).mockResolvedValueOnce([stale]);
    await pushSocket('catalog:assets-changed', { ingredientId: 'cat-temporary' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Catalog temporarily unavailable');
    expect(screen.getByRole('heading', { name: completed.name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await screen.findByText('No completed projects.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: completed.name })).not.toBeInTheDocument();
    expect(getMusicVideoCatalogCompletion.mock.calls.map(([ids]) => ids)).toEqual([['cat-temporary'], ['cat-temporary']]);
  });

  it('keeps index options available while the unfiltered picker loads', async () => {
    let resolvePicker;
    listMusicVideoProjectSummaries.mockImplementation(({ statusFilter }) => statusFilter
      ? Promise.resolve({ items: [PROJECT_WITH_CLIP], total: 1, nextCursor: null })
      : new Promise(resolve => { resolvePicker = resolve; }));
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { name: PROJECT_WITH_CLIP.name });
    const picker = screen.getByLabelText('Project');
    expect(within(picker).getByRole('option', { name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
    fireEvent.focus(picker);
    expect(within(picker).getByRole('option', { name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
    await act(async () => resolvePicker({ items: [PROJECT_WITH_CLIP, { ...PROJECT_NO_CLIP, status: 'complete' }], total: 2, nextCursor: null }));
    expect(within(picker).getByRole('option', { name: PROJECT_NO_CLIP.name })).toBeInTheDocument();
  });

  it('filters before paging, switches accessible controls, and opens the selected project', async () => {
    const projects = [
      { ...PROJECT_WITH_CLIP, name: 'Working', status: 'ready' },
      { ...PROJECT_NO_CLIP, name: 'Finished', status: 'complete' },
      { ...PROJECT_NO_CLIP, id: 'mv-failed', name: 'Failed', status: 'failed' },
    ];
    listMusicVideoProjectSummaries.mockImplementation(async ({ statusFilter }) => {
      const items = projects.filter(p => !statusFilter || (p.status === 'complete') === (statusFilter === 'completed'));
      return { items, total: items.length, nextCursor: null };
    });
    getMusicVideoProject.mockImplementation(async id => projects.find(p => p.id === id));
    render(<MemoryRouter initialEntries={['/music-video']}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Working' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In Progress', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Failed' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Finished' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(await screen.findByRole('heading', { name: 'Finished' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Completed', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Working' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(await screen.findByRole('heading', { name: 'Working' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finished' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('mv-project-card-mv-2')).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-2'));
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
  });
});

describe('MusicVideo name search spans every page (#16651)', () => {
  const alpha = { ...PROJECT_WITH_CLIP, id: 'mv-alpha', name: 'Alpha', status: 'ready' };
  const later = { ...PROJECT_NO_CLIP, id: 'mv-later', name: 'Zebra Finale', status: 'ready' };
  const done = { ...PROJECT_NO_CLIP, id: 'mv-done', name: 'Zebra Archive', status: 'complete' };
  const mockServer = () => listMusicVideoProjectSummaries.mockImplementation(async ({ statusFilter, q }) => {
    const items = [alpha, later, done]
      .filter(p => !statusFilter || (p.status === 'complete') === (statusFilter === 'completed'))
      .filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()));
    // Without a query only the first page (Alpha) is loaded; the Zebra projects sit on a later page.
    const page = q ? items : items.filter(p => p.id === 'mv-alpha' || p.id === 'mv-done');
    return { items: page, total: items.length, nextCursor: q ? null : (page.length < items.length ? '1' : null) };
  });
  const queryCalls = () => listMusicVideoProjectSummaries.mock.calls.map(([args]) => args).filter(args => args.q);

  it('sends the typed query to the server with the status filter and keeps the box focused', async () => {
    mockServer();
    render(<MemoryRouter initialEntries={['/music-video']}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { name: 'Alpha' });
    const box = screen.getByLabelText('Filter projects by name');
    box.focus();
    fireEvent.change(box, { target: { value: 'zebra' } });
    expect(await screen.findByRole('heading', { name: 'Zebra Finale' })).toBeInTheDocument();
    expect(queryCalls().at(-1)).toMatchObject({ q: 'zebra', statusFilter: 'in-progress' });
    expect(screen.queryByRole('heading', { name: 'Alpha' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter projects by name')).toBe(box);
    expect(document.activeElement).toBe(box);
    fireEvent.click(screen.getByRole('button', { name: 'Completed' }));
    expect(await screen.findByRole('heading', { name: 'Zebra Archive' })).toBeInTheDocument();
    expect(queryCalls().at(-1)).toMatchObject({ q: 'zebra', statusFilter: 'completed' });
  });

  it('opens from a ?q= URL, shows the empty state, and clears back to the full list', async () => {
    mockServer();
    render(<MemoryRouter initialEntries={['/music-video?q=nomatch']}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByText(/No projects match/)).toBeInTheDocument();
    expect(queryCalls().every(args => args.q === 'nomatch')).toBe(true);
    fireEvent.change(screen.getByLabelText('Filter projects by name'), { target: { value: '' } });
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
  });
});

describe('MusicVideo stage-only nav URLs (#10303)', () => {
  it('/music-video/board redirects to the newest project at that stage', async () => {
    listMusicVideoProjects.mockResolvedValue([
      { ...PROJECT_NO_CLIP, updatedAt: '2026-01-01T00:00:00Z' },
      { ...PROJECT_WITH_CLIP, updatedAt: '2026-02-01T00:00:00Z' },
    ]);
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    render(
      <MemoryRouter initialEntries={['/music-video/board']}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/board'));
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
    await waitFor(() => expect(listMusicVideoProjectVersions).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { silent: true }));
  });

  it('falls back to the project list when there are no projects', async () => {
    listMusicVideoProjects.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/music-video/produce']}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No projects in progress/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/music-video$/));
    expect(screen.queryByText(/Project not found/)).not.toBeInTheDocument();
  });
});

describe('MusicVideo bounded summary index and project isolation (#10169)', () => {
  it('opening /music-video/:id makes one project GET and no full-list call', async () => {
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(getMusicVideoProject).toHaveBeenCalledTimes(1);
    expect(getMusicVideoProject).toHaveBeenCalledWith('mv-1', { silent: true });
    expect(listMusicVideoProjects).not.toHaveBeenCalled();
    expect(listMusicVideoProjectSummaries).not.toHaveBeenCalled();
  });

  it('the index view loads summaries with cursor pagination', async () => {
    listMusicVideoProjectSummaries.mockResolvedValue({
      items: [
        {
          id: 'mv-summary-1',
          name: 'Summary Video',
          version: 1,
          rootProjectId: 'mv-summary-1',
          versionRoot: 'mv-summary-1',
          stage: 'board',
          status: 'ready',
          runStatus: null,
          poster: null,
          preview: { kind: 'none', label: 'No render yet' },
          spend: { spentUsd: 0, capUsd: null },
          updatedAt: '2026-10-04T00:00:00Z',
          sceneCount: 3,
          shotSummary: '3 scenes',
        },
      ],
      total: 1,
      nextCursor: null,
    });
    render(
      <MemoryRouter initialEntries={['/music-video']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('mv-project-grid')).toHaveTextContent('Summary Video');
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 30 }),
      expect.anything(),
    );
  });

  it('a list failure does not break an open project', async () => {
    getMusicVideoProject.mockResolvedValue(PROJECT_WITH_CLIP);
    listMusicVideoProjectSummaries.mockRejectedValueOnce(new Error('List network failure'));
    listMusicVideoProjects.mockRejectedValueOnce(new Error('List network failure'));
    render(
      <MemoryRouter initialEntries={['/music-video/mv-1/board']}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
  });
});

describe('MusicVideo open project synchronization', () => {
  const initial = { ...PROJECT_WITH_CLIP, updatedAt: '2026-10-04T00:00:00Z' };
  const newer = { ...initial, name: 'Newer Project', updatedAt: '2026-10-04T00:00:02Z' };

  const startReload = async () => {
    let resolveReload;
    getMusicVideoProject.mockImplementationOnce(() => new Promise(resolve => { resolveReload = resolve; }));
    await pushSocket('music-video:project:changed', { id: initial.id });
    expect(resolveReload).toBeTypeOf('function');
    return resolveReload;
  };

  it.each(['production event', 'rename reply'])('keeps a newer %s when an older reload resolves', async (source) => {
    await openProject(initial, 'produce');
    const resolveReload = await startReload();
    if (source === 'production event') {
      await pushSocket('music-video:production', { projectId: initial.id, project: newer });
    } else {
      updateMusicVideoProject.mockResolvedValueOnce(newer);
      fireEvent.click(screen.getByRole('button', { name: 'Rename v1' }));
      fireEvent.change(screen.getByLabelText('Project title'), { target: { value: newer.name } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    }
    await screen.findByRole('heading', { level: 2, name: newer.name });
    getMusicVideoProject.mockResolvedValue(newer);
    const calls = getMusicVideoProject.mock.calls.length;

    await act(async () => resolveReload({ ...initial, updatedAt: '2026-10-04T00:00:01Z' }));

    expect(getMusicVideoProject).toHaveBeenCalledTimes(calls + 1);
    expect(screen.getByRole('heading', { level: 2, name: newer.name })).toBeInTheDocument();
  });

  it('warns about a remote shot edit when another project update is queued in the same batch', async () => {
    const subscriptions = vi.spyOn(socket, 'on');
    getMusicVideoProject.mockResolvedValue(initial);
    render(
      <MemoryRouter initialEntries={[`/music-video/${initial.id}/produce/scene/s1`]}>
        {MV_ROUTES}
      </MemoryRouter>,
    );
    const prompt = await screen.findByRole('textbox', { name: 'Clip prompt' });
    updateMusicVideoScene.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.change(prompt, { target: { value: 'Local draft' } });
    fireEvent.blur(prompt);
    expect(updateMusicVideoScene).toHaveBeenCalledWith(initial.id, 's1', { prompt: 'Local draft' }, expect.anything());
    const resolveReload = await startReload();

    const [, onSpend] = subscriptions.mock.calls.find(([event]) => event === 'music-video:render-spend');
    // Let React schedule this socket batch as it does in the browser. The act queue
    // defers the updater even when application code calls flushSync.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    try {
      onSpend({ projectId: initial.id, renderSpend: { spentUsd: 1 } });
      resolveReload({ ...newer, scenes: [{ ...initial.scenes[0], prompt: 'Remote edit' }] });
      await screen.findByRole('heading', { level: 2, name: newer.name });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(screen.getByRole('textbox', { name: 'Clip prompt' })).toHaveValue('Local draft');
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('A shot changed elsewhere'));
  });
});

describe('MusicVideo index follows projects changed elsewhere (#15724)', () => {
  const summary = (id, name) => ({
    id, name, version: 1, rootProjectId: id, versionRoot: id, stage: 'board', status: 'ready',
    runStatus: null, poster: null, preview: { kind: 'none', label: 'No render yet' },
    spend: { spentUsd: 0, capUsd: null }, updatedAt: '2026-10-04T00:00:00Z', createdAt: '2026-10-04T00:00:00Z',
    sceneCount: 1, shotSummary: '1 scene',
  });

  const renderIndex = async (items) => {
    listMusicVideoProjectSummaries.mockResolvedValue({ items, total: items.length, nextCursor: null });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByTestId('mv-project-grid')).toHaveTextContent(items[0].name);
  };

  it('shows a project created elsewhere without reloading the page', async () => {
    const existing = summary('mv-listed', 'Already Listed');
    const created = summary('mv-new', 'Arrived Elsewhere');
    let reads = 0;
    listMusicVideoProjectSummaries.mockImplementation(async () => {
      reads += 1;
      const items = reads === 1 ? [existing] : [created, existing];
      return { items, total: items.length, nextCursor: null };
    });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByTestId('mv-project-grid')).toHaveTextContent('Already Listed');
    expect(screen.getByTestId('mv-project-grid')).not.toHaveTextContent('Arrived Elsewhere');
    await pushSocket('music-video:project:changed', { id: 'mv-new' });
    await waitFor(() => expect(screen.getByTestId('mv-project-grid')).toHaveTextContent('Arrived Elsewhere'));
    expect(getMusicVideoProject).not.toHaveBeenCalledWith('mv-new', expect.anything());
  });

  it('renames a listed card from that one record and does not reread the summary page', async () => {
    const listed = summary('mv-listed', 'Old Name');
    await renderIndex([listed]);
    const summaryCalls = listMusicVideoProjectSummaries.mock.calls.length;
    getMusicVideoProject.mockResolvedValueOnce({ ...listed, name: 'New Name' });
    await pushSocket('music-video:project:changed', { id: 'mv-listed' });
    await waitFor(() => expect(screen.getByTestId('mv-project-grid')).toHaveTextContent('New Name'));
    expect(screen.getByTestId('mv-project-grid')).not.toHaveTextContent('Old Name');
    expect(getMusicVideoProject).toHaveBeenCalledWith('mv-listed', { silent: true });
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledTimes(summaryCalls);
  });

  it('removes a listed card when the record read is a 404', async () => {
    const listed = summary('mv-listed', 'Going Away');
    const kept = summary('mv-kept', 'Stays');
    let reads = 0;
    listMusicVideoProjectSummaries.mockImplementation(async () => {
      reads += 1;
      const items = reads === 1 ? [listed, kept] : [kept];
      return { items, total: items.length, nextCursor: null };
    });
    render(<MemoryRouter initialEntries={['/music-video']}>{MV_ROUTES}</MemoryRouter>);
    expect(await screen.findByTestId('mv-project-grid')).toHaveTextContent('Going Away');
    getMusicVideoProject.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    await pushSocket('music-video:project:changed', { id: 'mv-listed' });
    await waitFor(() => expect(screen.getByTestId('mv-project-grid')).not.toHaveTextContent('Going Away'));
    expect(screen.getByTestId('mv-project-grid')).toHaveTextContent('Stays');
  });

  it('ignores an event this tab originated', async () => {
    const socket = (await import('../services/socket.js')).default;
    socket.id = 'tab-socket';
    const listed = summary('mv-listed', 'Untouched');
    await renderIndex([listed]);
    const summaryCalls = listMusicVideoProjectSummaries.mock.calls.length;
    getMusicVideoProject.mockClear();
    await pushSocket('music-video:project:changed', { id: 'mv-new', origin: 'tab-socket' });
    await pushSocket('music-video:project:changed', { id: 'mv-listed', origin: 'tab-socket' });
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledTimes(summaryCalls);
    expect(getMusicVideoProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('mv-project-grid')).toHaveTextContent('Untouched');
    expect(screen.getByTestId('mv-project-grid')).not.toHaveTextContent('mv-new');
  });

  it('updates a different project in the header picker while one project is open', async () => {
    const other = summary('mv-other', 'Other Project');
    getMusicVideoProject.mockImplementation(async (id) => {
      if (id === PROJECT_WITH_CLIP.id) return PROJECT_WITH_CLIP;
      if (id === other.id) return { ...other, name: 'Renamed Other' };
      return null;
    });
    listMusicVideoProjectSummaries.mockResolvedValue({
      items: [summary(PROJECT_WITH_CLIP.id, PROJECT_WITH_CLIP.name), other],
      total: 2,
      nextCursor: null,
    });
    render(<MemoryRouter initialEntries={['/music-video/mv-1/board']}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(listMusicVideoProjectSummaries).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByLabelText('Project'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Other Project (v1)' })).toBeInTheDocument());
    const summaryCalls = listMusicVideoProjectSummaries.mock.calls.length;
    await pushSocket('music-video:project:changed', { id: 'mv-other' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Renamed Other (v1)' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Other Project (v1)' })).not.toBeInTheDocument();
    expect(getMusicVideoProject).toHaveBeenCalledWith('mv-other', { silent: true });
    expect(listMusicVideoProjectSummaries).toHaveBeenCalledTimes(summaryCalls);
  });
});

describe('MusicVideo per-project workspace (#12039)', () => {
  it('remounts the workspace per project, so switching projects starts from fresh per-project state', async () => {
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Other Project' };
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP, other]);
    renderMV();
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('setup');
    // Song is not reviewed by watching, so the preview starts folded; opening
    // it is per-project state that used to be reset by a selection effect.
    fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
    expect(screen.getByRole('button', { name: 'Collapse preview' })).toBeInTheDocument();

    await selectProject(other.id);
    await openStage('setup');
    expect(screen.getByRole('button', { name: 'Expand preview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse preview' })).not.toBeInTheDocument();

    // Coming back starts fresh too: nothing from the first visit is carried over.
    await selectProject(PROJECT_WITH_CLIP.id);
    await openStage('setup');
    expect(screen.getByRole('button', { name: 'Expand preview' })).toBeInTheDocument();
  });
});

describe('MusicVideo music library load state (#12040)', () => {
  it('shows a failed library read with Retry in the create form, then the tracks once the retry lands', async () => {
    listTracks.mockRejectedValueOnce(new Error('library offline'));
    renderMV();
    fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the music library — library offline');
    expect(screen.queryByText(/No tracks in the music library yet/)).not.toBeInTheDocument();

    listTracks.mockResolvedValueOnce([{ id: 't-example', title: 'Example Track' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Example Track/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the empty copy for a genuinely empty library, not an error', async () => {
    renderMV();
    fireEvent.click(await screen.findByRole('button', { name: /New project/i }));
    expect(await screen.findByText(/No tracks in the music library yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('MusicVideo project header', () => {
  it('keeps only the picker beside the page title inside a project; fork and delete live in Project settings', async () => {
    await openProject(PROJECT_WITH_CLIP);
    expect(screen.queryByRole('button', { name: /New project/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Autonomous/i })).toBeNull();
    expect(screen.queryByText(/^Project actions/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete project' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Fork/ })).toBeNull();
    await openSettings('Project');
    expect(screen.getByRole('button', { name: 'Delete project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork v2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fork for video generation' })).toBeTruthy();
  });
});

describe('MusicVideo version title', () => {
  it('renames the open version from the pencil beside its title', async () => {
    await openProject(PROJECT_WITH_CLIP);
    fireEvent.click(screen.getByRole('button', { name: 'Rename v1' }));
    // The editor takes the title's place, so the old heading is gone while editing.
    expect(screen.queryByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeNull();
    updateMusicVideoProject.mockImplementationOnce(async (_id, patch) => ({ ...PROJECT_WITH_CLIP, ...patch }));
    fireEvent.change(screen.getByLabelText('Project title'), { target: { value: 'Title Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('heading', { level: 2, name: 'Title Renamed' });
  });
});

describe('MusicVideo needs-attention banner (#9940)', () => {
  const stranded = {
    ...PROJECT_WITH_CLIP,
    revisions: [{ id: 'mvrev-1', status: 'open', sections: [{ sceneId: 's1', kind: 'video', verdict: 'rejected', layer: 'footage' }] }],
  };

  it('keeps a stranded revision\'s Resume and Cancel in the header on every stage after a reload', async () => {
    resumeMusicVideoRevision.mockResolvedValue({ project: stranded, revision: stranded.revisions[0], needsGeneration: [], generating: [] });
    cancelMusicVideoRevision.mockResolvedValue({ project: { ...stranded, revisions: [{ ...stranded.revisions[0], status: 'canceled' }] }, canceledJobIds: [] });
    await openProject(stranded, 'produce');
    const banner = await screen.findByRole('region', { name: 'Needs attention' });
    expect(banner).toHaveTextContent('A section revision is open');
    await openStage('review');
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume the open revision' }));
    await waitFor(() => expect(resumeMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvrev-1', { silent: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the open revision' }));
    await waitFor(() => expect(cancelMusicVideoRevision).toHaveBeenCalledWith('mv-1', 'mvrev-1', { silent: true }));
    // Cancelling clears the banner: production is unblocked.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument());
  });

  it('shows no banner for a healthy project', async () => {
    await openProject(PROJECT_WITH_CLIP, 'produce');
    expect(screen.queryByRole('region', { name: 'Needs attention' })).not.toBeInTheDocument();
  });
});

describe('MusicVideo project versions', () => {
  it('forks for video generation without rendering or modifying the source', async () => {
    cloneMusicVideoProject.mockResolvedValue({ ...PROJECT_WITH_CLIP, id: 'mv-footage', name: 'Footage Variant', version: 2, composition: { mode: 'composed' } });
    await openProject({ ...PROJECT_WITH_CLIP, composition: { mode: 'document' } });
    await openSettings('Project');
    fireEvent.click(await screen.findByRole('button', { name: 'Fork for video generation' }));
    await waitFor(() => expect(cloneMusicVideoProject).toHaveBeenCalledWith('mv-1', { variant: 'video-generation' }, { silent: true }));
    await screen.findByRole('heading', { level: 2, name: 'Footage Variant' });
    expect(renderMusicVideoProject).not.toHaveBeenCalled();
    expect(updateMusicVideoProject).not.toHaveBeenCalled();
  });

  it('forks the open project and navigates to the editable next version', async () => {
    cloneMusicVideoProject.mockResolvedValue({
      ...PROJECT_WITH_CLIP,
      id: 'mv-v2',
      name: 'Neon Run v2',
      version: 2,
      parentProjectId: 'mv-1',
      renderHistoryId: null,
    });
    await openProject(PROJECT_WITH_CLIP);
    await openSettings('Project');

    fireEvent.click(await screen.findByRole('button', { name: /^Fork v2$/ }));

    await waitFor(() => expect(cloneMusicVideoProject).toHaveBeenCalledWith('mv-1', {}, { silent: true }));
    await screen.findByRole('heading', { level: 2, name: 'Neon Run v2' });
    expect(screen.getByRole('button', { name: 'Rename v2' })).toBeTruthy();
  });

  it('labels both versions in the project picker and switches the title version on the same stage', async () => {
    const v1 = { ...PROJECT_WITH_CLIP, version: 1 };
    const v2 = { ...PROJECT_WITH_CLIP, id: 'mv-v2', rootProjectId: v1.id, parentProjectId: v1.id, version: 2, name: `${v1.name} v2` };
    const other = { ...PROJECT_WITH_CLIP, id: 'mv-other', name: 'Unrelated Project', version: 1 };
    getMusicVideoProject.mockImplementation(async id => [v1, v2, other].find(project => project.id === id));
    listMusicVideoProjectVersions.mockResolvedValue([v2, v1]);
    listMusicVideoProjectSummaries.mockResolvedValue({ items: [other, v2], total: 3, nextCursor: '2' });
    const SearchProbe = () => <span data-testid="version-search">{useLocation().search}</span>;
    render(
      <MemoryRouter initialEntries={[ `/music-video/${v2.id}/board?q=Night` ]}>
        <LocationProbe />
        <SearchProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );
    const version = await screen.findByRole('combobox', { name: 'Project version' });
    expect(listMusicVideoProjectVersions).toHaveBeenCalledWith(v1.id, { silent: true });
    expect(version).toHaveValue(v2.id);
    expect(within(version).getAllByRole('option').map(option => option.textContent)).toEqual(['v2', 'v1']);
    expect(version.nextElementSibling).toBe(screen.getByRole('button', { name: 'Rename v2' }));
    const project = screen.getByLabelText('Project');
    fireEvent.focus(project);
    expect(await within(project).findByRole('option', { name: 'Unrelated Project (v1)' })).toBeInTheDocument();
    expect(within(project).getByRole('option', { name: `${v1.name} (v1)` })).toHaveValue(v1.id);
    expect(within(project).getByRole('option', { name: `${v1.name} (v2)` })).toHaveValue(v2.id);

    fireEvent.change(version, { target: { value: v1.id } });
    await screen.findByRole('heading', { level: 2, name: v1.name });
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${v1.id}/board`);
    expect(screen.getByTestId('version-search')).toHaveTextContent('?q=Night');
    expect(await screen.findByRole('combobox', { name: 'Project version' })).toHaveValue(v1.id);
  });

  it('distinguishes sibling forks with the same version number, even after equal renames', async () => {
    const v1 = { ...PROJECT_WITH_CLIP, version: 1 };
    const fork = (id, name) => ({ ...v1, id, name, rootProjectId: v1.id, parentProjectId: v1.id, version: 2 });
    const a = fork('mv-fork-a', 'Legato');
    const b = fork('mv-fork-b', 'Legato');
    const c = fork('mv-fork-c', 'Staccato');
    const versions = [v1, c, b, a];
    getMusicVideoProject.mockImplementation(async id => versions.find(project => project.id === id));
    listMusicVideoProjectVersions.mockResolvedValue(versions);
    render(
      <MemoryRouter initialEntries={[`/music-video/${v1.id}/board`]}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>,
    );

    const versionPicker = async () => screen.findByRole('combobox', { name: 'Project version' });
    const projectPicker = screen.getByRole('combobox', { name: 'Project' });
    for (const [project, titleLabel, headerLabel] of [
      [a, 'v2 · Legato · Copy 1', 'Legato (v2) · Copy 1'],
      [b, 'v2 · Legato · Copy 2', 'Legato (v2) · Copy 2'],
      [c, 'v2 · Staccato', 'Staccato (v2)'],
    ]) {
      const picker = await versionPicker();
      expect(within(picker).getByRole('option', { name: titleLabel })).toHaveValue(project.id);
      expect(within(projectPicker).getByRole('option', { name: headerLabel })).toHaveValue(project.id);
      fireEvent.change(picker, { target: { value: project.id } });
      expect(await versionPicker()).toHaveValue(project.id);
      expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${project.id}/board`);
      expect(getMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true });
    }
  });

  it('keeps known versions available while refreshing the family after a fork', async () => {
    const v1 = { ...PROJECT_WITH_CLIP, version: 1 };
    const v2 = { ...v1, id: 'mv-v2', rootProjectId: v1.id, parentProjectId: v1.id, version: 2, name: 'Other take' };
    const newFork = { ...v2, id: 'mv-new-fork', name: 'New take' };
    let failRefresh;
    listMusicVideoProjectVersions.mockResolvedValueOnce([v1, v2]).mockImplementation(() => new Promise((_, reject) => { failRefresh = reject; }));
    getMusicVideoProject.mockImplementation(async id => [v1, v2, newFork].find(project => project.id === id));
    cloneMusicVideoProject.mockResolvedValue(newFork);
    render(<MemoryRouter initialEntries={[`/music-video/${v1.id}/board`]}>{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('combobox', { name: 'Project version' });
    await openSettings('Project');
    fireEvent.click(await screen.findByRole('button', { name: /^Fork v2$/ }));

    await screen.findByRole('heading', { level: 2, name: newFork.name });
    const picker = screen.getByRole('combobox', { name: 'Project version' });
    expect(within(picker).getByRole('option', { name: 'v2 · Other take' })).toHaveValue(v2.id);
    await act(async () => failRefresh(new Error('Could not update versions')));
    expect(within(picker).getByRole('option', { name: 'v2 · Other take' })).toHaveValue(v2.id);
  });

  it('omits media type parenthetical in the project picker options', async () => {
    const parentheticalProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-exp',
      name: 'You Are the Room - Blueprint v7 (experimental, images)',
    };
    await openProject(parentheticalProject);

    const picker = await screen.findByLabelText('Project');
    const option = Array.from(picker.options).find((opt) => opt.value === 'mv-exp');
    expect(option).toBeDefined();
    expect(option?.textContent).toBe('You Are the Room - Blueprint v7');
  });
});

describe('MusicVideo YouTube audio import (#1945)', () => {
  it('asks for confirmation before deleting a project and allows cancelling or confirming', async () => {
    deleteMusicVideoProject.mockResolvedValue({});
    await openProject(PROJECT_NO_CLIP, 'setup');
    await openSettings('Project');

    fireEvent.click(screen.getByTitle('Delete project'));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
    expect(screen.getByText('Delete?')).toBeTruthy();

    // Cancel deletion
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteMusicVideoProject).not.toHaveBeenCalled();
    expect(screen.getByTitle('Delete project')).toBeTruthy();

    // Arm confirmation again and confirm
    fireEvent.click(screen.getByTitle('Delete project'));
    fireEvent.click(screen.getByRole('button', { name: `Confirm delete project ${PROJECT_NO_CLIP.name}` }));
    await waitFor(() => expect(deleteMusicVideoProject).toHaveBeenCalledWith(PROJECT_NO_CLIP.id, { silent: true }));
  });
});

describe('MusicVideo stage tabs (#9243)', () => {
  const renderAt = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      {MV_ROUTES}
    </MemoryRouter>,
  );

  const selectedTab = () => screen.getByRole('tab', { selected: true });

  // Uniquely catches Edit shot losing its route (Shots) or the shot's card not opening in the side panel.
  it('opens the shot playing in the preview on Shots in the side panel', async () => {
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [{ ...PROJECT_WITH_CLIP.scenes[0], startSec: 0 }] }]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const dock = screen.getByRole('complementary', { name: 'Preview' });
    fireEvent.click(within(dock).getByRole('button', { name: 'Edit shot' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/music-video/mv-1/produce/scene/s1'));
    expect(selectedTab()).toHaveAccessibleName(STAGE_TABS.produce);
    const panel = await screen.findByRole('dialog');
    expect(panel.querySelector('#scene-s1')).not.toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close shot' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/\/music-video\/mv-1\/produce$/));
  });

  // Uniquely catches the player coming back on Plan, which is checked by reading; watching is on Shots.
  it('opens Plan without a preview', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/board');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull();
    await openStage('produce');
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeInTheDocument();
  });

  it('leads Shots with the player and storyboard approval, keeps approvals off Plan, closes Look with its approval, keeps the run in Project settings and unsaved planning edits across steps', async () => {
    // The storyboard review sits beside the player.
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP,
      autonomousRun: { status: 'needs-human', stage: 'video', output: {}, brief: {} },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: true, problems: [] }, storyboard: { approved: false, problems: [] }, proof: { approved: true, problems: [] } },
    }]);
    renderAt('/music-video/mv-1/cast-sets');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const review = await screen.findByRole('region', { name: 'Production review' });
    expect(within(review).getByRole('region', { name: 'Approve: Art direction' })).toBeInTheDocument();
    expect(within(review).queryByRole('region', { name: 'Approve: Lyric-timed storyboard' })).toBeNull();
    expect(screen.queryByText('Production approvals')).toBeNull();
    const castDraft = within(review).getByLabelText('Cast guide');
    fireEvent.change(castDraft, { target: { value: 'Example unsaved cast direction' } });

    const approvals = { 'cast-sets': 'Art direction', produce: 'Lyric-timed storyboard' };
    for (const stage of ['board', 'produce', 'cast-sets']) {
      await openStage(stage);
      const panel = screen.getByRole('tabpanel');
      // The selected tab also reads its state (", Done") to screen readers; the panel is labelled by the step's heading.
      const title = selectedTab().textContent.split(',')[0];
      expect(within(panel).getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
      expect(panel).toHaveAccessibleName(title);
      // Plan has no approval: the storyboard is reviewed on Shots.
      if (stage === 'board') {
        expect(within(panel).queryByRole('region', { name: 'Production review' })).toBeNull();
        continue;
      }
      const stageReview = await within(panel).findByRole('region', { name: 'Production review' });
      if (stage === 'cast-sets') {
        // Look is reviewed through its visual guide: the step's work comes first and the approval closes it.
        expect(panel.lastElementChild).toBe(stageReview);
      } else {
        // Shots is reviewed by watching: the player leads, the approval beside it, then the work.
        const player = within(panel).getByRole('complementary', { name: 'Preview' });
        expect(player.compareDocumentPosition(stageReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(stageReview.parentElement).toBe(player.parentElement.parentElement);
      }
      expect(within(stageReview).getAllByRole('region', { name: /^Approve: / })).toHaveLength(1);
      expect(within(stageReview).getByRole('region', { name: `Approve: ${approvals[stage]}` })).toBeInTheDocument();
      // The run is no longer a shared panel under every step.
      expect(screen.queryByRole('region', { name: 'Autonomous run' })).toBeNull();
    }
    expect(screen.getByLabelText('Cast guide')).toHaveValue('Example unsaved cast direction');

    // The run lives in Project settings › Autopilot, opened from the header.
    fireEvent.click(screen.getByRole('button', { name: /^Autonomous run/ }));
    const drawer = await screen.findByRole('dialog', { name: 'Project settings' });
    expect(within(drawer).getByRole('region', { name: 'Autonomous run' })).toBeInTheDocument();
    closeSettings();
    expect(screen.getByLabelText('Cast guide')).toHaveValue('Example unsaved cast direction');
  });

  it('opens the stage named in the URL, falls back to the project\'s own stage for an unknown one, and the tabs navigate', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/produce');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(selectedTab()).toHaveTextContent(/^Shots/);
    expect(screen.getByRole('region', { name: 'Composition' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add scene/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: STAGE_TABS.board }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/music-video/mv-1/board'));
    expect(selectedTab()).toHaveTextContent(/^Storyboard/);
    expect(screen.getByText('Start the storyboard')).toBeTruthy();
  });

  // Uniquely catches a stage container left unwired from the shell: each step opens from its own deep link.
  it.each(MUSIC_VIDEO_STAGES.map(({ id, label }) => [id, label]))('opens /music-video/:id/%s on its %s tab', async (id, label) => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt(`/music-video/mv-1/${id}`);
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    await waitFor(() => expect(selectedTab()).toHaveTextContent(new RegExp(`^${label}`)));
    expect(screen.getByTestId('loc').textContent).toBe(`/music-video/mv-1/${id}`);
    await settle();
  });

  it('falls back to the stage the project is in when the URL names no stage or an unknown one', async () => {
    // Track linked but not analyzed: Setup.
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderAt('/music-video/mv-1/not-a-stage');
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(selectedTab()).toHaveTextContent(/^Song/);
  });

  it('keeps the open tab when a stage completes, while the header moves on to the next action', async () => {
    const analyzed = { ...PROJECT_NO_CLIP, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
    analyzeMusicVideoProject.mockResolvedValue(analyzed);
    await openProject(PROJECT_NO_CLIP);
    expect(selectedTab()).toHaveTextContent(/^Song/);

    fireEvent.click(screen.getByRole('button', { name: 'Analyze song' }));
    await waitFor(() => expect(analyzeMusicVideoProject).toHaveBeenCalledWith('mv-2', { silent: true }));
    // Analysis is done and the shot has no frame or clip: the header now points at making the footage…
    expect(await screen.findByRole('button', { name: 'Make the footage' })).toBeTruthy();
    // …but the tab the director is working in is not pulled out from under them.
    expect(selectedTab()).toHaveTextContent(/^Song/);
  });

  it('every control has exactly one home step or Project settings tab', async () => {
    const project = { ...PROJECT_WITH_CLIP, castAndSets: { status: 'review', revision: 1, plan: {}, images: {} }, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
    // Each finder searches `root` (the page, or the open settings drawer).
    const steps = {
      setup: {
        'Change track': (root) => root.queryByLabelText('Change track'),
        'Song content': (root) => root.queryByRole('radio', { name: 'Vocal song' }),
      },
      story: { Concept: (root) => root.queryByRole('textbox', { name: 'Concept' }) },
      'cast-sets': { 'Cast & Sets check-in': (root) => root.queryByLabelText('Cast & Sets check-in') },
      board: { 'Start the storyboard': (root) => root.queryByText('Start the storyboard') },
      // Shots: the scene board, its timing tools, the footage, then the composition over it.
      produce: { 'Add scene': (root) => root.queryByRole('button', { name: /Add scene/ }), 'AI Plan': (root) => root.queryByRole('button', { name: /AI Plan/ }),
        'Clip prompt': (root) => root.queryByLabelText('Clip prompt'),
        Footage: () => document.getElementById('mv-generation'), Typography: (root) => root.queryByText(/^Typography —/) },
      review: { 'Render final': (root) => root.queryByRole('button', { name: /^Render final$/ }), 'Render excerpt': (root) => root.queryByRole('button', { name: /Render excerpt/ }) },
    };
    const settings = {
      // The render style and the image/video services are set once, here.
      Project: {
        'Render style': () => document.getElementById('mv-toolbar-render-style'), 'Scene video renderer': (root) => root.queryByLabelText('Scene video renderer'),
        Media: (root) => root.queryByLabelText('Design and composition media'),
      },
      Audio: { MIDI: (root) => root.queryByRole('button', { name: /^MIDI$/ }) },
      Autopilot: { 'Automation brief': (root) => root.queryByLabelText('Automation brief'), 'Start production': (root) => root.queryByRole('button', { name: /Start production/ }) },
      Files: { 'Export bundle': (root) => root.queryByRole('button', { name: /^Export bundle$/ }) },
    };
    // Importing a file is deliberately offered twice: a guide is imported where it is chosen (Look),
    // and any other development file in Project settings › Files.
    const importFile = (root) => root.queryByLabelText('Import development file');
    await openProject(project);
    for (const [stage, own] of Object.entries(steps)) {
      await openStage(stage);
      for (const [name, find] of Object.entries(own)) expect(find(screen), `${name} on ${stage}`).toBeTruthy();
      for (const [other, theirs] of [...Object.entries(steps), ...Object.entries(settings)]) {
        if (other === stage) continue;
        for (const [name, find] of Object.entries(theirs)) expect(find(screen), `${name} must not be on ${stage}`).toBeFalsy();
      }
      expect(!!importFile(screen), `Import development file on ${stage}`).toBe(stage === 'cast-sets');
    }
    // The drawer opens over the last step; only the open settings tab's controls are in it.
    for (const [tab, own] of Object.entries(settings)) {
      await openSettings(tab);
      const drawer = within(screen.getByRole('dialog', { name: 'Project settings' }));
      for (const [name, find] of Object.entries(own)) expect(find(drawer), `${name} in ${tab} settings`).toBeTruthy();
      for (const [other, theirs] of [...Object.entries(steps), ...Object.entries(settings)]) {
        if (other === tab) continue;
        for (const [name, find] of Object.entries(theirs)) {
          const found = find(drawer);
          expect(!!found && screen.getByRole('dialog', { name: 'Project settings' }).contains(found), `${name} must not be in ${tab} settings`).toBe(false);
        }
      }
      expect(!!importFile(drawer), `Import development file in ${tab} settings`).toBe(tab === 'Files');
      closeSettings();
    }
  });

  describe('the sticky header\'s next action', () => {
    it('runs the autopilot for a fresh autopilot project', async () => {
      // The check-in is already skipped, so the run goes straight from analysis to the plan.
      const project = { ...PROJECT_NO_CLIP, scenes: [], lyricCues: [], castAndSets: { status: 'skipped' }, automation: { tools: ['image:local'], guidance: '', budgetUsd: null } };
      const analyzed = { ...project, audioAnalysis: PROJECT_ANALYZED.audioAnalysis };
      analyzeMusicVideoProject.mockResolvedValue(analyzed);
      importMusicVideoTrackLyrics.mockResolvedValue({ project: analyzed, imported: 0, markers: 0 });
      planMusicVideoProject.mockResolvedValue({ project: analyzed, scenesAdded: 1, promptsSeeded: false });
      await openProject(project);
      fireEvent.click(screen.getByRole('button', { name: 'Run autopilot' }));
      await waitFor(() => expect(analyzeMusicVideoProject).toHaveBeenCalledWith(project.id, { silent: true }));
      await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalledWith(project.id, { seedPrompts: true }, { silent: true }));
    });

    it('keeps the Cast & Sets reference check-in available from its tab', async () => {
      const waiting = {
        ...PROJECT_ANALYZED, scenes: [], lyricCues: [], automation: { tools: ['image:local'], guidance: '', budgetUsd: null },
        castAndSets: { status: 'review', revision: 1, plan: {}, images: {} },
      };
      const approved = { ...waiting, castAndSets: { ...waiting.castAndSets, status: 'approved' } };
      approveMusicVideoCastAndSets.mockResolvedValue({ project: approved, stage: approved.castAndSets });
      importMusicVideoTrackLyrics.mockResolvedValue({ project: approved, imported: 0, markers: 0 });
      planMusicVideoProject.mockResolvedValue({ project: approved, scenesAdded: 1, promptsSeeded: false });
      await openProject(waiting, 'setup');
      await openStage('cast-sets');
      fireEvent.click(screen.getByRole('button', { name: /Approve & continue/ }));
      await waitFor(() => expect(approveMusicVideoCastAndSets).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(planMusicVideoProject).toHaveBeenCalled());
    });

    it('stops a running production run and shows what it has spent against its cap', async () => {
      const run = {
        id: 'run-1', status: 'running', interrupted: false, directive: '', stopReason: null, error: null, pool: [],
        limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: 20 }, usage: { generations: 3, spentUsd: 4.5 }, steps: [],
      };
      const project = { ...PROJECT_ANALYZED, productionRuns: [run] };
      stopMusicVideoProduction.mockResolvedValue({ project, run });
      await openProject(project, 'produce');
      expect(screen.getByText('$4.50 / $20.00')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Stop production' }));
      await waitFor(() => expect(stopMusicVideoProduction).toHaveBeenCalledWith('mv-3', 'run-1', { silent: true }));
    });

    it('keeps the attention row for a parked production run the Autopilot button does not report', async () => {
      const run = {
        id: 'run-2', status: 'needs-human', interrupted: false, directive: '', stopReason: 'Example stop reason', error: null, pool: [],
        limits: { maxGenerations: 12, maxReviewAttempts: 3, spendCapUsd: 20 }, usage: { generations: 3, spentUsd: 4.5 }, steps: [],
      };
      await openProject({ ...PROJECT_ANALYZED, productionRuns: [run] }, 'produce');
      // "needs-human" has no Resume and the header's Autopilot button stays plain, so the row is the only signal.
      const banner = screen.getByRole('region', { name: 'Needs attention' });
      expect(within(banner).getByText('Production needs you')).toBeTruthy();
    });

    it('starts the kit from the publish checklist with one click and prevents duplicate builds', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, renderHistoryId: 'rh-9' }, 'publish');
      expect(buildMusicVideoPublishKit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Build the kit' }));
      await waitFor(() => expect(buildMusicVideoPublishKit).toHaveBeenCalledTimes(1));
      expect(buildMusicVideoPublishKit).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { silent: true });
      expect(screen.getByRole('button', { name: 'Build the kit' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Build publishing kit/ })).toBeDisabled();
    });

    it('keeps the build shortcut disabled while creative setup is being edited, then runs after Cancel', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, renderHistoryId: 'rh-9' }, 'story');
      await act(async () => {});
      const build = screen.getByRole('button', { name: 'Build the publishing kit' });
      expect(build).toBeDisabled();
      expect(build).toHaveAttribute('title', 'Save or cancel the creative setup before building the publishing kit.');
      fireEvent.click(build);
      expect(buildMusicVideoPublishKit).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Build the publishing kit' }));
      await waitFor(() => expect(buildMusicVideoPublishKit).toHaveBeenCalledTimes(1));
      expect(selectedTab()).toHaveTextContent(/^Publish/);
    });

    it('takes a finished project on to its release (#9281)', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, audioAnalysis: PROJECT_ANALYZED.audioAnalysis, renderHistoryId: 'rh-9' }, 'produce');
      fireEvent.click(screen.getByRole('button', { name: 'Build the publishing kit' }));
      await waitFor(() => expect(selectedTab()).toHaveTextContent(/^Publish/));
      expect(screen.getByRole('region', { name: 'Release assets' })).toBeTruthy();
      await waitFor(() => expect(buildMusicVideoPublishKit).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { silent: true }));
      expect(screen.getByRole('button', { name: /Build publishing kit/ })).toBeDisabled();
    });
  });

  describe('docked preview', () => {
    const DOCUMENT = { directory: 'music-video/mv-doc/composition/doc-a', entry: 'index.html', updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'template', name: 'layered' }, files: 9, bytes: 90000 };
    const docProject = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-doc',
      name: 'Document Project',
      audioAnalysis: null,
      composition: { version: 1, mode: 'document', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null, document: DOCUMENT },
      scenes: [
        { sceneId: 's1', order: 0, prompt: 'a', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 0, endSec: 4 },
        { sceneId: 's2', order: 1, prompt: 'b', referenceImageId: 'img1', videoHistoryId: 'h1', startSec: 4, endSec: 8 },
      ],
    };

    it('docks the preview on every stage and seeks it to a scene\'s start when its card is opened', async () => {
      listTracks.mockResolvedValue([{ id: 't1', title: 'Neon Song', audioFilename: 'neon.mp3' }]);
      await openProject(docProject, 'setup');
      expect(await screen.findByTitle('Composition document preview')).toBeTruthy();

      await openStage('produce');
      expect(screen.getByTitle('Composition document preview')).toBeTruthy();
      await waitFor(() => expect(screen.getByText('0.00s / 60.0s')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Open Shot 2' }));
      await waitFor(() => expect(screen.getByText('4.00s / 60.0s')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Open Shot 1' }));
      await waitFor(() => expect(screen.getByText('0.00s / 60.0s')).toBeTruthy());
    });

    it('falls back to the latest finished draft excerpt when there is no composition document', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        excerpts: [
          { id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] },
          { id: 'mve-2', startSec: 10, endSec: 20, status: 'complete', filename: 'excerpt-new.mp4', notes: [] },
        ],
      };
      // Final render plays the newest draft; Storyboard leads with the storyboard animatic instead.
      await openProject(project, 'review');
      const player = await screen.findByLabelText('Draft excerpt preview');
      expect(player.getAttribute('src')).toBe('/data/videos/excerpt-new.mp4');
      expect(screen.queryByTitle('Composition document preview')).toBeNull();
      // Every finished draft stays reachable from the dock's source picker.
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      await waitFor(() => expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4'));
      await openStage('cast-sets', false);
      await waitFor(() => expect(screen.getByLabelText('Preview source')).toHaveValue('excerpt:mve-1'));
    });

    // Uniquely catches resizing the Look/Publish preview remounting its player or resetting the chosen source.
    it('expands the Look and Publish preview into the main column and returns the same player to the sidebar', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        renderHistoryId: 'rh-9',
        excerpts: [{ id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] }],
      };
      await openProject(project, 'cast-sets');
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      for (const stage of ['cast-sets', 'publish']) {
        if (stage === 'publish') await openStage(stage, false);
        const player = await screen.findByLabelText('Draft excerpt preview');
        player.currentTime = 3;
        fireEvent.timeUpdate(player);
        const dock = screen.getByRole('complementary', { name: 'Preview' }).closest('.max-xl\\:order-first');
        fireEvent.click(screen.getByRole('button', { name: 'Expand preview into main area' }));
        expect(dock).toHaveClass('xl:col-start-2', 'xl:row-start-1');
        expect(screen.getByRole('tabpanel')).toHaveClass('xl:row-start-2');
        expect(screen.getByLabelText('Draft excerpt preview')).toBe(player);
        expect(player.currentTime).toBe(3);
        expect(screen.getByLabelText('Preview source')).toHaveValue('excerpt:mve-1');
        const restore = screen.getByRole('button', { name: 'Return preview to sidebar' });
        expect(restore).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(restore);
        expect(dock).toHaveClass('xl:sticky');
        expect(screen.getByRole('tabpanel')).not.toHaveClass('xl:row-start-2');
        expect(screen.getByLabelText('Draft excerpt preview')).toBe(player);
        expect(player.currentTime).toBe(3);
      }
      await openStage('board', false);
      expect(screen.queryByRole('button', { name: 'Expand preview into main area' })).toBeNull();
    });

    it('plays the final render first and keeps a picked draft across stage tabs', async () => {
      const project = {
        ...PROJECT_WITH_CLIP,
        renderHistoryId: 'rh-9',
        excerpts: [{ id: 'mve-1', startSec: 0, endSec: 10, status: 'complete', filename: 'excerpt-old.mp4', notes: [] }],
      };
      await openProject(project, 'setup');
      const final = await screen.findByLabelText('Final render preview');
      expect(final.getAttribute('src')).toBe('/data/videos/final.mp4');
      fireEvent.change(screen.getByLabelText('Preview source'), { target: { value: 'excerpt:mve-1' } });
      await waitFor(() => expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4'));
      await openStage('cast-sets', false);
      expect(screen.getByLabelText('Draft excerpt preview').getAttribute('src')).toBe('/data/videos/excerpt-old.mp4');
      expect(screen.queryByLabelText('Final render preview')).toBeNull();
    });

    it('keeps the dock with an empty state when there is nothing to play yet', async () => {
      await openProject({ ...PROJECT_WITH_CLIP, trackId: null, uploadedAudioFilename: null }, 'produce');
      const dock = screen.getByRole('complementary', { name: 'Preview' });
      expect(dock).toHaveTextContent('Nothing to play yet');
      expect(within(dock).queryByLabelText('Preview source')).toBeNull();
      expect(within(dock).queryByTitle('Composition document preview')).toBeNull();
      expect(within(dock).queryByLabelText('Draft excerpt preview')).toBeNull();
    });

    it('plays the storyboard animatic when the project has a track and shots but no document or finished excerpt', async () => {
      await openProject(PROJECT_WITH_CLIP, 'produce');
      const dock = screen.getByRole('complementary', { name: 'Preview' });
      expect(dock).toHaveTextContent('Storyboard animatic');
      expect(dock).not.toHaveTextContent('Nothing to play yet');
    });
  });
});

describe('MusicVideo main page project cards', () => {
  it('renders richly detailed cards for each project below the new project card', async () => {
    const projectWithRender = {
      ...PROJECT_WITH_CLIP,
      id: 'mv-render-1',
      name: 'Electric Skyline',
      status: 'complete',
      renderHistoryId: 'rh-final-1',
      audioAnalysis: { bpm: 124, durationSec: 210 },
      videoSettings: { backend: 'fal', modelId: 'hunyuan_video', generationMode: 'image', audioReactiveLora: 'reactive.safetensors' },
      concept: { universeId: 'cyber-tokyo', style: 'hyper-detailed synthwave' },
      visualSpec: { palette: ['#ff0055', '#00ffee'], references: [] },
      vocalStemFilename: 'electric-vocals.wav',
      midiTranscription: 'electric-midi.mid',
    };
    listMusicVideoProjects.mockResolvedValue([projectWithRender, PROJECT_NO_CLIP]);
    renderMV();

    // The header's New project button is the only one (no duplicate card buttons)
    expect(await screen.findByRole('button', { name: /New project/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New music video/i })).toBeNull();

    // Completed projects are available under All.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    // Project cards grid exists below new project card
    const grid = await screen.findByTestId('mv-project-grid');
    expect(grid).toBeInTheDocument();

    // Richly detailed cards rendered
    expect(within(grid).getByText('Electric Skyline')).toBeInTheDocument();
    expect(within(grid).getByText('No Clips')).toBeInTheDocument();

    // Rich configuration options and status on Electric Skyline card
    const card = screen.getByTestId('mv-project-card-mv-render-1');
    expect(within(card).getByText('complete')).toBeInTheDocument();
    expect(within(card).getByText('124 BPM')).toBeInTheDocument();
    expect(within(card).getByText('fal')).toBeInTheDocument();
    expect(within(card).getByText('hunyuan_video')).toBeInTheDocument();
    expect(within(card).getByText('I2V')).toBeInTheDocument();
    expect(within(card).getByText('Reactive')).toBeInTheDocument();
    expect(within(card).getByText('Vocal Stem')).toBeInTheDocument();
    expect(within(card).getByText('MIDI')).toBeInTheDocument();
    expect(within(card).getByText('cyber-tokyo')).toBeInTheDocument();
    expect(within(card).getByText(/hyper-detailed synthwave/i)).toBeInTheDocument();
    expect(within(card).getByText('Final video')).toBeInTheDocument();
  });

  it('navigates to project when clicking Open on its card', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);
    const openBtn = within(card).getByRole('button', { name: /^Open$/i });

    await act(async () => {
      fireEvent.click(openBtn);
    });

    // Navigates and loads the project board
    expect(await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name })).toBeInTheDocument();
  });

  it('renames a version straight from its project card', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    renderMV();
    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: `Rename v1 of ${PROJECT_WITH_CLIP.name}` }));
    });
    const input = await screen.findByLabelText('Project title');
    expect(input).toHaveValue(PROJECT_WITH_CLIP.name);
    updateMusicVideoProject.mockImplementationOnce(async (_id, patch) => ({ ...PROJECT_WITH_CLIP, ...patch }));
    fireEvent.change(input, { target: { value: 'Card Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { name: 'Card Renamed' }));
    await screen.findByRole('heading', { level: 2, name: 'Card Renamed' });
  });

  it('opens an existing final directly in Final render from the project card', async () => {
    const project = { ...PROJECT_WITH_CLIP, renderHistoryId: 'example-final' };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video']}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    const card = await screen.findByTestId(`mv-project-card-${project.id}`);
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Review video' })));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${project.id}/review`);
    expect(screen.getByRole('tab', { name: /^Final render/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('handles forking a project directly from its card', async () => {
    cloneMusicVideoProject.mockResolvedValueOnce({
      ...PROJECT_WITH_CLIP,
      id: 'mv-cloned-1',
      name: 'Neon Run (v2)',
      version: 2,
    });
    listMusicVideoProjects.mockResolvedValueOnce([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);

    const forkBtn = within(card).getByRole('button', { name: /Fork/i });
    await act(async () => {
      fireEvent.click(forkBtn);
    });
    expect(cloneMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, {}, { silent: true });
  });

  it('handles deleting a project directly from its card with confirmation', async () => {
    deleteMusicVideoProject.mockResolvedValueOnce({ ok: true });
    listMusicVideoProjects.mockResolvedValueOnce([PROJECT_WITH_CLIP]);
    renderMV();

    const card = await screen.findByTestId(`mv-project-card-${PROJECT_WITH_CLIP.id}`);

    const deleteBtn = within(card).getByRole('button', { name: `Delete project ${PROJECT_WITH_CLIP.name}` });
    fireEvent.click(deleteBtn);
    expect(within(card).getByText('Delete?')).toBeInTheDocument();

    const confirmBtn = within(card).getByRole('button', { name: `Confirm delete project ${PROJECT_WITH_CLIP.name}` });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(deleteMusicVideoProject).toHaveBeenCalledWith(PROJECT_WITH_CLIP.id, { silent: true });
  });

  describe('deleting from the project grid keeps the reader in place', () => {
    const A = { ...PROJECT_WITH_CLIP, id: 'mv-a', name: 'Alpha Video', createdAt: '2026-10-03T00:00:00.000Z' };
    const B = { ...PROJECT_NO_CLIP, id: 'mv-b', name: 'Bravo Video', createdAt: '2026-10-02T00:00:00.000Z' };
    const C = { ...PROJECT_WITH_CLIP, id: 'mv-c', name: 'Charlie Video', createdAt: '2026-10-01T00:00:00.000Z' };
    const confirmDeleteOf = async (project) => {
      const card = await screen.findByTestId(`mv-project-card-${project.id}`);
      fireEvent.click(within(card).getByRole('button', { name: `Delete project ${project.name}` }));
      const confirm = within(card).getByRole('button', { name: `Confirm delete project ${project.name}` });
      confirm.focus();
      await act(async () => { fireEvent.click(confirm); });
    };

    it('collapses the card, then moves focus to the next surviving card without scrolling', async () => {
      deleteMusicVideoProject.mockResolvedValueOnce({ ok: true });
      listMusicVideoProjects.mockResolvedValueOnce([A, B, C]);
      renderMV();
      const grid = await screen.findByTestId('mv-project-grid');
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
      await confirmDeleteOf(B);
      await waitFor(() => expect(screen.queryByTestId('mv-project-card-mv-b')).toBeNull());
      expect(screen.getByTestId('mv-project-grid')).toBe(grid);
      const charlie = screen.getByTestId('mv-project-card-mv-c');
      expect(document.activeElement).toBe(charlie.closest('[tabindex="-1"]'));
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
      focusSpy.mockRestore();
    });

    it('falls back to the previous card for the last one and to the grid when none remain', async () => {
      deleteMusicVideoProject.mockResolvedValue({ ok: true });
      listMusicVideoProjects.mockResolvedValueOnce([A, B]);
      renderMV();
      const grid = await screen.findByTestId('mv-project-grid');
      await confirmDeleteOf(B);
      await waitFor(() => expect(screen.queryByTestId('mv-project-card-mv-b')).toBeNull());
      expect(document.activeElement).toBe(screen.getByTestId('mv-project-card-mv-a').closest('[tabindex="-1"]'));
      await confirmDeleteOf(A);
      await waitFor(() => expect(screen.queryByTestId('mv-project-card-mv-a')).toBeNull());
      expect(screen.getByTestId('mv-project-grid')).toBe(grid);
      expect(document.activeElement).toBe(grid);
    });

    it('keeps the card and its delete action when the delete fails', async () => {
      deleteMusicVideoProject.mockRejectedValueOnce(new Error('Disk busy'));
      listMusicVideoProjects.mockResolvedValueOnce([A, B]);
      renderMV();
      await confirmDeleteOf(A);
      await waitFor(() => expect(deleteMusicVideoProject).toHaveBeenCalledTimes(1));
      const card = screen.getByTestId('mv-project-card-mv-a');
      expect(card.closest('[inert]')).toBeNull();
      expect(within(card).getByRole('button', { name: `Delete project ${A.name}` })).toBeInTheDocument();
      expect(screen.getByTestId('mv-project-card-mv-b')).toBeInTheDocument();
    });
  });

  it('organizes project cards with the newest one first', async () => {
    const older = { ...PROJECT_WITH_CLIP, id: 'mv-old', name: 'Older Video', createdAt: '2026-09-01T00:00:00.000Z' };
    const middle = { ...PROJECT_NO_CLIP, id: 'mv-mid', name: 'Middle Video', createdAt: '2026-09-15T00:00:00.000Z' };
    const newest = { ...PROJECT_WITH_CLIP, id: 'mv-new', name: 'Newest Video', createdAt: '2026-10-01T00:00:00.000Z' };

    listMusicVideoProjects.mockResolvedValueOnce([older, middle, newest]);
    renderMV();

    const grid = await screen.findByTestId('mv-project-grid');
    const cards = within(grid).getAllByTestId(/^mv-project-card-/);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute('data-testid', 'mv-project-card-mv-new');
    expect(cards[1]).toHaveAttribute('data-testid', 'mv-project-card-mv-mid');
    expect(cards[2]).toHaveAttribute('data-testid', 'mv-project-card-mv-old');
  });
});

describe('direct production review navigation', () => {
  it.each([true, false])('opens replacement controls for a registered proof (approved: %s) and restores navigation', async (approved) => {
    const project = { ...PROJECT_ANALYZED,
      productionReview: { proof: { excerptId: 'proof-1', basis: 'old' }, approvals: approved ? { proof: { excerptId: 'proof-1' } } : {} },
      excerpts: [{ id: 'proof-1', status: 'complete', filename: 'proof.mp4', startSec: 0, endSec: 12, dependencyState: { status: 'stale' } }],
    };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video/mv-3/review']}><LocationProbe /><NavTo to={-1} /><NavTo to={1} />{MV_ROUTES}</MemoryRouter>);
    const link = await screen.findByRole('link', { name: 'Open proof controls' });
    expect(link).toHaveAttribute('href', '/music-video/mv-3/produce#mv-review-render');
    fireEvent.click(link);
    expect(await screen.findByRole('button', { name: 'Render a new proof' })).toBeEnabled();
    await waitFor(() => expect(document.getElementById('mv-review-render')).toHaveFocus());
    expect(screen.getByTestId('loc')).toHaveTextContent('/produce#mv-review-render');
    fireEvent.click(screen.getByRole('button', { name: 'go--1' }));
    expect(await screen.findByRole('link', { name: 'Open proof controls' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'go-1' }));
    expect(await screen.findByRole('button', { name: 'Render a new proof' })).toBeEnabled();
  });

  it('focuses the exact step on repeated clicks and restores its deep link with Back/Forward without approval', async () => {
    const project = { ...PROJECT_ANALYZED, scenes: [], castAndSets: { status: 'skipped' }, composition: { mode: 'document' },
      productionReview: { draft: { storyboardSource: 'document', storyboard: [{ id: 'shot-1' }, { id: 'shot-2' }] } },
      productionReadiness: { readyForProduction: false, basis: {}, art: { approved: false, problems: [] },
        storyboard: { approved: false, problems: ['Approve art first'] }, proof: { approved: false, problems: ['Approve storyboard first'] } } };
    listMusicVideoProjects.mockResolvedValue([project]);
    render(<MemoryRouter initialEntries={['/music-video/mv-3/review']}><LocationProbe /><NavTo to={-1} /><NavTo to={1} />{MV_ROUTES}</MemoryRouter>);
    // A skipped sheet left nothing written, so the header sends the director to write it, not to approve it.
    const action = await screen.findByRole('button', { name: 'Write art direction' });
    expect(screen.getByLabelText('Project').querySelector(`option[value="${project.id}"]`).textContent).toBe(project.name);
    fireEvent.click(action);
    // The editor mounts folded at the bottom of the Look step; the jump unfolds it and focuses its first field.
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
    expect(screen.getByLabelText('Cast guide').closest('details').open).toBe(true);
    expect(screen.getByTestId('loc')).toHaveTextContent('/cast-sets#mv-art-direction-editor');
    // With nothing to review the approval is one quiet line, not instructions and a disabled button.
    const art = document.getElementById('mv-review-art');
    expect(art).toHaveAccessibleName('Approve: Art direction');
    expect(art).toHaveTextContent('Opens once the art direction is written and a visual guide is chosen.');
    expect(within(art).queryByRole('button', { name: 'Approve art direction' })).toBeNull();
    expect(art.className).not.toContain('border-port-accent');
    expect(screen.queryByLabelText('Instance password for this approval')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'go--1' }));
    expect(screen.getByTestId('loc')).toHaveTextContent('/review');
    fireEvent.click(screen.getByRole('button', { name: 'go-1' }));
    await waitFor(() => expect(screen.getByLabelText('Cast guide')).toHaveFocus());
  });
});

describe('stage checklist and project options', () => {
  it('shows the Previz doneWhen line under the step title instead of hiding it behind an empty checklist', async () => {
    const previzStage = MUSIC_VIDEO_STAGES.find((stage) => stage.id === 'previz');
    expect(previzStage?.doneWhen).toBeTruthy();
    await openProject(PROJECT_NO_CLIP, 'previz');
    expect(screen.getByText(previzStage.doneWhen)).toBeInTheDocument();
  });
});

describe('MusicVideo deep-linking and drawer URL routing (#10168)', () => {
  it('opens scene expanded when loaded via /music-video/:projectId/:stage/scene/:sceneId', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/board/scene/s1`]}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const shot = document.getElementById('scene-s1');
    expect(shot).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toContainElement(shot);
  });

  it('routes /music-video/:projectId/scene/:sceneId directly to board stage with scene expanded', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/scene/s1`]}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    const shot = document.getElementById('scene-s1');
    expect(shot).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toContainElement(shot);
  });

  it('opens create project drawer via ?new=project and autonomous drawer via ?new=autonomous', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    const { unmount } = render(
      <MemoryRouter initialEntries={['/music-video?new=project']}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={['/music-video?new=autonomous']}>
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Autonomous music video' })).toBeInTheDocument();
  });

  it.each([
    { drawer: 'project', open: 'New project', title: 'New music video', input: 'Name', submit: 'Create autopilot project' },
    { drawer: 'autonomous', open: 'Autonomous', title: 'Autonomous music video', input: 'Prompt', submit: 'Start autonomous video' },
  ])('opens the workspace after submitting the $drawer drawer and returns to the index on Back', async ({ drawer, open, title, input, submit }) => {
    const project = { ...PROJECT_NO_CLIP, id: 'mv-created', name: 'Example music video', trackId: null };
    const autonomous = drawer === 'autonomous';
    const start = autonomous ? startAutonomousMusicVideo : createMusicVideoProject;
    start.mockResolvedValueOnce(autonomous ? { project } : project);
    if (autonomous) providerModelsState.providers = [{ id: 'example-api', name: 'Example API', type: 'api', defaultModel: 'example-model' }];
    const SearchProbe = () => <span data-testid="drawer-search">{useLocation().search}</span>;

    try {
      render(
        <MemoryRouter initialEntries={['/music-video']}>
          <LocationProbe />
          <SearchProbe />
          <NavTo to={-1} />
          {MV_ROUTES}
        </MemoryRouter>,
      );
      await act(async () => fireEvent.click(screen.getByRole('button', { name: open })));
      const dialog = await screen.findByRole('dialog', { name: title });
      expect(screen.getByTestId('drawer-search')).toHaveTextContent(`?new=${drawer}`);
      fireEvent.change(within(dialog).getByLabelText(input), { target: { value: project.name } });
      if (autonomous) {
        fireEvent.change(within(dialog).getByLabelText('Code authoring provider'), { target: { value: 'example-api' } });
      }
      const submitButton = within(dialog).getByRole('button', { name: submit });
      expect(submitButton).toBeEnabled();
      await act(async () => fireEvent.click(submitButton));

      expect(start).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('loc').textContent).toBe(`/music-video/${project.id}`);
      expect(screen.getByTestId('drawer-search')).toBeEmptyDOMElement();
      expect(await screen.findByRole('heading', { level: 2, name: project.name })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument();

      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'go--1' })));
      expect(screen.getByTestId('loc').textContent).toBe('/music-video');
      expect(screen.getByTestId('drawer-search')).toBeEmptyDOMElement();
      expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument();
    } finally {
      providerModelsState.providers = [];
    }
  });

  it('updates the URL when a scene is expanded and removes it when collapsed', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    render(
      <MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/produce`]}>
        <LocationProbe />
        {MV_ROUTES}
      </MemoryRouter>
    );
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce`);

    expect(document.getElementById('scene-s1')).toBeNull();
    const thumbnail = screen.getByRole('button', { name: /^Open (Shot 1|Scene 1)/ });
    await act(async () => fireEvent.click(thumbnail));
    expect(document.getElementById('scene-s1')).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close shot' })));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce`);
    expect(document.getElementById('scene-s1')).toBeNull();
    expect(thumbnail).toHaveFocus();
    await settle();
  });

  it('keeps scene routing and focus together when j/k switches the inspector', async () => {
    const first = { ...PROJECT_WITH_CLIP.scenes[0], sceneId: 's1', order: 0 };
    listMusicVideoProjects.mockResolvedValue([{ ...PROJECT_WITH_CLIP, scenes: [first, { ...first, sceneId: 's2', order: 1 }] }]);
    render(<MemoryRouter initialEntries={[`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`]}><LocationProbe />{MV_ROUTES}</MemoryRouter>);
    await screen.findByRole('heading', { level: 2, name: PROJECT_WITH_CLIP.name });
    // The heading can land a commit before the inspector; wait for the scene the keys act on.
    await waitFor(() => expect(document.querySelector('#scene-s1 [data-shot-heading]')).not.toBeNull());
    document.querySelector('#scene-s1 [data-shot-heading]').focus();
    await act(async () => fireEvent.keyDown(document.activeElement, { key: 'j' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s2`);
    expect(document.querySelector('#scene-s1')).toBeNull();
    expect(document.querySelector('#scene-s2 [data-shot-heading]')).toHaveFocus();
    expect(document.querySelectorAll('video[src^="/data/videos/"]')).toHaveLength(1);
    await act(async () => fireEvent.keyDown(document.activeElement, { key: 'k' }));
    expect(screen.getByTestId('loc')).toHaveTextContent(`/music-video/${PROJECT_WITH_CLIP.id}/produce/scene/s1`);
    expect(document.querySelector('#scene-s2')).toBeNull();
    expect(document.querySelector('#scene-s1 [data-shot-heading]')).toHaveFocus();
  });

  it('closes open drawer on back navigation', async () => {
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);
    let routerNavigate;
    function NavigateGrabber() {
      const navigate = useNavigate();
      routerNavigate = navigate;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/music-video', '/music-video?new=project']}>
        <NavigateGrabber />
        {MV_ROUTES}
      </MemoryRouter>
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    act(() => routerNavigate(-1));
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2, name: 'New music video' })).not.toBeInTheDocument());
  });

  it('renders ListLoadError with retry when universe names fail to load in create project drawer', async () => {
    const { listUniverseNames } = await import('../services/apiUniverseBuilder.js');
    listUniverseNames.mockReset();
    listUniverseNames.mockRejectedValueOnce(new Error('Universes offline'));
    listMusicVideoProjects.mockResolvedValue([PROJECT_WITH_CLIP]);

    render(
      <MemoryRouter initialEntries={['/music-video?new=project']}>
        {MV_ROUTES}
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { level: 2, name: 'New music video' })).toBeInTheDocument();
    expect(await screen.findByText(/Could not load universes/)).toBeInTheDocument();

    listUniverseNames.mockResolvedValueOnce([{ id: 'u1', name: 'Cyberverse' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByText(/Could not load universes/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Cyberverse' })).toBeInTheDocument();
  });
});
