// The flex-1 action button every lightbox footer row shares; `tone` picks the
// colour recipe so the 14-class shell is written once.
const BASE = 'flex-1 min-h-[44px] min-w-[80px] flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs';
const BUSY = 'disabled:opacity-50 disabled:cursor-not-allowed';
const TONES = {
  accent80: 'bg-port-accent/80 text-white hover:opacity-90 rounded',
  accent: 'bg-port-accent text-white hover:opacity-90 rounded',
  success: 'bg-port-success text-white hover:opacity-90 rounded',
  accent2: 'bg-port-accent-2 text-port-on-accent-2 hover:opacity-90 rounded',
  warning: `bg-port-warning/80 text-white hover:opacity-90 rounded ${BUSY}`,
  accent80Busy: `bg-port-accent/80 text-white hover:opacity-90 rounded ${BUSY}`,
};

export default function FooterAction({ tone = 'accent80', active = false, className = '', children, ...props }) {
  // `active` is a toggle button's pressed state: it swaps the 80% accent for solid.
  const toneClass = active ? TONES.accent : TONES[tone];
  return (
    <button type="button" {...props} className={`${BASE} ${toneClass} ${className}`.trim()}>
      {children}
    </button>
  );
}
