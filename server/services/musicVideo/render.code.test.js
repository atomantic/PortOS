import { expect, it, vi } from 'vitest';

vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(async () => ({ id: 'reviewed-project' })), updateProject: vi.fn() }));
const { renderMusicVideo } = await import('./render.js');

it('refuses an unbound directory override instead of rendering different content under a project approval', async () => {
  await expect(renderMusicVideo('reviewed-project', { codeDirectory: 'compositions/unreviewed' }))
    .rejects.toMatchObject({ code: 'MUSIC_VIDEO_UNREVIEWED_DIRECTORY' });
});
