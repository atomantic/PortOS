import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { MUSIC_VIDEO_PAGES, MUSIC_VIDEO_STAGES } from '../lib/musicVideoStages.js';

vi.mock('../services/socket', () => ({ default: { on: () => {}, off: () => {}, emit: () => {}, connected: true, id: 'test-socket' } }));

const STAGE_FILES = {
  setup: 'SetupStage', story: 'StoryStage', 'cast-sets': 'CastSetsStage', board: 'PlanStage', previz: 'PrevizStage', produce: 'ProduceStage',
  review: 'ReviewStage', publish: 'PublishStage', assets: 'AssetsStage', 'making-of': 'MakingOfStage', cleanup: 'CleanupStage', editor: 'EditorStage',
};
const STAGE_IDS = [...MUSIC_VIDEO_STAGES, ...MUSIC_VIDEO_PAGES].map((entry) => entry.id);
const PROJECT = { id: 'mv-test-1', name: 'Test Project', scenes: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Which split modules the page imported (#16565). A mock factory runs on its module's first
// import, and `vi.doMock` after `vi.resetModules` re-arms it, so every test starts from a page
// that has fetched nothing.
let loaded;
// How long a stage chunk takes to arrive. React holds a quick reveal back (~300ms) and commits
// it with its parent, so only a slower one, like a real chunk on a slow link, shows the fallback.
let chunkDelayMs;
let MusicVideo;
beforeEach(async () => {
  vi.resetModules();
  loaded = new Set();
  chunkDelayMs = 0;
  vi.doMock('../components/musicVideo/ProjectWorkspace.jsx', async (importOriginal) => {
    loaded.add('workspace');
    return importOriginal();
  });
  for (const [id, file] of Object.entries(STAGE_FILES)) {
    vi.doMock(`../components/musicVideo/stages/${file}.jsx`, async () => {
      loaded.add(id);
      if (chunkDelayMs) await new Promise((resolve) => { setTimeout(resolve, chunkDelayMs); });
      return { default: () => <button type="button" id={`mv-anchor-${id}`} data-testid={`stage-${id}`} /> };
    });
  }
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = new URL(String(typeof input === 'string' ? input : input.url), 'http://localhost');
    if (url.pathname === '/api/music-video' && url.searchParams.get('summary') === '1') {
      return json({ items: [PROJECT], total: 1, nextCursor: null });
    }
    if (url.pathname === `/api/music-video/${PROJECT.id}`) return json(PROJECT);
    return json([]);
  }));
  ({ default: MusicVideo } = await import('./MusicVideo.jsx'));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/music-video" element={<MusicVideo />} />
      <Route path="/music-video/:projectId" element={<MusicVideo />} />
      <Route path="/music-video/:projectId/:stage" element={<MusicVideo />} />
    </Routes>
  </MemoryRouter>,
);

it('lists projects without fetching the workspace or any stage', async () => {
  renderAt('/music-video');
  expect(await screen.findByText('Projects (1)')).toBeTruthy();
  expect([...loaded]).toEqual([]);
});

it.each(STAGE_IDS)('a deep link to %s fetches only that stage and lands on its anchor', async (id) => {
  chunkDelayMs = 600;
  renderAt(`/music-video/${PROJECT.id}/${id}#mv-anchor-${id}`);
  const panel = await screen.findByTestId(`stage-${id}`);
  expect([...loaded].sort()).toEqual(['workspace', id].sort());
  // The anchor lives inside the lazily loaded panel, so landing has to wait for it to mount.
  await waitFor(() => expect(document.activeElement).toBe(panel));
});

it('switching steps fetches and renders each stage on first open', async () => {
  renderAt(`/music-video/${PROJECT.id}/setup`);
  await screen.findByTestId('stage-setup');
  for (const id of STAGE_IDS.filter((stage) => stage !== 'setup')) {
    expect(loaded.has(id)).toBe(false);
    fireEvent.click(screen.getAllByRole('tab').find((tab) => tab.id === `tab-${id}`));
    expect(await screen.findByTestId(`stage-${id}`)).toBeTruthy();
    expect(loaded.has(id)).toBe(true);
  }
});
