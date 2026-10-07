/**
 * Pipeline — Reverse Outline (#1286).
 *
 * A color-coded scene map of the drafted manuscript: rows = plotlines, columns
 * = scenes in reading order. Each filled cell is a scene on that plotline
 * (primary = solid, secondary = ring); clicking jumps into the manuscript
 * editor at that scene's issue. Surfaces thread cadence, gaps, and tangles at a
 * glance. Generation streams progress over SSE.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { Loader2, RefreshCw, X, ArrowLeft, BookOpen, AlertTriangle, Compass } from 'lucide-react';
import toast from '../components/ui/Toast';
import PageSkeleton from '../components/ui/PageSkeleton';
import {
  getPipelineSeries,
  getReverseOutline,
  generateReverseOutline,
  cancelReverseOutline,
  getReverseOutlineStatus,
  pipelineReverseOutlineSseUrl,
} from '../services/api';
import { useSeriesRunLifecycle } from '../hooks/useSeriesRunLifecycle';
import RunRecoveryBanner from '../components/pipeline/RunRecoveryBanner';
import useUrlParams from '../hooks/useUrlParams';
import { buildPlotlineGrid, sceneComponentCount } from '../lib/reverseOutlineGrid.js';
import { pluralize } from '../lib/textUtils';

export default function PipelineReverseOutline() {
  const { seriesId } = useParams();
  // Live series identity for the outline read below. Assigned during render so
  // the comparison always sees the CURRENT series, not the one captured when
  // the effect ran.
  const seriesIdRef = useRef(seriesId);
  seriesIdRef.current = seriesId;
  const navigate = useNavigate();
  const [series, setSeries] = useState(null);
  const [outline, setOutline] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  // Scene selection lives in the URL (`?scene=<sceneId>`) so the open detail
  // panel is shareable, bookmarkable, and survives a reload.
  const [searchParams, updateParams] = useUrlParams();
  // Supersession token for the outline re-read below.
  const outlineRequestRef = useRef(0);

  // Re-read the saved outline, dropping a response that a newer read or a
  // series switch has superseded.
  const reloadOutline = () => {
    const req = ++outlineRequestRef.current;
    const forSeries = seriesId;
    getReverseOutline(seriesId)
      .then((o) => { if (req === outlineRequestRef.current && seriesIdRef.current === forSeries) setOutline(o); })
      .catch(() => {});
  };

  // The run's lifecycle — terminal frame, stream closed without one, cancel
  // settlement — lives in the shared hook; this page owns the result + toasts.
  const run = useSeriesRunLifecycle({
    scopeId: seriesId,
    urlBuilder: pipelineReverseOutlineSseUrl,
    fetchStatus: getReverseOutlineStatus,
    requestCancel: cancelReverseOutline,
    onTerminal: (frame) => {
      if (frame.type === 'complete') {
        reloadOutline();
        if (frame.status === 'no-content') toast.warning('Nothing drafted yet — write or import a manuscript first');
        else toast.success(`Reverse outline ready — ${pluralize(frame.sceneCount || 0, 'scene')}`);
      } else if (frame.type === 'canceled') {
        toast.success('Reverse outline canceled');
      } else {
        toast.error(frame.error || 'Reverse outline failed');
      }
    },
    onReconciled: ({ canceled }) => {
      reloadOutline();
      toast.success(canceled ? 'Reverse outline canceled' : 'Reverse outline run finished — showing the saved outline');
    },
  });
  const { active, adopt: adoptRun } = run;

  // Load series + outline, and re-attach to an in-flight run on (re)mount.
  useEffect(() => {
    let canceled = false;
    setLoading(true);
    Promise.all([
      getPipelineSeries(seriesId, { silent: true }),
      getReverseOutline(seriesId, { silent: true }),
      getReverseOutlineStatus(seriesId).catch(() => ({ active: false })),
    ])
      .then(([s, o, status]) => {
        if (canceled) return;
        setSeries(s);
        setOutline(o);
        if (status?.active) adoptRun();
      })
      .catch((err) => {
        if (canceled) return;
        toast.error(err.message || 'Failed to load reverse outline');
        navigate('/pipeline');
      })
      .finally(() => { if (!canceled) setLoading(false); });
    return () => { canceled = true; };
  }, [seriesId, navigate, adoptRun]);

  const handleGenerate = async (force) => {
    const forSeries = seriesId;
    setStarting(true);
    // The regenerated outline mints new scene ids — drop the stale selection.
    updateParams({ scene: null }, { replace: true });
    // Await the POST so the run is registered server-side BEFORE the SSE
    // subscription connects — otherwise the progress stream 404s on attach.
    const res = await generateReverseOutline(seriesId, { force }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to start reverse outline');
      return null;
    });
    setStarting(false);
    // A kickoff acknowledged after the user switched series belongs to the old one.
    if (!res?.runId || seriesIdRef.current !== forSeries) return;
    adoptRun(res.runId);
  };

  if (loading) {
    return (
      <PageSkeleton
        label="Loading reverse outline"
        fullHeight
        padded
        headerRowClass="flex flex-wrap items-center gap-2"
        titleWidthClass="w-56"
        showAction={false}
        cards={3}
        sidebar={false}
      />
    );
  }

  const scenes = outline?.scenes || [];
  const plotlines = outline?.plotlines || [];
  const hasOutline = outline?.status === 'complete' && scenes.length > 0;
  const busy = active || starting;
  const { rows } = buildPlotlineGrid(scenes, plotlines);
  // A stale/deleted `?scene=` id resolves to null — the detail panel falls back
  // to its "click a marker" placeholder instead of rendering a blank card.
  const selected = scenes.find((s) => s.id === searchParams.get('scene')) || null;
  const handleSelect = (scene) => updateParams({ scene: scene.id });

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-2 mb-4">
        <Link
          to={`/pipeline/series/${seriesId}`}
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border bg-port-card"
          title="Back to series"
        >
          <ArrowLeft size={12} /> Series
        </Link>
        <h1 className="text-lg font-semibold text-white flex items-center gap-2">
          <Compass size={18} className="text-port-accent" /> Reverse Outline
        </h1>
        {series?.name ? <span className="text-sm text-gray-400 truncate">— {series.name}</span> : null}
        <div className="ml-auto flex items-center gap-2">
          {active ? (
            <button
              type="button"
              onClick={run.cancel}
              disabled={Boolean(run.cancelState)}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-port-border bg-port-card text-sm text-gray-300 hover:text-white disabled:opacity-50"
            >
              <X size={14} /> {run.cancelState ? 'Canceling…' : 'Cancel'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => handleGenerate(hasOutline)}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-50"
            title={hasOutline ? 'Re-segment the current manuscript' : 'Segment the manuscript into a reverse outline'}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {busy ? 'Generating…' : hasOutline ? 'Regenerate' : 'Generate outline'}
          </button>
        </div>
      </header>

      <RunRecoveryBanner
        recovery={run.recovery}
        cancelPending={run.cancelState === 'pending'}
        noun="reverse outline"
        onReattach={run.reattach}
        onRetryStatus={run.retryStatus}
      />

      {outline?.stale && hasOutline ? (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg border border-port-warning/40 bg-port-warning/10 text-port-warning text-sm">
          <AlertTriangle size={14} />
          The manuscript changed since this outline was generated — regenerate to refresh.
        </div>
      ) : null}

      {!hasOutline ? (
        <EmptyState status={outline?.status} active={busy} />
      ) : (
        <div className="flex flex-col gap-4">
          <PlotlineLegend rows={rows} />
          <PlotlineGrid rows={rows} scenes={scenes} selected={selected} onSelect={handleSelect} />
          <SceneDetail scene={selected} plotlines={plotlines} seriesId={seriesId} navigate={navigate} />
          <p className="text-xs text-gray-500">
            {scenes.length} scenes · {plotlines.length} plotlines
            {outline?.truncated ? ' · manuscript truncated for analysis (long series)' : ''}
          </p>
        </div>
      )}
    </div>
  );
}

function EmptyState({ status, active }) {
  if (active) {
    return (
      <div className="text-center text-gray-400 py-16">
        <Loader2 className="animate-spin mx-auto mb-3" size={24} />
        Segmenting the manuscript into scenes…
      </div>
    );
  }
  if (status === 'no-content') {
    return (
      <div className="text-center text-gray-400 py-16">
        <BookOpen className="mx-auto mb-3 opacity-40" size={28} />
        Nothing is drafted yet. Write or import a manuscript, then generate the reverse outline.
      </div>
    );
  }
  return (
    <div className="text-center text-gray-400 py-16">
      <Compass className="mx-auto mb-3 opacity-40" size={28} />
      No reverse outline yet. Generate one to map your scenes by plotline.
    </div>
  );
}

function PlotlineLegend({ rows }) {
  return (
    <div className="flex flex-wrap gap-3">
      {rows.map(({ plotline, count }) => (
        <span key={plotline.id} className="inline-flex items-center gap-1.5 text-xs text-gray-300">
          <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: plotline.color }} />
          <span className="font-medium">{plotline.label}</span>
          <span className="text-gray-500">· {plotline.kind} · {count}</span>
        </span>
      ))}
    </div>
  );
}

function PlotlineGrid({ rows, scenes, selected, onSelect }) {
  return (
    <div className="overflow-x-auto border border-port-border rounded-lg">
      <table className="border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-port-card text-left text-xs text-gray-500 font-normal px-3 py-2 min-w-[10rem]">
              Plotline
            </th>
            {scenes.map((scene) => (
              <th key={scene.id} className="px-0.5 py-2 text-[10px] text-gray-600 font-normal align-bottom">
                {scene.issueNumber != null ? scene.issueNumber : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ plotline, cells }) => (
            <tr key={plotline.id} className="border-t border-port-border/50">
              <td className="sticky left-0 z-10 bg-port-card px-3 py-1.5 min-w-[10rem]">
                <span className="inline-flex items-center gap-1.5 text-xs text-gray-300">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: plotline.color }} />
                  <span className="truncate max-w-[8rem]" title={plotline.label}>{plotline.label}</span>
                </span>
              </td>
              {cells.map((cell, i) => (
                <td key={scenes[i].id} className="px-0.5 py-1.5 text-center">
                  {cell ? (
                    <button
                      type="button"
                      onClick={() => onSelect(cell.scene)}
                      title={`${scenes[i].heading || 'Scene'}${cell.role === 'secondary' ? ' (secondary)' : ''}`}
                      className={`w-3.5 h-3.5 rounded-full inline-block align-middle transition-transform hover:scale-125 ${selected?.id === cell.scene.id ? 'ring-2 ring-white' : ''}`}
                      style={cell.role === 'primary'
                        ? { backgroundColor: plotline.color }
                        : { boxShadow: `inset 0 0 0 2px ${plotline.color}` }}
                    />
                  ) : (
                    <span className="w-3.5 h-3.5 inline-block align-middle" />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SceneDetail({ scene, plotlines, seriesId, navigate }) {
  if (!scene) {
    return <p className="text-xs text-gray-500">Click a scene marker to see its detail.</p>;
  }
  const plotline = plotlines.find((p) => p.id === scene.plotlineId);
  const componentLabels = ['narrative', 'action', 'dialogue'].filter((k) => scene.components?.[k]);
  return (
    <div className="border border-port-border rounded-lg p-4 bg-port-card flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {plotline ? <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: plotline.color }} /> : null}
        <h2 className="text-sm font-semibold text-white">{scene.heading || 'Scene'}</h2>
        <span className="text-xs text-gray-500">
          {plotline?.label || 'Unassigned'}
          {scene.issueNumber != null ? ` · Issue ${scene.issueNumber}` : ''}
        </span>
        {scene.issueNumber != null ? (
          <button
            type="button"
            onClick={() => navigate(`/pipeline/series/${seriesId}/manuscript/${scene.issueNumber}`)}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-400 hover:text-white border border-port-border"
            title="Open this scene's issue in the manuscript editor"
          >
            <BookOpen size={12} /> Open in editor
          </button>
        ) : null}
      </div>
      {scene.summary ? <p className="text-sm text-gray-300">{scene.summary}</p> : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        {scene.povCharacter ? <span>POV: <span className="text-gray-300">{scene.povCharacter}</span></span> : null}
        {scene.setting ? <span>Setting: <span className="text-gray-300">{scene.setting}</span></span> : null}
        <span>
          Components: <span className={sceneComponentCount(scene) >= 2 ? 'text-port-success' : 'text-port-warning'}>
            {componentLabels.length ? componentLabels.join(' · ') : 'none detected'}
          </span>
        </span>
        {scene.charactersPresent?.length ? (
          <span>Present: <span className="text-gray-300">{scene.charactersPresent.join(', ')}</span></span>
        ) : null}
      </div>
      {scene.anchorQuote ? <p className="text-xs italic text-gray-500">“{scene.anchorQuote}”</p> : null}
    </div>
  );
}
