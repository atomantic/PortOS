const BADGE_STYLES = {
  strong: 'bg-port-success/20 text-port-success border-port-success/30',
  moderate: 'bg-port-warning/20 text-port-warning border-port-warning/30',
  weak: 'bg-port-error/20 text-port-error border-port-error/30',
  significant: 'bg-port-error/30 text-port-error border-port-error/50',
  unknown: 'bg-gray-800 text-gray-400 border-gray-700'
};

export default function ConfidenceBadge({ level, label, sources }) {
  const style = BADGE_STYLES[level] ?? BADGE_STYLES.unknown;
  const displayLabel = label ?? level ?? 'Unknown';
  const titleText = sources?.join(', ');

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${style}`}
      title={titleText}
    >
      {displayLabel}
    </span>
  );
}
