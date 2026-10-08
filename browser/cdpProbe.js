/** Read a CDP version response under one deadline for headers and body. */
export async function probeCdpVersion(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  return fetch(url, { signal: controller.signal }).then(async res => {
    if (!res.ok) return null;
    // A successful HTTP response can still be malformed JSON or a non-CDP
    // service. Both remain unavailable, just like a failed connection.
    const version = await res.json();
    return version?.webSocketDebuggerUrl ? version : null;
  }).catch(() => null).finally(() => clearTimeout(timeout));
}
