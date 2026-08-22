import { MessageSquare, Code2, Brain, Eye, Boxes, Wrench, Music } from 'lucide-react';

/**
 * The capability icon row, shared by every surface that shows what a model can do.
 *
 * It started life inside the install tab and is now also the gate the
 * Performance page's capability tests key off — so it lives here rather than
 * being copied. Two surfaces rendering the same claim with different icons (or,
 * worse, a different vocabulary) is how a model ends up looking tool-capable on
 * one page and not on another.
 *
 * `cls` is the icon color; the bordered chip uses the same hue at low opacity —
 * the LM Studio style, icons rather than text, because a model with five badges
 * would otherwise wrap a card into three lines.
 */
export const CAPABILITY_META = {
  chat: { Icon: MessageSquare, label: 'Chat', cls: 'text-gray-400 border-gray-500/50' },
  code: { Icon: Code2, label: 'Code', cls: 'text-sky-400 border-sky-400/50' },
  reasoning: { Icon: Brain, label: 'Reasoning', cls: 'text-emerald-400 border-emerald-400/50' },
  vision: { Icon: Eye, label: 'Vision', cls: 'text-amber-400 border-amber-400/50' },
  embeddings: { Icon: Boxes, label: 'Embeddings', cls: 'text-violet-400 border-violet-400/50' },
  tools: { Icon: Wrench, label: 'Tool use', cls: 'text-blue-400 border-blue-400/50' },
  audio: { Icon: Music, label: 'Audio generation', cls: 'text-pink-400 border-pink-400/50' },
};

/**
 * A model's capability badges.
 *
 * `capabilities` is `null` when NOTHING authoritative reported a badge set — a
 * bare llama.cpp endpoint lists model ids and nothing else. That is rendered as
 * an explicit "not reported" chip rather than as an empty row, because an empty
 * row reads as "this model can do nothing", which is a different and untrue
 * claim. `[]` (a runtime that answered and named none) legitimately renders
 * nothing.
 */
export default function CapabilityBadges({ capabilities, unknownLabel = 'capabilities not reported' }) {
  if (!Array.isArray(capabilities)) {
    return (
      <span
        className="px-1.5 py-0.5 text-[10px] rounded border border-dashed border-port-border text-gray-500"
        title="This runtime lists model ids only, so PortOS cannot say what this model claims."
      >
        {unknownLabel}
      </span>
    );
  }

  return capabilities.map((capability) => {
    const meta = CAPABILITY_META[capability];
    // An unmapped capability still shows — the server's vocabulary can grow
    // ahead of this map, and silently dropping one would hide a real claim.
    if (!meta) {
      return <span key={capability} className="px-1.5 py-0.5 bg-port-border/60 rounded">{capability}</span>;
    }
    const Icon = meta.Icon;
    return (
      <span
        key={capability}
        title={meta.label}
        aria-label={meta.label}
        className={`inline-flex items-center justify-center w-5 h-5 rounded border ${meta.cls}`}
      >
        <Icon size={12} />
      </span>
    );
  });
}
