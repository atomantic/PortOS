/**
 * Perspective Rewrite panel (#1290) — "Rewrite in another POV" + analysis.
 *
 * Lives under the Prose stage. Lets the writer re-lens the issue's drafted
 * passage through another cast character's point of view (a revision exercise),
 * then shows the original and the rewrite side-by-side plus a structured
 * "what we learn" analysis. Non-destructive: rewrites are stored as alternate
 * artifacts server-side; the canonical draft is never touched here.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Trash2, ChevronDown, ChevronRight, Drama } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  getPipelinePerspectiveRewrites,
  createPipelinePerspectiveRewrite,
  deletePipelinePerspectiveRewrite,
} from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { timeAgo } from '../../../utils/formatters';

const SOURCE_LABEL = { prose: 'prose', comicScript: 'comic script', teleplay: 'teleplay' };

function AnalysisList({ title, items }) {
  if (!items?.length) return null;
  return (
    <div>
      <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">{title}</h5>
      <ul className="list-disc list-inside space-y-1 text-sm text-gray-300">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

function RewriteCard({ issue, rewrite, onDelete }) {
  const [open, setOpen] = useState(false);
  const original = (issue.stages?.[rewrite.sourceStage]?.output || '').trim();
  const analysis = rewrite.analysis || {};
  const arc = analysis.arcStrength || {};

  const [runDelete, deleting] = useAsyncAction(
    () => deletePipelinePerspectiveRewrite(issue.id, rewrite.id),
    { errorMessage: 'Failed to delete rewrite' },
  );

  const handleDelete = async () => {
    const result = await runDelete();
    if (result?.removed) {
      onDelete(rewrite.id);
      toast.success('Rewrite removed');
    }
  };

  return (
    <div className="border border-port-border rounded-lg bg-port-bg">
      <div className="flex items-center justify-between gap-2 p-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left min-w-0 flex-1"
        >
          {open ? <ChevronDown size={14} className="shrink-0 text-gray-400" /> : <ChevronRight size={14} className="shrink-0 text-gray-400" />}
          <span className="text-sm font-medium text-white truncate">
            {rewrite.povCharacterName}
            {rewrite.povCharacterRole ? <span className="text-gray-500 font-normal"> ({rewrite.povCharacterRole})</span> : null}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-gray-600 shrink-0">{SOURCE_LABEL[rewrite.sourceStage] || rewrite.sourceStage}</span>
          {rewrite.stale ? (
            <span className="text-[10px] uppercase tracking-wider text-port-warning shrink-0" title="The source draft changed since this rewrite was generated">stale</span>
          ) : null}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-gray-600">{timeAgo(rewrite.createdAt)}</span>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            aria-label="Delete rewrite"
            className="p-1 text-gray-500 hover:text-port-error disabled:opacity-40"
          >
            {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </div>

      {open ? (
        <div className="px-3 pb-3 space-y-4">
          {analysis.oneLine ? (
            <p className="text-sm text-gray-300 italic border-l-2 border-port-accent/40 pl-3">{analysis.oneLine}</p>
          ) : null}

          {/* Side-by-side: original vs rewrite */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Original</h5>
              <div className="max-h-80 overflow-auto whitespace-pre-wrap text-sm text-gray-400 bg-port-card border border-port-border rounded p-3 leading-relaxed">
                {original || '(source draft is now empty)'}
              </div>
            </div>
            <div>
              <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">{rewrite.povCharacterName}&rsquo;s POV</h5>
              <div className="max-h-80 overflow-auto whitespace-pre-wrap text-sm text-gray-200 bg-port-card border border-port-border rounded p-3 leading-relaxed">
                {rewrite.rewrite}
              </div>
            </div>
          </div>

          {/* What we learn */}
          <div className="space-y-3 bg-port-card border border-port-border rounded p-3">
            <h4 className="text-xs uppercase tracking-wider text-port-accent">What we learn</h4>
            <AnalysisList title="New information / interiority" items={analysis.newInformation} />
            <AnalysisList title="What the original POV was hiding" items={analysis.hiddenInformation} />
            {(arc.rationale || arc.score) ? (
              <div>
                <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">
                  Arc strength: {arc.score ?? 0}/100
                  {arc.strongerThanOriginal ? <span className="text-port-success"> · stronger than original</span> : <span className="text-gray-500"> · not stronger than original</span>}
                </h5>
                {arc.rationale ? <p className="text-sm text-gray-300">{arc.rationale}</p> : null}
              </div>
            ) : null}
            {analysis.foldBackSuggestions?.length ? (
              <div>
                <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Fold-back suggestions</h5>
                <ul className="space-y-2 text-sm text-gray-300">
                  {analysis.foldBackSuggestions.map((f, i) => (
                    <li key={i}>
                      <span className="text-gray-200">{f.suggestion}</span>
                      {f.rationale ? <span className="text-gray-500"> — {f.rationale}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {analysis.povJustification ? (
              <div>
                <h5 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">POV justification</h5>
                <p className="text-sm text-gray-300">{analysis.povJustification}</p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function PovRewritePanel({ issue, series }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [povId, setPovId] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getPipelinePerspectiveRewrites(issue.id, { silent: true })
      .then((res) => { if (alive) setData(res); })
      .catch(() => { if (alive) setData({ cast: [], rewrites: [], hasContent: false }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [issue.id]);

  const cast = data?.cast || [];
  const rewrites = data?.rewrites || [];
  const hasContent = data?.hasContent;

  // Default the picker to the first cast member once loaded.
  useEffect(() => {
    if (!povId && cast.length) setPovId(cast[0].id);
  }, [cast, povId]);

  const [runGenerate, generating] = useAsyncAction(
    () => createPipelinePerspectiveRewrite(issue.id, {
      povCharacterId: povId,
      providerId: series?.llm?.provider || undefined,
      model: series?.llm?.model || undefined,
    }),
    { errorMessage: 'Failed to generate rewrite' },
  );

  const handleGenerate = async () => {
    const result = await runGenerate();
    if (!result?.rewrite) return;
    setData((prev) => ({ ...prev, rewrites: [result.rewrite, ...(prev?.rewrites || [])] }));
    toast.success(`Rewrote in ${result.rewrite.povCharacterName}'s POV`);
  };

  const handleDelete = (rewriteId) =>
    setData((prev) => ({ ...prev, rewrites: (prev?.rewrites || []).filter((r) => r.id !== rewriteId) }));

  const disabledReason = useMemo(() => {
    if (!hasContent) return 'Draft prose (or a comic script / teleplay) for this issue first';
    if (!cast.length) return 'Link this series to a universe with characters to pick a POV';
    return null;
  }, [hasContent, cast.length]);

  return (
    <section className="space-y-3 border-t border-port-border pt-5">
      <div className="flex items-center gap-2">
        <Drama size={16} className="text-port-accent" />
        <h3 className="text-base font-semibold text-white">Perspective Lab</h3>
        <span className="text-xs text-gray-500">rewrite this issue in another character&rsquo;s POV</span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="block">
              <span className="block text-xs uppercase tracking-wider text-gray-500 mb-1">POV character</span>
              <select
                value={povId}
                onChange={(e) => setPovId(e.target.value)}
                disabled={!cast.length || generating}
                className="px-3 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-40 min-w-[12rem]"
              >
                {cast.length === 0 ? <option value="">No cast available</option> : null}
                {cast.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.role ? ` (${c.role})` : ''}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating || !!disabledReason || !povId}
              title={disabledReason || undefined}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Rewrite in another POV
            </button>
          </div>

          {disabledReason ? (
            <p className="text-xs text-gray-500">{disabledReason}.</p>
          ) : null}

          {rewrites.length === 0 ? (
            <p className="text-sm text-gray-600">No alternate-POV rewrites yet. Pick a character and generate one — the original draft stays untouched.</p>
          ) : (
            <div className="space-y-2">
              {rewrites.map((r) => (
                <RewriteCard key={r.id} issue={issue} rewrite={r} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
