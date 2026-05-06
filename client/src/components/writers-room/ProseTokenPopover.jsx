import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

// ProseTokenPopover — single fixed-position card driven by hover events from
// inline tokens in ProseReader. Stateless w.r.t. open/close: WorkEditor passes
// `anchor` (a DOMRect-or-null), `kind`, `refId`. We resolve refId against the
// characters/settings/objects lists prop'd in.
//
// Hover semantics: 200ms open delay, 150ms close grace handled by the parent
// (WorkEditor) — this component just renders or doesn't.

function clampToViewport(rect) {
  if (!rect) return null;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = 320;
  const left = Math.max(8, Math.min(W - w - 8, rect.left));
  const top = rect.bottom + 6 + w / 2 > H ? Math.max(8, rect.top - 12 - 200) : rect.bottom + 6;
  return { left, top, width: w };
}

function resolveProfile({ kind, refId, characters, settings, objects }) {
  if (kind === 'char') return characters.find((c) => c.id === refId) || null;
  if (kind === 'place') return settings.find((s) => s.id === refId) || null;
  if (kind === 'object') return objects.find((o) => o.id === refId) || null;
  return null;
}

function fieldRows(kind, profile) {
  if (!profile) return [];
  if (kind === 'char') {
    return [
      ['Role', profile.role],
      ['Appearance', profile.physicalDescription],
      ['Personality', profile.personality],
      ['Background', profile.background],
    ].filter(([, v]) => v && String(v).trim());
  }
  if (kind === 'place') {
    return [
      ['Slugline', profile.slugline],
      ['Era', profile.era],
      ['Weather', profile.weather],
      ['Description', profile.description],
      ['Recurring', profile.recurringDetails],
    ].filter(([, v]) => v && String(v).trim());
  }
  if (kind === 'object') {
    return [
      ['Description', profile.description],
      ['Significance', profile.significance],
    ].filter(([, v]) => v && String(v).trim());
  }
  return [];
}

const KIND_DOT = {
  char: 'bg-port-accent',
  place: 'bg-blue-400',
  object: 'bg-amber-400',
};
const KIND_LABEL = {
  char: 'Character',
  place: 'Setting',
  object: 'Object',
};

export default function ProseTokenPopover({
  open,
  pinned,
  anchor,
  kind,
  refId,
  characters = [],
  settings = [],
  objects = [],
  onOpenProfile,
  onClose,
}) {
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open || !anchor) { setPos(null); return; }
    setPos(clampToViewport(anchor));
  }, [open, anchor]);

  // Close on Escape when pinned (mirrors the dropdown patterns in this folder).
  useEffect(() => {
    if (!pinned) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, onClose]);

  if (!open || !pos) return null;

  const profile = resolveProfile({ kind, refId, characters, settings, objects });
  if (!profile) return null;

  const rows = fieldRows(kind, profile);
  const missing = Array.isArray(profile.missingFromProse) ? profile.missingFromProse : [];
  const aliases = Array.isArray(profile.aliases) ? profile.aliases.filter(Boolean) : [];

  return (
    <div
      role="tooltip"
      style={{ left: pos.left, top: pos.top, width: pos.width, position: 'fixed' }}
      className="z-40 bg-port-card border border-port-border rounded-lg shadow-2xl p-3 text-xs text-gray-200"
      onMouseEnter={() => { /* keep open while hovered */ }}
      onMouseLeave={() => { if (!pinned) onClose?.(); }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${KIND_DOT[kind] || 'bg-gray-400'}`} />
        <span className="font-semibold text-white text-[13px] truncate">{profile.name || profile.slugline}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-500">{KIND_LABEL[kind]}</span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {aliases.length > 0 && (
        <div className="mb-2 text-[10px] text-gray-400">
          a.k.a. {aliases.join(', ')}
        </div>
      )}

      {rows.length === 0 && (
        <div className="text-gray-500 italic mb-2">No profile details yet.</div>
      )}
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2 py-1 border-t border-port-border/60 first:border-t-0">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 w-20 shrink-0 pt-0.5">{k}</span>
          <span className="text-gray-200 flex-1 leading-snug">{v}</span>
        </div>
      ))}

      {missing.length > 0 && (
        <div className="mt-2 pt-2 border-t border-port-border/60">
          <div className="text-[10px] uppercase tracking-wider text-port-warning mb-1">Missing from prose</div>
          <div className="flex flex-wrap gap-1">
            {missing.slice(0, 6).map((m, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-port-warning/15 text-port-warning">
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => onOpenProfile?.({ kind, refId })}
        className="mt-3 w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] bg-port-bg hover:bg-port-bg/60 border border-port-border text-gray-300 hover:text-white"
      >
        <ExternalLink size={11} /> Open profile
      </button>
    </div>
  );
}
