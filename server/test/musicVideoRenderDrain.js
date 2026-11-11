import { expect, vi } from 'vitest';

// Terminal events precede trailing permit cleanup. Drain the active project
// maps too; settled SSE jobs deliberately remain cached for reconnecting clients.
export async function waitForMusicVideoRenderDrain() {
  const { maintenance } = await import('../lib/maintenanceAdmission.js');
  const { listActiveRenders } = await import('../services/renderActivity.js');
  await vi.waitFor(() => {
    const { state, blockers } = maintenance.status();
    const renders = listActiveRenders().filter(({ kind }) => kind.startsWith('music-video-'));
    const kinds = blockers.map(({ kind }) => kind).concat(renders.map(({ kind }) => kind));
    expect({ state, blockers, renders }, `Music-video cleanup still pending: ${kinds.join(', ') || state}`)
      .toEqual({ state: 'normal', blockers: [], renders: [] });
  }, { timeout: 5000, interval: 10 });
}
