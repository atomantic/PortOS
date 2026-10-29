/**
 * Is a peer record a paired peer — i.e. does it hold a pair secret long
 * enough to authenticate with? This is the one place the length floor lives:
 * authGate, peer HTTP credentials, peer admin, catalog identity and the push
 * authorizer all ask it, so they cannot disagree about who is paired.
 *
 * Deliberately only the secret check. Callers keep their own conditions
 * (enabled, instanceId match, `peerAuthAccepted`) at the call site.
 */

export const PAIR_SECRET_MIN_LENGTH = 32;

/**
 * @param {object} peer - Registered peer record (`syncSecret`).
 * @returns {boolean}
 */
export function isPairedPeer(peer) {
  return typeof peer?.syncSecret === 'string' && peer.syncSecret.length >= PAIR_SECRET_MIN_LENGTH;
}
