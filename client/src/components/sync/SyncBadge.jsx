/**
 * SyncBadge — presentational-only sync status badge.
 *
 * Props:
 *   status   — 'in-parity' | 'diverged' | 'assets-missing' |
 *              'metadata-missing' | 'local-only' | 'peer-only' |
 *              'peer-unreachable' | 'peer-too-old' | 'fetch-failed' |
 *              'not-syncing' | 'unknown' | null | undefined
 *   onClick  — called when the badge button is clicked (e.g. open detail drawer)
 */

import { CheckCircle2, AlertTriangle, WifiOff, HelpCircle } from 'lucide-react';

const STATUS_CONFIG = {
  'in-parity': {
    label: 'In sync',
    className: 'bg-port-success/15 text-port-success hover:bg-port-success/25',
    Icon: CheckCircle2,
    title: 'All peers in parity',
  },
  diverged: {
    label: 'Diverged',
    className: 'bg-port-warning/15 text-port-warning hover:bg-port-warning/25',
    Icon: AlertTriangle,
    title: 'Content differs from at least one peer',
  },
  'assets-missing': {
    label: 'Assets missing',
    className: 'bg-port-warning/15 text-port-warning hover:bg-port-warning/25',
    Icon: AlertTriangle,
    title: 'Record present but associated files are missing on a peer',
  },
  'metadata-missing': {
    label: 'Metadata missing',
    className: 'bg-port-warning/15 text-port-warning hover:bg-port-warning/25',
    Icon: AlertTriangle,
    title: 'One or more synced images is missing generation prompt metadata',
  },
  'local-only': {
    label: 'Local only',
    className: 'bg-port-warning/15 text-port-warning hover:bg-port-warning/25',
    Icon: AlertTriangle,
    title: 'Not present on at least one peer',
  },
  'peer-only': {
    label: 'On peer only',
    className: 'bg-port-warning/15 text-port-warning hover:bg-port-warning/25',
    Icon: AlertTriangle,
    title: 'Present on peer but not local',
  },
  'not-syncing': {
    label: 'Not syncing',
    className: 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30',
    Icon: WifiOff,
    // True when no online peer is syncing THIS category — either no peers are
    // sync-enabled at all, or they are but have this category turned off.
    title: 'No peers syncing this category — enable it for a peer?',
  },
  unknown: {
    label: 'Sync unknown',
    className: 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30',
    Icon: HelpCircle,
    // Sync IS configured, but every eligible peer was unreachable / too-old /
    // errored, so we couldn't compute parity. Distinct from 'not-syncing'.
    title: 'Sync status unavailable — peer offline, unreachable, or on an older PortOS',
  },
  'peer-unreachable': {
    label: 'Peer offline',
    className: 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30',
    Icon: WifiOff,
    title: 'Sync status unavailable — peer is offline or unreachable',
  },
  'peer-too-old': {
    label: 'Peer update needed',
    className: 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30',
    Icon: HelpCircle,
    title: 'Sync status unavailable — peer is running an older PortOS without integrity manifests',
  },
  'fetch-failed': {
    label: 'Sync check failed',
    className: 'bg-gray-600/20 text-gray-400 hover:bg-gray-600/30',
    Icon: HelpCircle,
    title: 'Sync status unavailable — peer returned an error during integrity check',
  },
};

export default function SyncBadge({ status, onClick }) {
  if (!status) return null;

  const config = STATUS_CONFIG[status];
  if (!config) return null;

  const { label, className, Icon, title } = config;

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${className}`}
    >
      <Icon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
