import { formatBytes } from '../../utils/formatters';
import { fieldClass, secondaryButton, titleCase } from './worldDrawerFields';

export default function WorldAppearanceFields({
  recipeDraft,
  mutateRecipe,
  design,
  assetOverridesDraft,
  mutateAssetOverride,
  dirty,
  busy,
  projectionActionBlocked,
  onRefreshAssets,
  numeric,
}) {
  const assetRecipes = recipeDraft?.assetRecipe?.slots || {};
  const assetRows = [
    ...Object.entries(assetRecipes).map(([slot, recipe]) => ({ slot, recipe, legacy: false })),
    ...Object.keys(assetOverridesDraft || {})
      .filter((slot) => !Object.hasOwn(assetRecipes, slot))
      .sort()
      .map((slot) => ({ slot, recipe: null, legacy: true })),
  ];

  const { numericValue, updateNumericDraft, finishNumericDraft } = numeric;

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-port-border bg-port-bg p-4">
        <h3 className="font-medium text-white">Dawn atmosphere</h3>
        <p className="mt-1 text-xs leading-5 text-gray-500">Lightweight skymesh, three authored lights, restrained fog, and a grassy meeting park.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {[
            ['hours', 'Sun hour', 0, 24, 0.1],
            ['exposure', 'Exposure', 0.3, 1.8, 0.01],
            ['fog', 'Fog', 0, 3, 0.01],
          ].map(([key, label, min, max, step]) => (
            <label key={key} className="text-sm text-gray-300" htmlFor={`eidoverse-sky-${key}`}>
              {label}
              <input
                id={`eidoverse-sky-${key}`}
                className={fieldClass}
                type="number"
                min={min}
                max={max}
                step={step}
                value={numericValue(`sky.${key}`, recipeDraft?.environment?.sky?.[key] ?? '')}
                onChange={(event) => {
                  updateNumericDraft(`sky.${key}`, event.target.value, (number) => mutateRecipe((current) => ({
                    ...current,
                    environment: {
                      ...current.environment,
                      sky: { ...current.environment.sky, [key]: number },
                    },
                  })));
                }}
                onBlur={() => finishNumericDraft(`sky.${key}`)}
              />
            </label>
          ))}
          <label className="text-sm text-gray-300" htmlFor="eidoverse-grass-density">
            Grass density
            <input
              id="eidoverse-grass-density"
              className={fieldClass}
              type="number"
              min="0.1"
              max="2"
              step="0.05"
              value={numericValue('grass.density', recipeDraft?.environment?.grass?.density ?? '')}
              onChange={(event) => {
                updateNumericDraft('grass.density', event.target.value, (number) => mutateRecipe((current) => ({
                  ...current,
                  environment: {
                    ...current.environment,
                    grass: { ...current.environment.grass, density: number },
                  },
                })));
              }}
              onBlur={() => finishNumericDraft('grass.density')}
            />
          </label>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium text-white">Portable asset recipe</h3>
            <p className="mt-1 text-xs text-gray-500">Paths and search terms ship; model bytes stay in Eidoverse.</p>
          </div>
          <button
            type="button"
            className={secondaryButton}
            disabled={projectionActionBlocked}
            title={dirty ? 'Save changes before refreshing asset matches' : undefined}
            onClick={onRefreshAssets}
          >
            Refresh asset matches
          </button>
        </div>
        {dirty && <p className="mt-2 text-xs text-port-warning">Save changes before refreshing asset matches.</p>}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {assetRows.map(({ slot, recipe, legacy }) => {
            const resolution = design.assetResolutions?.[slot];
            return (
              <article key={slot} className="min-w-0 rounded-lg border border-port-border bg-port-bg p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium text-white">{titleCase(slot)}</h4>
                  <span className="rounded-full border border-port-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-400">
                    {legacy ? 'legacy V1 override' : (resolution?.source || 'pending')}
                  </span>
                </div>
                {legacy ? (
                  <>
                    <p className="mt-2 break-all text-xs leading-5 text-port-accent">{assetOverridesDraft[slot]}</p>
                    <p className="mt-2 text-[11px] leading-4 text-gray-500">
                      Preserved from World Design V1. Clear it to let the semantic V2 asset recipe choose this model.
                    </p>
                    <button
                      type="button"
                      className={secondaryButton + ' mt-3 w-full'}
                      disabled={busy}
                      onClick={() => mutateAssetOverride(slot, '')}
                    >
                      Clear legacy {titleCase(slot)} override
                    </button>
                  </>
                ) : (
                  <>
                <p className="mt-2 break-all text-xs leading-5 text-port-accent">{resolution?.path || 'Will resolve on the next projection'}</p>
                <p className="mt-2 text-[11px] leading-4 text-gray-500">Search: {recipe.fallbackQueries.join(' · ')}</p>
                <p className="text-[11px] text-gray-500">
                  {resolution?.bytes != null ? `${formatBytes(resolution.bytes)} selected · ` : ''}
                  Budget: {Math.round(recipe.maxBytes / 1_000_000)} MB · {recipe.sourcePolicy}
                </p>
                <label className="mt-3 block text-[11px] text-gray-500" htmlFor={`eidoverse-asset-override-${slot}`}>
                  Local override (optional)
                  <input
                    id={`eidoverse-asset-override-${slot}`}
                    className="mt-1 min-h-[36px] w-full rounded border border-port-border bg-port-card px-2 text-xs text-white"
                    value={assetOverridesDraft?.[slot] || ''}
                    onChange={(event) => mutateAssetOverride(slot, event.target.value)}
                    placeholder="eidoverse/... or store/..."
                    pattern="(?:eidoverse|store)[\\/](?!.*\.\.).*"
                  />
                </label>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
