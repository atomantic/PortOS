/**
 * Wake a PortOS-managed local provider before the shared AI Toolkit runner
 * sends its request.
 *
 * The individual managers own provider recognition and lifecycle policy. This
 * module only gives the runner one provider-agnostic hook, so adding lazy start
 * for a daemon cannot leave the toolkit path behind while direct AI calls work.
 */

import { ensureProviderReady as ensureOllamaProviderReady, isOllamaProvider } from './ollamaManager.js';
import { ensureMtplxProviderReady, isMtplxProvider } from './mtplxServerManager.js';

const failedReadiness = (runtime, result) => ({
  ...result,
  error: `${runtime} is not running and PortOS could not start it: ${result?.error || 'unknown error'}`,
});

/**
 * @returns {Promise<{success:boolean,error?:string}>}
 */
export async function ensureProviderReadyForExecution(provider) {
  if (isOllamaProvider(provider)) {
    const result = await ensureOllamaProviderReady(provider);
    return result.success ? result : failedReadiness('Ollama', result);
  }

  if (isMtplxProvider(provider)) {
    const result = await ensureMtplxProviderReady(provider);
    return result.success ? result : failedReadiness('MTPLX', result);
  }

  return { success: true };
}
