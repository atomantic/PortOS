import { Link } from 'react-router';
import { pluralize } from '../../lib/textUtils';

// Keyed by the server's fixed reason codes (`unavailableReason` in
// server/services/appQualityFederation.js); each says what to check.
const REASONS = {
  unreachable: 'offline or unreachable. Check that it is running and reachable.',
  refused: 'declined to share. It may not track this repository, or may not list this install as an enabled sync peer.',
  incompatible: 'runs a PortOS version this install cannot read. Update both installs.',
  'different-repository': 'reported a different repository for this app.',
  'too-large': 'sent quality data over the size limit.',
  error: 'returned an error.',
};

export const instancePeerLink = peerId => `/instances?peer=${encodeURIComponent(peerId)}`;

/** Names each peer that left the unified score incomplete and links to its Instances card. */
export default function QualityPeerWarning({ federation, subject, className = '' }) {
  const peers = federation?.unavailablePeers;
  if (!federation?.failed && !(federation?.unavailable > 0)) return null;
  const instancesLink = <Link to="/instances" className="underline hover:text-white">Open Instances</Link>;
  if (federation.failed || !peers?.length) {
    return <p className={`text-xs text-port-warning ${className}`}>
      {federation.failed ? 'Peer quality could not be loaded' : `${pluralize(federation.unavailable, 'peer')} unavailable or incompatible`}; {subject} may be incomplete. {instancesLink}
    </p>;
  }
  return <div className={`text-xs text-port-warning ${className}`}>
    <p>{pluralize(peers.length, 'peer')} did not contribute; {subject} may be incomplete.</p>
    <ul className="mt-1 space-y-0.5">
      {peers.map(peer => <li key={peer.id} className="break-words">
        <Link to={instancePeerLink(peer.id)} className="font-medium underline hover:text-white">{peer.name}</Link>
        {' '}{REASONS[peer.reason] || REASONS.error}
      </li>)}
    </ul>
  </div>;
}
