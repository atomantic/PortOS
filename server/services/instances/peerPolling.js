/** Schedule health probes when registered peers are reachable. */
import { probeAllPeers } from './peerProbing.js';
import { loadData, withData } from '../instanceIdentity.js';
import { getTailscaleStatus } from '../../lib/tailscale.js';

const POLL_INTERVAL_MS = 30000;
const INITIAL_PROBE_DELAY_MS = 2000;
// While peer probing is deferred (Tailscale not connected at boot), re-check
// Tailscale on this cadence and start polling the moment it comes up — so the
// user just has to connect Tailscale, no manual "sync now" required.
const TAILSCALE_RECHECK_MS = 60_000;

let pollTimer = null;
// Set while we're waiting for Tailscale to connect before starting the real
// probe loop (see startPolling). Kept separate from pollTimer so stopPolling can
// tear down either state, and so the boot gate is idempotent under double-start.
let tailscaleWatchTimer = null;
let pollingStartPending = false;
// Bumped by stopPolling() to cancel any in-flight startPolling gate or deferred
// watcher callback that is mid-await when the stop lands — without it, a stop
// during the async window is a silent no-op and a timer gets created after stop
// was requested.
let pollingGeneration = 0;

// --- Polling ---

// Actually create the probe schedule (backoff clear + initial probe + interval).
// Idempotent: a no-op if the loop is already running.
function beginPolling() {
  if (pollTimer) return;
  console.log(`🌐 Instance polling started (${POLL_INTERVAL_MS / 1000}s interval)`);

  // Backoff is a rate limit on the polling loop, not a durable judgment about
  // the peer — boot (or a fresh Tailscale connect) may itself be the event that
  // fixes connectivity, so clear it.
  withData(async (data) => {
    let cleared = 0;
    for (const peer of data.peers) {
      if (peer.nextProbeAt) {
        peer.nextProbeAt = null;
        peer.consecutiveFailures = 0;
        cleared++;
      }
    }
    if (cleared > 0) console.log(`🌐 Cleared backoff on ${cleared} peer(s) for fresh probe after boot`);
  }).catch(err => console.error(`❌ Failed to clear peer backoff on boot: ${err.message}`));

  // Initial probe after a short delay. probeAllPeers() awaits fs/network work
  // that can reject; setTimeout/setInterval don't await the callback, so catch
  // here to avoid a process-killing unhandled rejection.
  setTimeout(() => {
    probeAllPeers().catch(err => console.error(`❌ Initial peer probe failed: ${err?.message || String(err)}`));
  }, INITIAL_PROBE_DELAY_MS);

  pollTimer = setInterval(() => {
    probeAllPeers().catch(err => console.error(`❌ Peer probe failed: ${err?.message || String(err)}`));
  }, POLL_INTERVAL_MS);
}

// A peer we can only reach over the tailnet: its probe URL (see peerBaseUrl)
// resolves to a MagicDNS name (*.ts.net) or a Tailscale CGNAT address
// (100.64.0.0/10 for IPv4, fd7a:115c:a1e0::/48 for IPv6). A peer addressed by a
// plain LAN/routable IP or a non-tailnet DNS host is reachable with Tailscale
// down, so it must NOT be deferred by the gate below.
function peerRequiresTailscale(peer) {
  if (peer.host) return /\.ts\.net$/i.test(peer.host.trim());
  const addr = (peer.address || '').trim();
  const v4 = addr.match(/^100\.(\d{1,3})\./);
  if (v4) {
    const second = Number(v4[1]);
    if (second >= 64 && second <= 127) return true;   // 100.64.0.0/10 CGNAT
  }
  if (/^fd7a:115c:a1e0:/i.test(addr)) return true;     // Tailscale IPv6 ULA
  return false;
}

// Decide whether to start probing now or defer until Tailscale connects.
// Probing a tailnet-only peer's MagicDNS hostname while Tailscale is down just
// spams DNS-failure + backoff logs (a laptop booted off-tailnet). So we defer
// ONLY when every enabled peer is tailnet-dependent; a LAN/IP-reachable peer is
// probed immediately (it doesn't need Tailscale). While deferred, a slow watcher
// starts polling automatically the moment Tailscale connects. `gen` is captured
// at startPolling time so a stopPolling() during either await aborts cleanly.
async function evaluatePollingGate(gen) {
  if (pollTimer || tailscaleWatchTimer) return;

  const data = await loadData();
  if (gen !== pollingGeneration) return;   // stopPolling() landed during loadData
  const enabledPeers = Array.isArray(data.peers) ? data.peers.filter(p => p.enabled) : [];

  // No peers, or at least one peer reachable without Tailscale → run the loop
  // now (silent no-op when there are no peers). Only an all-tailnet peer set
  // gets deferred, so solo installs and LAN peers are unaffected.
  const needsTailscale = enabledPeers.length > 0 && enabledPeers.every(peerRequiresTailscale);
  if (!needsTailscale) {
    beginPolling();
    return;
  }

  const status = await getTailscaleStatus();
  if (gen !== pollingGeneration) return;   // stopPolling() landed during status check
  if (status.running) {
    beginPolling();
    return;
  }

  console.log(`🌐 Peer sync deferred — Tailscale not connected (${status.state || status.reason}); polling starts automatically once it's up`);
  // Capture the handle locally so a stale in-flight callback can't clear/null a
  // watcher installed by a later startPolling() (identity guard below).
  const myTimer = setInterval(() => {
    getTailscaleStatus().then((s) => {
      if (!s.running || tailscaleWatchTimer !== myTimer) return;
      clearInterval(myTimer);
      tailscaleWatchTimer = null;
      console.log('🌐 Tailscale connected — starting peer sync polling');
      beginPolling();
    }).catch(() => {});
  }, TAILSCALE_RECHECK_MS);
  tailscaleWatchTimer = myTimer;
  // Don't let the recheck timer keep the process alive on its own.
  if (typeof myTimer.unref === 'function') myTimer.unref();
}

export function startPolling() {
  // pollingStartPending guards the async gap in evaluatePollingGate so two
  // synchronous startPolling() calls can't each spin up a schedule/watcher.
  if (pollTimer || tailscaleWatchTimer || pollingStartPending) return;
  pollingStartPending = true;
  const gen = pollingGeneration;
  evaluatePollingGate(gen)
    .catch(err => console.error(`❌ Failed to start peer polling: ${err.message}`))
    .finally(() => { pollingStartPending = false; });
}

export function stopPolling() {
  // Invalidate any in-flight startPolling gate / deferred watcher callback.
  pollingGeneration++;
  if (tailscaleWatchTimer) {
    clearInterval(tailscaleWatchTimer);
    tailscaleWatchTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('🌐 Instance polling stopped');
  }
}
