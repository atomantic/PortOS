import { useState } from 'react';
import { Loader2, X, BookText } from 'lucide-react';

// Field-count guard for derived synopsis textareas — mirrors the server caps so
// the user isn't surprised by a 400 on commit.
const DERIVE_SYNOPSIS_MAX = 8000;
const DERIVE_TITLE_MAX = 300;

// Review/edit panel for the derive-from-manuscript proposal. The arc + bible
// fields and the single-volume title/synopsis are editable; each existing issue
// gets an editable title + synopsis (pre-filled from the derived seasons). On
// confirm the edited proposal is sent — the LLM is NOT re-run.
export default function DeriveFromManuscriptPreview({ preview, committing, onCancel, onConfirm }) {
  const [arc, setArc] = useState(() => ({
    logline: preview.arc?.logline || '',
    summary: preview.arc?.summary || '',
    protagonistArc: preview.arc?.protagonistArc || '',
    themes: Array.isArray(preview.arc?.themes) ? preview.arc.themes : [],
    shape: preview.arc?.shape ?? null,
  }));
  const [bible, setBible] = useState(() => ({
    logline: preview.bible?.logline || '',
    premise: preview.bible?.premise || '',
    issueCountTarget: preview.bible?.issueCountTarget ?? (preview.issues?.length || 0),
  }));
  const [volume, setVolume] = useState(() => ({
    title: preview.volume?.title || '',
    logline: preview.volume?.logline || '',
    synopsis: preview.volume?.synopsis || '',
  }));
  // Per-issue editable rows. Default synopsis = the derived suggestion, falling
  // back to whatever synopsis the issue already carried.
  const [issues, setIssues] = useState(() =>
    (preview.issues || []).map((iss) => ({
      id: iss.id,
      number: iss.number,
      title: iss.title || '',
      synopsis: iss.synopsisSuggestion || iss.currentSynopsis || '',
      ideaLocked: !!iss.ideaLocked,
    })),
  );

  const setIssueField = (id, field, value) =>
    setIssues((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: value } : it)));

  const confirm = () => {
    onConfirm({
      arc,
      bible,
      volume,
      issues: issues.map((it) => ({
        id: it.id,
        title: it.title.slice(0, DERIVE_TITLE_MAX),
        synopsis: it.ideaLocked ? '' : it.synopsis.slice(0, DERIVE_SYNOPSIS_MAX),
      })),
    });
  };

  const inputCls = 'w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:border-port-accent/50 outline-none';

  return (
    <div className="bg-port-bg border border-port-accent/30 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white flex items-center gap-1.5">
          <BookText size={14} className="text-port-accent" />
          Derived from manuscript — review before applying
        </h3>
        <button type="button" onClick={onCancel} disabled={committing} aria-label="Close" className="text-gray-500 hover:text-white disabled:opacity-40">
          <X size={16} />
        </button>
      </div>
      <p className="text-xs text-gray-400">
        Applying collapses the series into <strong>one volume</strong> holding all {issues.length} issue{issues.length === 1 ? '' : 's'} as chapters/acts,
        fills the bible, and seeds each issue&apos;s synopsis. Your verbatim issue scripts are <strong>not</strong> changed.
      </p>

      <div className="grid gap-3 @md:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">Series logline</span>
          <input className={inputCls} value={bible.logline} maxLength={500}
            onChange={(e) => { setBible((b) => ({ ...b, logline: e.target.value })); setArc((a) => ({ ...a, logline: e.target.value })); }} />
        </label>
        <label className="block space-y-1">
          <span className="text-[11px] uppercase tracking-wider text-gray-500">Issue count target</span>
          <input type="number" min={0} className={inputCls} value={bible.issueCountTarget}
            onChange={(e) => setBible((b) => ({ ...b, issueCountTarget: parseInt(e.target.value, 10) || 0 }))} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wider text-gray-500">Premise</span>
        <textarea className={`${inputCls} resize-y`} rows={3} value={bible.premise} maxLength={8000}
          onChange={(e) => { setBible((b) => ({ ...b, premise: e.target.value })); setArc((a) => ({ ...a, summary: e.target.value })); }} />
      </label>
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wider text-gray-500">Protagonist arc</span>
        <textarea className={`${inputCls} resize-y`} rows={2} value={arc.protagonistArc} maxLength={8000}
          onChange={(e) => setArc((a) => ({ ...a, protagonistArc: e.target.value }))} />
      </label>

      <div className="border-t border-port-border pt-2 space-y-2">
        <span className="text-[11px] uppercase tracking-wider text-gray-500">Volume</span>
        <input className={inputCls} value={volume.title} maxLength={DERIVE_TITLE_MAX} placeholder="Volume title"
          onChange={(e) => setVolume((v) => ({ ...v, title: e.target.value }))} />
      </div>

      <div className="border-t border-port-border pt-2 space-y-2">
        <span className="text-[11px] uppercase tracking-wider text-gray-500">Issues (acts / chapters)</span>
        {issues.map((it) => (
          <div key={it.id} className="bg-port-card border border-port-border rounded p-2 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">#{it.number}</span>
              <input className={inputCls} value={it.title} maxLength={DERIVE_TITLE_MAX} placeholder="Issue title"
                aria-label={`Title for issue ${it.number}`}
                onChange={(e) => setIssueField(it.id, 'title', e.target.value)} />
            </div>
            <textarea
              className={`${inputCls} resize-y`}
              rows={2}
              value={it.synopsis}
              maxLength={DERIVE_SYNOPSIS_MAX}
              aria-label={`Synopsis for issue ${it.number}`}
              placeholder={it.ideaLocked ? 'Synopsis locked on this issue — left unchanged' : 'Issue synopsis (seeds idea.input so Verify Arc can read it)'}
              disabled={it.ideaLocked}
              onChange={(e) => setIssueField(it.id, 'synopsis', e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button type="button" onClick={confirm} disabled={committing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium bg-port-accent/20 text-port-accent border border-port-accent/40 hover:bg-port-accent/30 disabled:opacity-40">
          {committing ? <Loader2 size={14} className="animate-spin" /> : <BookText size={14} />}
          Apply — collapse to one volume
        </button>
        <button type="button" onClick={onCancel} disabled={committing} className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-white">
          Cancel
        </button>
      </div>
    </div>
  );
}
