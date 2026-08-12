import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Shared disclosure/section-header primitive (#3853). Replaces the hand-rolled
// `useState(open)` + chevron + leading icon + collapsed-summary headers that had
// drifted across the client — none of which carried `aria-expanded`.
//
// The layout contract lives here so the mobile fix only has to exist once:
// `flex w-full items-center`, `shrink-0` on the chevron/icon/label, and
// `min-w-0 truncate` on the trailing summary so a long collapsed summary clips
// to one line instead of wrapping into a paragraph-tall header on a phone.
//
// Deliberately NOT here: a per-site `text-left` (the base-layer rule in
// index.css already left-aligns wrapped flex-button labels), animation, or
// nesting support. Open state defaults to internal — the controlled
// `open`/`onOpenChange` pair below is opt-in for the one call site that has to
// drive it from outside the header.
//
// `size` picks between the tones that already exist in the app rather than
// unifying them; pick the one that matches the call site's neighbours.
const SIZES = {
  // Terse inline header (canon cards): size-10 icons, gap-1, gray-500.
  sm: {
    iconSize: 10,
    button: 'gap-1 text-[10px] uppercase tracking-wider text-gray-500 hover:text-white',
    label: '',
    summary: '',
  },
  // Boxed section header (character detail editor): size-11 icons, gap-1.5, gray-400.
  md: {
    iconSize: 11,
    button: 'gap-1.5 text-[10px] uppercase tracking-wider text-gray-400 hover:text-white',
    label: 'text-gray-300',
    summary: 'text-gray-500 normal-case',
  },
  // Card row (digital-twin analysis card): size-14 icons, gap-2, sentence-case text-sm.
  lg: {
    iconSize: 14,
    button: 'gap-2 text-sm text-gray-300 hover:bg-port-bg transition-colors',
    label: '',
    summary: 'text-gray-500',
  },
};

export default function CollapsibleSection({
  icon: Icon = null,
  label,
  summary = '',
  defaultOpen = false,
  size = 'sm',
  // Chrome that varies per call site (wrapper margin/border, header padding,
  // body padding). Kept separate from `size` so a caller never has to fight a
  // preset for the same Tailwind property.
  className = '',
  buttonClassName = '',
  bodyClassName = '',
  // Optional controlled pair, for the one caller that has to open the section
  // from outside the header (CanonCard's "Add outfit"). Omit both and the
  // section owns its own state, which is what every other call site wants.
  open: controlledOpen,
  onOpenChange,
  children,
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = typeof controlledOpen === 'boolean';
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const toggle = () => {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    if (onOpenChange) onOpenChange(next);
  };
  const tone = SIZES[size] || SIZES.sm;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={`flex w-full items-center ${tone.button} ${buttonClassName}`.trim()}
      >
        <Chevron size={tone.iconSize} className="shrink-0" />
        {Icon ? <Icon size={tone.iconSize} className="shrink-0" /> : null}
        {/* The label only refuses to shrink while a summary is actually on the
            line beside it — otherwise (no summary, or expanded so the summary
            is hidden) a long label would overflow the header instead of
            wrapping. */}
        <span className={`${summary && !open ? 'shrink-0' : 'min-w-0'} ${tone.label}`.trim()}>{label}</span>
        {summary && !open
          ? <span className={`min-w-0 truncate ${tone.summary}`.trim()}>{summary}</span>
          : null}
      </button>
      {open ? <div className={bodyClassName}>{children}</div> : null}
    </div>
  );
}
