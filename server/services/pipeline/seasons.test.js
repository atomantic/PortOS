import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const svc = await import('./seasons.js');

async function setupSeries() {
  return seriesSvc.createSeries({ name: 'Salt Run', logline: 'L' });
}

describe('pipeline seasons service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('listSeasons returns [] for a fresh series', async () => {
    const s = await setupSeries();
    expect(await svc.listSeasons(s.id)).toEqual([]);
  });

  it('createSeason inserts and assigns a default number if absent', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    expect(a.id).toMatch(/^sea-/);
    expect(a.number).toBe(1);
    const b = await svc.createSeason(s.id, { title: 'Aftermath' });
    expect(b.number).toBe(2);
  });

  it('createSeason preserves explicit number', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Mid-season', number: 5 });
    expect(a.number).toBe(5);
    const b = await svc.createSeason(s.id, { title: 'Finale' });
    // Auto-numbers off the peak — 6, not 2.
    expect(b.number).toBe(6);
  });

  it('createSeason rejects when title and number are both missing', async () => {
    const s = await setupSeries();
    await expect(svc.createSeason(s.id, {})).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('createSeason rejects past SEASONS_PER_SERIES_MAX', async () => {
    const s = await setupSeries();
    const { ARC_LIMITS } = await import('../../lib/storyArc.js');
    for (let i = 1; i <= ARC_LIMITS.SEASONS_PER_SERIES_MAX; i++) {
      await svc.createSeason(s.id, { title: `s${i}` });
    }
    await expect(svc.createSeason(s.id, { title: 'overflow' }))
      .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('updateSeason patches fields and refreshes updatedAt', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await new Promise((r) => setTimeout(r, 5));
    const patched = await svc.updateSeason(s.id, a.id, { logline: 'New logline', status: 'verified' });
    expect(patched.logline).toBe('New logline');
    expect(patched.status).toBe('verified');
    expect(patched.title).toBe('Pilot'); // unchanged
    expect(patched.updatedAt > a.updatedAt).toBe(true);
    expect(patched.createdAt).toBe(a.createdAt);
  });

  it('updateSeason re-sorts when number changes', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'A', number: 1 });
    const b = await svc.createSeason(s.id, { title: 'B', number: 2 });
    await svc.updateSeason(s.id, a.id, { number: 3 });
    const seasons = await svc.listSeasons(s.id);
    expect(seasons.map((x) => x.title)).toEqual(['B', 'A']);
  });

  it('updateSeason throws ERR_NOT_FOUND for unknown season id', async () => {
    const s = await setupSeries();
    await expect(svc.updateSeason(s.id, 'sea-nope', { title: 'x' }))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deleteSeason removes the season + un-groups child issues by default', async () => {
    const s = await setupSeries();
    const sea = await svc.createSeason(s.id, { title: 'Pilot' });
    const iss = await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1' });
    await issuesSvc.updateIssue(iss.id, { seasonId: sea.id, arcPosition: 1 });

    const result = await svc.deleteSeason(s.id, sea.id);
    expect(result).toEqual({ id: sea.id, reassignedIssueCount: 1, reassignedTo: null });

    const remainingSeasons = await svc.listSeasons(s.id);
    expect(remainingSeasons).toEqual([]);

    const reloaded = await issuesSvc.getIssue(iss.id);
    expect(reloaded.seasonId).toBe(null);
    expect(reloaded.arcPosition).toBe(1); // arcPosition unchanged — only seasonId clears
  });

  it('deleteSeason reassigns child issues to reassignTo', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    const b = await svc.createSeason(s.id, { title: 'Hiatus' });
    const iss = await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1' });
    await issuesSvc.updateIssue(iss.id, { seasonId: a.id });

    await svc.deleteSeason(s.id, a.id, { reassignTo: b.id });
    const reloaded = await issuesSvc.getIssue(iss.id);
    expect(reloaded.seasonId).toBe(b.id);
  });

  it('deleteSeason rejects reassignTo pointing at non-existent sibling', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await expect(svc.deleteSeason(s.id, a.id, { reassignTo: 'sea-ghost' }))
      .rejects.toMatchObject({ code: svc.ERR_REASSIGN_TARGET });
    // No mutation should have happened — season still there.
    const seasons = await svc.listSeasons(s.id);
    expect(seasons.map((x) => x.id)).toEqual([a.id]);
  });

  it('deleteSeason rejects reassignTo pointing at itself', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await expect(svc.deleteSeason(s.id, a.id, { reassignTo: a.id }))
      .rejects.toMatchObject({ code: svc.ERR_REASSIGN_TARGET });
  });

  it('deleteSeason throws ERR_NOT_FOUND for unknown season id', async () => {
    const s = await setupSeries();
    await expect(svc.deleteSeason(s.id, 'sea-nope'))
      .rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  // ─── Per-season editorial lock ───────────────────────────────────────────
  // A locked season freezes its content fields against rewriters; only an
  // unlock (locked: false) or a production-status flip may patch through.
  // Pairs with `LOCKED_SEASON_ALLOWED_KEYS` server-side.
  it('updateSeason allows toggling lock on + off without other fields', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    const locked = await svc.updateSeason(s.id, a.id, { locked: true });
    expect(locked.locked).toBe(true);
    const unlocked = await svc.updateSeason(s.id, a.id, { locked: false });
    expect(unlocked.locked).toBe(false);
  });

  it('updateSeason refuses content patches on a locked season', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await svc.updateSeason(s.id, a.id, { locked: true });
    await expect(svc.updateSeason(s.id, a.id, { logline: 'New' }))
      .rejects.toMatchObject({ code: svc.ERR_LOCKED });
    // Content unchanged.
    const reloaded = (await svc.listSeasons(s.id))[0];
    expect(reloaded.logline).toBe('');
    expect(reloaded.locked).toBe(true);
  });

  it('updateSeason allows status flips on a locked season', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await svc.updateSeason(s.id, a.id, { locked: true });
    // status is in `LOCKED_SEASON_ALLOWED_KEYS` — production workflow can
    // advance without an editorial unlock.
    const patched = await svc.updateSeason(s.id, a.id, { status: 'in-production' });
    expect(patched.status).toBe('in-production');
    expect(patched.locked).toBe(true);
  });

  it('updateSeason allows unlock + edit in one patch', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await svc.updateSeason(s.id, a.id, { locked: true });
    const patched = await svc.updateSeason(s.id, a.id, { locked: false, logline: 'Reopened' });
    expect(patched.locked).toBe(false);
    expect(patched.logline).toBe('Reopened');
  });

  it('deleteSeason refuses to delete a locked season', async () => {
    const s = await setupSeries();
    const a = await svc.createSeason(s.id, { title: 'Pilot' });
    await svc.updateSeason(s.id, a.id, { locked: true });
    await expect(svc.deleteSeason(s.id, a.id))
      .rejects.toMatchObject({ code: svc.ERR_LOCKED });
    // Season still present.
    expect((await svc.listSeasons(s.id)).map((x) => x.id)).toEqual([a.id]);
  });
});
