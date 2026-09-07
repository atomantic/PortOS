/**
 * Classify why a federated peer probe failed so operators (and logs) can tell
 * "local forward not listening" apart from "tunnel cannot dial" apart from
 * "tunnel carried bytes but /api/system/health/details failed".
 *
 * Messages must never include a full tc… capability — callers pass already-
 * redacted tunnelError text from listTailcatForwards / redactTailcatDiagnostics.
 */

export const PROBE_CLASS = Object.freeze({
  OK: 'ok',
  LOCAL_REFUSED: 'local_refused',
  TUNNEL_DIAL: 'tunnel_dial',
  PROBE_HTTP: 'probe_http',
  PROBE_TIMEOUT: 'probe_timeout',
  AUTH_REQUIRED: 'auth_required',
  DNS: 'dns',
  HOST_UNREACHABLE: 'host_unreachable',
  UNKNOWN: 'unknown',
});

const TUNNEL_DIAL_HINT = /dial remote|context deadline exceeded|connection reset|socket hang up|ECONNRESET|recv failure/i;

/**
 * @param {Error|object|null} err
 * @param {{ peer?: object, tunnelError?: string|null, probeTimeoutMs?: number }} [ctx]
 * @returns {{ class: string, message: string, httpStatus: number|null }}
 */
export function classifyPeerProbeFailure(err, { peer = null, tunnelError = null, probeTimeoutMs = 10_000 } = {}) {
  const httpStatus = Number.isFinite(err?.httpStatus) ? err.httpStatus : null;
  const code = err?.code;
  const rawMessage = err?.message || String(err || 'unknown error');
  const isTailcat = peer?.transport === 'tailcat';

  if (httpStatus === 401 || httpStatus === 403) {
    return {
      class: PROBE_CLASS.AUTH_REQUIRED,
      message: `Authentication required (HTTP ${httpStatus}) — set a username/password for this peer in the Instances UI`,
      httpStatus,
    };
  }

  // Fresh tunnel dial failure from the live tailcat child — prefer that over a
  // generic timeout/reset, which is how the same failure usually surfaces to fetch.
  if (isTailcat && tunnelError) {
    return {
      class: PROBE_CLASS.TUNNEL_DIAL,
      message: `Tunnel dial failure — ${tunnelError}`,
      httpStatus,
    };
  }

  if (code === 'ENOTFOUND') {
    return {
      class: PROBE_CLASS.DNS,
      message: `DNS lookup failed for ${peer?.host || peer?.address || 'peer'} — is Tailscale MagicDNS up?`,
      httpStatus,
    };
  }

  if (code === 'ECONNREFUSED') {
    if (isTailcat) {
      return {
        class: PROBE_CLASS.LOCAL_REFUSED,
        message: 'Local connection refused — tailcat forward is not listening on this loopback port',
        httpStatus,
      };
    }
    return {
      class: PROBE_CLASS.LOCAL_REFUSED,
      message: 'Connection refused — peer not running on this port',
      httpStatus,
    };
  }

  if (code === 'EHOSTUNREACH') {
    return {
      class: PROBE_CLASS.HOST_UNREACHABLE,
      message: 'Host unreachable — Tailscale tunnel down or peer offline',
      httpStatus,
    };
  }

  const timedOut = code === 'ETIMEDOUT'
    || err?.name === 'AbortError'
    || err?.message === 'Request aborted';
  if (timedOut) {
    if (isTailcat && TUNNEL_DIAL_HINT.test(rawMessage)) {
      return {
        class: PROBE_CLASS.TUNNEL_DIAL,
        message: `Tunnel dial failure — probe timed out (${probeTimeoutMs}ms); remote may be unreachable through the forward`,
        httpStatus,
      };
    }
    return {
      class: PROBE_CLASS.PROBE_TIMEOUT,
      message: `Probe timeout (${probeTimeoutMs}ms)`,
      httpStatus,
    };
  }

  if (isTailcat && (code === 'ECONNRESET' || TUNNEL_DIAL_HINT.test(rawMessage))) {
    return {
      class: PROBE_CLASS.TUNNEL_DIAL,
      message: `Tunnel dial failure — ${rawMessage}`,
      httpStatus,
    };
  }

  if (httpStatus != null) {
    return {
      class: PROBE_CLASS.PROBE_HTTP,
      message: isTailcat
        ? `Tunnel reachable but health/details probe failed (HTTP ${httpStatus})`
        : `HTTP ${httpStatus}`,
      httpStatus,
    };
  }

  return {
    class: PROBE_CLASS.UNKNOWN,
    message: rawMessage,
    httpStatus,
  };
}

/**
 * Operator-facing lastProbe payload persisted on the peer record.
 * @returns {{ ok: boolean, class: string, message: string|null, httpStatus: number|null, latencyMs: number|null, at: string }}
 */
export function buildLastProbeRecord({ ok, classification = null, latencyMs = null, at = new Date().toISOString() } = {}) {
  if (ok) {
    return {
      ok: true,
      class: PROBE_CLASS.OK,
      message: null,
      httpStatus: classification?.httpStatus ?? 200,
      latencyMs: latencyMs == null ? null : Math.max(0, Math.round(latencyMs)),
      at,
    };
  }
  return {
    ok: false,
    class: classification?.class || PROBE_CLASS.UNKNOWN,
    message: classification?.message || 'Probe failed',
    httpStatus: classification?.httpStatus ?? null,
    latencyMs: latencyMs == null ? null : Math.max(0, Math.round(latencyMs)),
    at,
  };
}

/** One-line log fragment: `[local_refused] Local connection refused…` */
export function formatProbeDiagnosticLog(lastProbe) {
  if (!lastProbe) return 'unknown';
  if (lastProbe.ok) {
    const ms = lastProbe.latencyMs != null ? ` ${lastProbe.latencyMs}ms` : '';
    return `[ok]${ms}`;
  }
  return `[${lastProbe.class || 'unknown'}] ${lastProbe.message || 'Probe failed'}`;
}
