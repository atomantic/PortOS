import { LayoutGrid } from 'lucide-react';

/** Opens the project contact sheet (whole-video take review) from a stage toolbar. */
export default function ContactSheetButton({ onOpen }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm hover:bg-port-border/40 sm:min-h-0"
      title="Review every scene's takes side by side">
      <LayoutGrid size={14} /> Contact sheet
    </button>
  );
}
