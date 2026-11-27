import { Link } from 'react-router';
import { EIDOVERSE_SOURCE_ROUTES as SOURCE_ROUTES } from '../../lib/eidoverseFrame';
import EidoverseObjectLegend from './EidoverseObjectLegend';
import { secondaryButton, titleCase } from './worldDrawerFields';

export default function WorldDistrictFields({
  worldState,
  design,
  recipeDraft,
  projectionSummary,
  projectedIndicatorCount,
  projectedIndicatorLimit,
  busy,
  onReset,
  mutateRecipe,
  labelAliasesDraft,
  mutateLabelAlias,
  onAssets,
  numeric,
}) {
  const { numericValue, updateNumericDraft, finishNumericDraft } = numeric;

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-gray-400">
        PortOS projects bounded summary indicators, never raw records. Stable IDs keep each indicator in its district across refreshes.
        {projectedIndicatorCount === null
          ? ' The first projection has not reported a scene count yet.'
          : ` ${projectedIndicatorCount} are shown now; the ${projectedIndicatorLimit}-indicator limit keeps the scene legible.`}
      </p>
      {projectionSummary.truncated && (
        <p className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs leading-5 text-port-warning" role="status">
          The shared world cap omitted {' '}
          {Object.entries(projectionSummary.droppedBySource || {})
            .filter(([, count]) => count > 0)
            .map(([source, count]) => `${count} ${titleCase(source)}`)
            .join(', ')} signal(s). PortOS distributes available space across sources before adding extra signals.
        </p>
      )}
      {(recipeDraft?.districts || []).map((district) => (
        <section key={district.id} className="rounded-xl border border-port-border bg-port-bg p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: district.accent }} aria-hidden="true" />
                <h3 className="font-medium text-white">{district.label}</h3>
              </div>
              <p className="mt-1 text-xs text-gray-500">{district.direction} · {district.landmark}</p>
            </div>
            <button
              type="button"
              className={secondaryButton}
              aria-label={`Reset ${district.label}`}
              disabled={busy}
              onClick={() => onReset('district', district.id)}
            >
              Reset district
            </button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {district.sources.map((source) => (
              <div key={source} className="flex min-h-[58px] items-center gap-3 rounded-lg border border-port-border/70 px-3">
                <input
                  id={`eidoverse-source-${source}`}
                  type="checkbox"
                  checked={recipeDraft.includes?.[source] === true}
                  onChange={(event) => mutateRecipe((current) => ({
                    ...current,
                    includes: { ...current.includes, [source]: event.target.checked },
                  }))}
                />
                <div className="min-w-0 flex-1">
                  <label className="block truncate text-sm text-gray-300" htmlFor={`eidoverse-source-${source}`}>
                    {titleCase(source)}
                  </label>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-gray-500">
                    <span>{projectionSummary.sourceAvailability?.[source] === false
                      ? 'Stale · last good held'
                      : (projectionSummary.sourceCounts?.[source] ?? 'Not projected')}
                    {projectionSummary.droppedBySource?.[source] > 0
                      ? ` · ${projectionSummary.droppedBySource[source]} omitted by cap`
                      : ''}</span>
                    {SOURCE_ROUTES[source] && <Link className="text-port-accent hover:underline" to={SOURCE_ROUTES[source]}>Open in PortOS</Link>}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-500" htmlFor={`eidoverse-limit-${source}`}>
                  Cap
                  <input
                    id={`eidoverse-limit-${source}`}
                    className="h-8 w-16 rounded border border-port-border bg-port-card px-2 text-sm text-white"
                    type="number"
                    min="0"
                    max="48"
                    value={numericValue(`limit.${source}`, recipeDraft.limits?.[source] ?? 0)}
                    disabled={!recipeDraft.includes?.[source]}
                    onChange={(event) => {
                      updateNumericDraft(`limit.${source}`, event.target.value, (number) => mutateRecipe((current) => ({
                        ...current,
                        limits: { ...current.limits, [source]: number },
                      })));
                    }}
                    onBlur={() => finishNumericDraft(`limit.${source}`)}
                  />
                </label>
              </div>
            ))}
          </div>
        </section>
      ))}
      <EidoverseObjectLegend
        objects={projectionSummary.objects}
        districts={worldState?.recipe?.districts}
        aliases={labelAliasesDraft}
        savedAliases={design.labelAliases}
        onAliasChange={mutateLabelAlias}
        busy={busy}
        onAssets={onAssets}
      />
    </div>
  );
}
