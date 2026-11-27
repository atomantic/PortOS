import { expect, it, vi } from 'vitest';
import { checkConversationalGemmaAccess } from './conversationalGemmaAccess.js';

it('does not contact the Hub without an existing read token', async () => {
  const fetchHead = vi.fn();
  await expect(checkConversationalGemmaAccess({ readToken: async () => null, fetchHead }))
    .resolves.toEqual({ status: 'token-required' });
  expect(fetchHead).not.toHaveBeenCalled();
});

it.each([[200, null, 'ready'], [302, null, 'ready'], [401, 'GatedRepo', 'terms-required'],
  [401, null, 'token-required'], [403, null, 'terms-required']])('maps Hub status %s / %s to %s', async (code, hint, status) => {
  const response = new Response(null, { status: code, headers: hint ? { 'x-error-code': hint } : {} });
  const fetchHead = vi.fn(async () => response);
  await expect(checkConversationalGemmaAccess({ readToken: async () => 'hf_example', fetchHead })).resolves.toEqual({ status });
  expect(fetchHead).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/huggingface\.co\/Trelis\/.*\/model-00001-of-00007\.safetensors$/), expect.objectContaining({
    method: 'HEAD', redirect: 'manual', headers: { Authorization: 'Bearer hf_example' },
  }));
});

it('does not mistake throttling or service errors for gated access', async () => {
  await expect(checkConversationalGemmaAccess({ readToken: async () => 'hf_example',
    fetchHead: async () => new Response(null, { status: 429 }) })).rejects.toMatchObject({ code: 'HF_ACCESS_CHECK_UNAVAILABLE' });
});
