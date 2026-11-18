import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const getVisionModels = vi.fn();
vi.mock('../services/apiLocalLlm', () => ({ getVisionModels: (...args) => getVisionModels(...args) }));

import useVisionModelIds from './useVisionModelIds.js';

it('keeps local vision ids scoped to their provider and seeds empty local providers', async () => {
  getVisionModels.mockResolvedValue({
    models: [
      { backend: 'ollama', providerId: 'ollama', id: 'vision-model' },
      { backend: 'cli', providerId: 'codex', id: 'cli-model' },
    ],
  });

  const { result } = renderHook(() => useVisionModelIds());

  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.idsByProvider).toEqual({
    ollama: new Set(['vision-model']),
    lmstudio: new Set(),
  });
});
