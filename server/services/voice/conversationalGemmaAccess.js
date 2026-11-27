// Check access to the pinned Conversational Gemma release without downloading its weights.
import { getHfToken } from '../hfToken.js';
import { ServerError } from '../../lib/errorHandler.js';
import { CONVERSATIONAL_GEMMA } from '../../lib/voiceModelCatalog.js';

const REVISION = '29055ace878329e2f8b216ecd7edcaefccb27969';

export async function checkConversationalGemmaAccess({ readToken = getHfToken, fetchHead = fetch } = {}) {
  const token = await readToken();
  if (!token) return { status: 'token-required' };
  const unavailable = () => new ServerError('Could not verify Conversational Gemma access with Hugging Face. Try again shortly.', {
    status: 502, code: 'HF_ACCESS_CHECK_UNAVAILABLE',
  });
  // Probe the actual files, not public model metadata. Do not follow redirects
  // or expose Hugging Face headers that may include a signed download URL.
  const response = await fetchHead(`${CONVERSATIONAL_GEMMA.url}/resolve/${REVISION}/model-00001-of-00007.safetensors`, {
    method: 'HEAD', redirect: 'manual', headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  }).catch(() => { throw unavailable(); });
  if (response.ok || [301, 302, 303, 307, 308].includes(response.status)) return { status: 'ready' };
  if (response.headers.get('x-error-code') === 'GatedRepo' || response.status === 403) return { status: 'terms-required' };
  if (response.status === 401) return { status: 'token-required' };
  throw unavailable();
}
