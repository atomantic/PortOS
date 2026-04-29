import MicroGlyph from './MicroGlyph';

const STATE_TO_TONE = {
  active: 'accent',
  online: 'success',
  ok: 'success',
  success: 'success',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  idle: 'muted',
  offline: 'muted',
};

// Schematic HUD label — type-paired chrome lifted from the micro2 reference
// sticker sheet. Renders something like:  "MODULE.04 // ACTIVE  ●"
//
// Sits at the top edge of cards, above widget headers, on empty states.
// Reuses GeistPixelSquare (already loaded for CyberCity) so no font cost.
export default function SchematicLabel({
  module,
  prefix = 'MODULE',
  status,
  glyph,
  state = 'idle',
  variant = 'inline', // 'inline' | 'tab'
  animated,
  className = '',
}) {
  const tone = STATE_TO_TONE[state] || '';
  const toneClass = tone ? `port-schematic-label--${tone}` : '';
  const classes = [
    'port-schematic-label',
    'font-pixel',
    variant === 'tab' ? 'port-schematic-label--tab' : '',
    toneClass,
    className,
  ].filter(Boolean).join(' ');

  // Animation default: only spin/pulse when state is "active". Override
  // explicitly via the `animated` prop when needed.
  const shouldAnimate = animated ?? state === 'active';

  return (
    <span className={classes} aria-hidden="true">
      {module && (
        <span className="port-schematic-label__module">
          {prefix}.{module}
        </span>
      )}
      {module && status && <span className="port-schematic-label__divider">//</span>}
      {status && <span className="port-schematic-label__status">{status}</span>}
      {glyph && (
        <MicroGlyph
          variant={glyph}
          size={11}
          animated={shouldAnimate}
          state={tone}
        />
      )}
    </span>
  );
}
