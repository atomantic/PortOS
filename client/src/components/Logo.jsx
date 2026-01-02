// PortOS Logo - A portal/gateway with connected nodes representing apps and ports

export default function Logo({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer portal ring */}
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="4 2"
        opacity="0.5"
      />

      {/* Inner portal */}
      <circle
        cx="12"
        cy="12"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
      />

      {/* Center dot - the "port" */}
      <circle
        cx="12"
        cy="12"
        r="2"
        fill="currentColor"
      />

      {/* Connection lines to corners - representing connected apps */}
      <line x1="12" y1="6" x2="12" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="6" y1="12" x2="2" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Alternative: Grid-based logo representing app tiles
export function LogoGrid({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Four app tiles */}
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2" />

      {/* Center connection point */}
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

// Alternative: Anchor/harbor style representing "port"
export function LogoAnchor({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Ring at top */}
      <circle cx="12" cy="5" r="2.5" stroke="currentColor" strokeWidth="2" />

      {/* Vertical line */}
      <line x1="12" y1="7.5" x2="12" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />

      {/* Horizontal bar */}
      <line x1="8" y1="11" x2="16" y2="11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />

      {/* Curved bottom arms */}
      <path
        d="M5 17C5 17 7 20 12 20C17 20 19 17 19 17"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Connection dots */}
      <circle cx="5" cy="17" r="1.5" fill="currentColor" />
      <circle cx="19" cy="17" r="1.5" fill="currentColor" />
    </svg>
  );
}

// Alternative: Hexagonal node network
export function LogoHex({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Central hexagon */}
      <path
        d="M12 3L18.5 7V15L12 19L5.5 15V7L12 3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Inner hexagon */}
      <path
        d="M12 7L15 9V13L12 15L9 13V9L12 7Z"
        fill="currentColor"
        opacity="0.3"
      />

      {/* Center dot */}
      <circle cx="12" cy="11" r="2" fill="currentColor" />

      {/* Connection points */}
      <circle cx="12" cy="3" r="1.5" fill="currentColor" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" />
      <circle cx="5.5" cy="7" r="1.5" fill="currentColor" />
      <circle cx="18.5" cy="7" r="1.5" fill="currentColor" />
    </svg>
  );
}

// Alternative: Minimalist "P" with port dots
export function LogoP({ size = 24, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Stylized P */}
      <path
        d="M7 20V4H13C16.3137 4 19 6.68629 19 10C19 13.3137 16.3137 16 13 16H7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Port dots */}
      <circle cx="13" cy="10" r="2" fill="currentColor" />
    </svg>
  );
}
