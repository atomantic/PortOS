export function PortOSMark({ size = 24, className = '', ariaLabel = null }) {
  return (
    <img
      src="/portos-logo.png"
      alt={ariaLabel || ''}
      aria-hidden={ariaLabel ? undefined : 'true'}
      className={`block object-contain ${className}`.trim()}
      draggable="false"
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
      }}
    />
  );
}

export default function Logo({ size = 24, className = '', ariaLabel = 'PortOS logo' }) {
  return <PortOSMark size={size} className={className} ariaLabel={ariaLabel} />;
}
