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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}
