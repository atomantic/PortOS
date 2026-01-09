const statusConfig = {
  online: {
    color: 'bg-port-success',
    text: 'Online',
    pulse: true
  },
  stopped: {
    color: 'bg-port-warning',
    text: 'Stopped',
    pulse: false
  },
  not_started: {
    color: 'bg-gray-500',
    text: 'Not Started',
    pulse: false
  },
  not_found: {
    color: 'bg-gray-500',
    text: 'Not Found',
    pulse: false
  },
  error: {
    color: 'bg-port-error',
    text: 'Error',
    pulse: false
  },
  unknown: {
    color: 'bg-gray-600',
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
      className={`inline-flex items-center gap-1.5 rounded-full font-medium text-white ${config.color} ${sizeClasses[size]}`}
    >
      {config.pulse && (
        <span className="w-2 h-2 rounded-full bg-white animate-pulse-soft" aria-hidden="true" />
      )}
      {config.text}
    </span>
  );
}
