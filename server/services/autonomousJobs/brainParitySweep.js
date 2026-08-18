/**
 * Autonomous Jobs — scheduled brain-parity sweep (SCRIPT_HANDLERS['brain-parity-sweep']).
 *
 * `brainParity.js` makes federation divergence *visible*, but only when someone
 * presses the Check button on a peer card. The whole failure mode it exists to
 * catch is silent — both installs report "synced" while holding different
 * records — so a user who never thinks to press the button never finds out.
 * This wraps the sweep (`runBrainParityCheck()` with no `peerId` = every
 * federating peer) so it can run on a cadence.
 *
 * DEFAULT-DISABLED by design (issue #4519): the sweep exchanges a full manifest
 * with every peer and re-reads every local brain store, which is not a cost an
 * install should pay unasked. It is deterministic — no LLM calls — so it is safe
 * under the cold-bootstrap policy once the user opts in.
 *
 * The return value is a COMPACT summary, not the raw reports. Script-job results
 * are echoed back from the manual-trigger route and emitted on
 * `jobs:script-executed`; a badly diverged install's full report carries every
 * out-of-parity record id per type, which has no business on a socket event.
 * The detailed reports are already persisted by `runBrainParityCheck` and
 * rendered per peer on the Instances page.
 */

import { INTEGRITY_STATUS } from '../../lib/syncIntegrity.js'

// Statuses that mean "these two brains hold different data". `in-parity` is
// excluded; `total` is a denominator, not a finding.
const OUT_OF_PARITY_STATUSES = [
  INTEGRITY_STATUS.LOCAL_ONLY,
  INTEGRITY_STATUS.PEER_ONLY,
  INTEGRITY_STATUS.DIVERGED
]

const countOutOfParity = (summary) =>
  OUT_OF_PARITY_STATUSES.reduce((total, key) => total + (summary?.[key] ?? 0), 0)

/**
 * Collapse one peer report to the fields worth logging/emitting.
 *
 * `checksumMatch: null` is preserved distinctly from `false` — null means the
 * peer served no checksum, so record *bodies* were never compared. Folding that
 * into `false` would report divergence that was not observed, and folding it
 * into `true` would claim a verification that never ran.
 */
function summarizePeer(report) {
  if (report?.available !== true) {
    return {
      peerId: report?.peerId ?? null,
      peerName: report?.peerName ?? null,
      available: false,
      reason: report?.reason ?? 'unknown'
    }
  }
  return {
    peerId: report.peerId ?? null,
    peerName: report.peerName ?? null,
    available: true,
    recordsCompared: report.summary?.total ?? 0,
    outOfParity: countOutOfParity(report.summary),
    checksumMatch: report.checksums?.match ?? null
  }
}

/**
 * Run the parity audit against every federating peer and summarize the result.
 *
 * @param {object} [deps]
 * @param {(opts?: object) => Promise<{ reports: object[] }>} [deps.check] - sweep runner (test seam)
 * @returns {Promise<{ peersChecked: number, peersUnavailable: number, peersOutOfParity: number, outOfParityRecords: number, peers: object[] }>}
 */
export async function runBrainParitySweep({ check } = {}) {
  // Imported lazily so the scriptHandlers registry — loaded on every jobs read —
  // doesn't pull the brain storage + reconcile + peer-registry graph behind it
  // just to have the handler in a map.
  const run = check || (async (opts) => {
    const { runBrainParityCheck } = await import('../brainParity.js')
    return runBrainParityCheck(opts)
  })

  const result = await run({})
  const reports = Array.isArray(result?.reports) ? result.reports : []
  const peers = reports.map(summarizePeer)

  const peersUnavailable = peers.filter((p) => !p.available).length
  // A peer counts as out of parity when records differ OR when the whole-brain
  // checksums disagree — the checksum is the only signal that catches matching
  // ids AND clocks over different bodies, which is a real divergence with an
  // out-of-parity count of zero.
  const outOfParityPeers = peers.filter((p) => p.available && (p.outOfParity > 0 || p.checksumMatch === false))
  const outOfParityRecords = peers.reduce((total, p) => total + (p.outOfParity ?? 0), 0)

  const summary = {
    peersChecked: peers.length,
    peersUnavailable,
    peersOutOfParity: outOfParityPeers.length,
    outOfParityRecords,
    peers
  }

  if (peers.length === 0) {
    console.log('🧠🔍 Brain parity sweep: no federating peers to check')
  } else if (outOfParityPeers.length === 0) {
    console.log(`🧠🔍 Brain parity sweep: ${peers.length} peer(s) checked, none out of parity (${peersUnavailable} unavailable)`)
  } else {
    const names = outOfParityPeers.map((p) => p.peerName || p.peerId).join(', ')
    console.log(`🧠🔍 Brain parity sweep: ${outOfParityPeers.length}/${peers.length} peer(s) out of parity (${outOfParityRecords} record(s)) — ${names}`)
  }

  return summary
}
