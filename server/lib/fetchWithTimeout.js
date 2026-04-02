/**
 * Fetch wrapper with AbortController timeout.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs=15000] - Timeout in milliseconds
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const timeoutId = hasTimeout ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let signal = controller.signal;
  let abortHandler;
  if (options.signal) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([controller.signal, options.signal]);
    } else {
      // Fallback: propagate caller abort to our controller
      abortHandler = () => controller.abort();
      options.signal.addEventListener('abort', abortHandler, { once: true });
      if (options.signal.aborted) {
        controller.abort();
      }
    }
  }

  try {
    const response = await fetch(url, { ...options, signal });
    return response;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (options.signal && abortHandler) {
      options.signal.removeEventListener('abort', abortHandler);
    }
  }
}
