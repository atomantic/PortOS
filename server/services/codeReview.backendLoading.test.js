import { afterEach, expect, it, vi } from 'vitest';
import { mockJsonResponse } from '../lib/testHelper.js';

vi.mock('./settings.js', () => ({
  getSettings: async () => ({}),
  settingsEvents: { on: vi.fn() },
}));
vi.mock('./lmStudioManager.js', () => { throw new Error('Manager unavailable'); });
vi.mock('./ollamaManager.js', () => { throw new Error('Manager unavailable'); });

import { getCodeReviewDefaults, runLocalCodeReview } from './codeReview.js';

afterEach(() => vi.unstubAllGlobals());

it('reads defaults without managers and reviews an explicit endpoint when capability loading fails', async () => {
  expect(await getCodeReviewDefaults()).toMatchObject({ reviewers: [] });
  const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
    choices: [{ message: { content: 'No findings.' } }],
  }));
  vi.stubGlobal('fetch', fetchMock);

  expect(await runLocalCodeReview({
    backend: 'ollama', model: 'example-coder', effort: 'high',
    diff: 'example diff', baseUrl: 'http://localhost:11434',
  })).toMatchObject({ ok: true, findings: 'No findings.' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reasoning_effort: 'high' });
});
