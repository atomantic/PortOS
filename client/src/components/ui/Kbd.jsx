// A keycap for rendering a keyboard key in help/cheatsheet UI. Two sizes: `md`
// (the default — the modal shortcut cheatsheet's roomy cap) and `sm` (a compact
// inline hint, e.g. the editorial comment card's shortcut row, #1603).
const SIZE = {
  md: 'inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-medium text-gray-300 shadow-sm',
  sm: 'px-1 text-[9px] leading-tight text-gray-400',
};

export default function Kbd({ children, size = 'md' }) {
  return (
    <kbd className={`font-mono bg-port-bg border border-port-border rounded ${SIZE[size] || SIZE.md}`}>
      {children}
    </kbd>
  );
}
