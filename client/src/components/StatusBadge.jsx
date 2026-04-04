const statusConfig = {
  online: {
    badge: 'bg-port-success/15 text-port-success',
    dot: 'bg-port-success',
    text: 'Online',
    pulse: true
  },
  stopped: {
    badge: 'bg-port-warning/15 text-port-warning',
    dot: 'bg-port-warning',
    text: 'Stopped',
    pulse: false
  },
  not_started: {
    badge: 'bg-gray-500/20 text-gray-400',
    dot: 'bg-gray-500',
    text: 'Offline',
    pulse: false
  },
  not_found: {
    badge: 'bg-gray-500/20 text-gray-400',
    dot: 'bg-gray-500',
    text: 'Not Found',
    pulse: false
  },
  error: {
    badge: 'bg-port-error/15 text-port-error',
    dot: 'bg-port-error',
    text: 'Error',
    pulse: false
  },
  unknown: {
    badge: 'bg-gray-600/20 text-gray-400',
    dot: 'bg-gray-600',
    text: 'Unknown',
    pulse: false
  }
};

export default function StatusBadge({ status, size = 'md' }) {
  const config = statusConfig[status] || statusConfig.unknown;

  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-2.5 py-1',
    lg: 'text-base px-3 py-1.5'
  };

  return (
    <span
      role="status"
      aria-label={`Status: ${config.text}`}
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${config.badge} ${sizeClasses[size]}`}
    >
      {config.pulse && (
        <span className={`w-2 h-2 rounded-full ${config.dot} animate-pulse-soft`} aria-hidden="true" />
      )}
      {config.text}
    </span>
  );
}
