import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const root = await mkdtemp(join(tmpdir(), 'sprite-hook-store-'));
vi.mock('./paths.js', async (importOriginal) => ({
  ...await importOriginal(), spriteDir: (id) => join(root, id),
}));
vi.mock('../mediaJobQueue/index.js', () => ({ mediaJobEvents: {}, listJobs: () => [] }));
const collect = vi.fn();
vi.mock('./localAnimationRender.js', () => ({ collectLocalAnimationClip: (...args) => collect(...args) }));
const attach = vi.fn();
vi.mock('./walk.js', () => ({ attachTuiWalkResult: (...args) => attach(...args) }));
vi.mock('./animationTrackWorkflow.js', () => ({ attachTrackTuiResult: (...args) => attach(...args) }));
const { __testing: { settleSpriteAnimationJob } } = await import('./localAnimationJobHook.js');
afterAll(() => rm(root, { recursive: true, force: true }));

describe('local sprite render retry persistence', () => {
  it('preserves unreadable runs, then files the repaired retry without losing prior fields', async () => {
    const path = join(root, 'hero', 'runs', 'run-1', 'animation-run.json');
    await mkdir(join(path, '..'), { recursive: true });
    const job = { id: 'job-new', kind: 'video', status: 'completed', params: { spriteAnimation: { recordId: 'hero', runId: 'run-1', track: 'walk', direction: 'east' } } };
    await writeFile(path, '{');
    await expect(settleSpriteAnimationJob(job)).rejects.toThrow(/Unreadable/);
    expect(await readFile(path, 'utf8')).toBe('{');
    expect(collect).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    await writeFile(path, JSON.stringify({ id: 'run-1', status: 'error', jobId: 'old', notes: 'preserve' }));
    await expect(settleSpriteAnimationJob(job)).resolves.toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ jobId: 'job-new', notes: 'preserve' });
    expect(attach).toHaveBeenCalledOnce();
    await rm(path);
    await expect(settleSpriteAnimationJob(job)).resolves.toBe(false);
  });
});
