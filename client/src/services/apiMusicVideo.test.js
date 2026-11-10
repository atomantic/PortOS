import { expect, it, vi } from 'vitest';
import { request } from './apiCore.js';
import { markMusicVideoPoolAssets, selectMusicVideoSceneTake } from './apiMusicVideo.js';

vi.mock('./apiCore.js', () => ({ request: vi.fn() }));

// These guards must cross the JSON boundary, rather than becoming ignored fetch options.
it('serializes conditional Undo guards while preserving unguarded take calls', async () => {
  await markMusicVideoPoolAssets('video', [{ kind: 'image', assetId: 'frame.png' }], null, { expectedMark: 'bad', silent: true });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ items: [{ kind: 'image', assetId: 'frame.png' }], mark: null, expectedMark: 'bad' });
  expect(request.mock.calls[0][1]).not.toHaveProperty('expectedMark');
  await selectMusicVideoSceneTake('video', 'scene', 'take', { expectedSelectedAssetId: null, silent: true });
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ expectedSelectedAssetId: null });
  expect(request.mock.calls[1][1]).not.toHaveProperty('expectedSelectedAssetId');
  await selectMusicVideoSceneTake('video', 'scene', 'take', { silent: true });
  expect(request.mock.calls[2][1]).not.toHaveProperty('body');
});
