import { Link } from 'react-router-dom';
import { Loader2, Sparkles, Info, ChartSpline } from 'lucide-react';
import { useSeriesEditorial } from '../../../hooks/useSeriesEditorial';
import { dominant } from '../../../lib/editorialRoadmap';
import ArcRoadmapChart from './ArcRoadmapChart.jsx';
import RoadmapMetric from './RoadmapMetric.jsx';

export default function EditorialRoadmapPanel({ series, seasons, issues }) {
  const seasonCount = seasons.length;
  const issueCount = issues.length;
  const {
    aggregate, loading, running, starting,
    startAnalysis, cancelAnalysis, coverage, analyzedPoints, progressText,
  } = useSeriesEditorial(series.id);

  const hasData = analyzedPoints.length > 0;
  const plotVals = analyzedPoints.map((p) => p.plot);
  const avgPlot = plotVals.length ? Math.round(plotVals.reduce((a, b) => a + b, 0) / plotVals.length) : null;
  const peakPlot = plotVals.length ? Math.max(...plotVals) : null;
  const peakAt = peakPlot != null ? analyzedPoints.find((p) => p.plot === peakPlot)?.label : '';
  const protagonist = aggregate?.protagonist || null;
  const supportingCount = aggregate?.supportingArcs?.length || 0;
  const readerEmotion = dominant(analyzedPoints.map((p) => p.primaryEmotion));

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
            Editorial roadmap
            <Info
              size={12}
              className="text-gray-600"
              title="Plot = narrative tension (stakes/pace). Character = how far the protagonist's arc advances. Reader = the reader's emotional journey (low = bleak, high = joyful). All three are read from each issue's actual content by an LLM."
            />
          </h2>
          <p className="text-[11px] text-gray-600">
            {seasonCount} volume{seasonCount === 1 ? '' : 's'}, {issueCount} issue{issueCount === 1 ? '' : 's'}
            {' · '}
            <span className={coverage.stale ? 'text-port-warning' : ''}>
              {coverage.analyzed}/{coverage.total} analyzed{coverage.stale ? ` · ${coverage.stale} stale` : ''}
            </span>
          </p>
        </div>
        <ChartSpline size={18} className="text-port-accent" />
      </div>

      <div className="h-48 rounded border border-port-border bg-port-bg/70 p-3">
        {loading ? (
          <div className="h-full flex items-center justify-center text-xs text-gray-500">
            <Loader2 size={14} className="animate-spin mr-1.5" /> Loading roadmap…
          </div>
        ) : hasData ? (
          <ArcRoadmapChart points={analyzedPoints} />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center gap-2 px-3">
            <p className="text-xs text-gray-500 italic">
              {coverage.withContent === 0
                ? 'No drafted content yet — write or generate prose/scripts, then run analysis.'
                : 'Not analyzed yet. Run the reader analysis to map plot, character, and reader emotion from the actual content.'}
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <RoadmapMetric
          label="Plot"
          value={avgPlot != null ? `avg ${avgPlot}` : 'Run analysis'}
          sub={peakPlot != null ? `peak ${peakPlot}${peakAt ? ` @ ${peakAt}` : ''}` : 'narrative tension'}
          tone="text-port-accent"
          title="Narrative tension across analyzed issues (0–100): stakes, danger, pace."
        />
        <RoadmapMetric
          label="Character"
          value={protagonist ? protagonist.name : 'Run analysis'}
          sub={protagonist ? `${protagonist.arcDirection || 'arc'}${supportingCount ? ` · +${supportingCount} arc${supportingCount === 1 ? '' : 's'}` : ''}` : 'protagonist arc'}
          tone="text-emerald-300"
          title="The detected protagonist and arc direction, plus how many supporting characters have arcs."
        />
        <RoadmapMetric
          label="Reader"
          value={readerEmotion || 'Run analysis'}
          sub={hasData ? 'dominant emotion' : 'emotional journey'}
          tone="text-amber-300"
          title="The reader's emotional journey, read section-by-section from the content. Open the reader map for the full log."
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {running ? (
          <button
            type="button"
            onClick={cancelAnalysis}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-port-border text-gray-300 hover:border-port-error/50"
          >
            <Loader2 size={13} className="animate-spin" />
            {progressText || 'Analyzing…'} (cancel)
          </button>
        ) : (
          <button
            type="button"
            onClick={startAnalysis}
            disabled={starting || coverage.withContent === 0}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25 disabled:opacity-40 disabled:cursor-not-allowed"
            title={coverage.withContent === 0 ? 'No drafted content to analyze yet' : 'Run an LLM pass over each issue to map reader emotion, plot tension, and character arcs'}
          >
            {starting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {coverage.analyzed > 0 ? 'Re-run reader map' : 'Interpret reader map'}
          </button>
        )}
        <Link
          to={`/pipeline/series/${series.id}/roadmap`}
          className="text-xs text-gray-400 hover:text-port-accent underline-offset-2 hover:underline"
        >
          View reader map →
        </Link>
      </div>
    </section>
  );
}
