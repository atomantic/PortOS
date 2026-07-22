import CoverArt from './CoverArt.jsx';

export default function VolumeNavigator({ seasons, issuesBySeason, activeSeasonId, onSelect }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xs uppercase tracking-wider text-gray-500">Volumes</h2>
          <p className="text-[11px] text-gray-600">{seasons.length} volume{seasons.length === 1 ? '' : 's'} in this arc</p>
        </div>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1 snap-x">
        {seasons.map((season) => {
          const active = season.id === activeSeasonId;
          const issueCount = issuesBySeason.get(season.id)?.length || 0;
          return (
            <button
              key={season.id}
              type="button"
              onClick={() => onSelect(season.id)}
              aria-pressed={active}
              className={`snap-start shrink-0 w-44 text-left rounded border overflow-hidden bg-port-bg transition-colors ${
                active
                  ? 'border-port-accent shadow-[0_0_0_1px_rgba(59,130,246,0.35)]'
                  : 'border-port-border hover:border-port-accent/50'
              }`}
            >
              <div className="aspect-[3/4] bg-port-bg">
                <CoverArt
                  record={season.cover}
                  label={`Volume ${season.number} cover`}
                  className="rounded-none border-0"
                  placeholderClassName="rounded-none border-0"
                />
              </div>
              <div className="p-2 min-h-[72px]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-gray-500">V{season.number}</span>
                  <span className="text-[10px] uppercase tracking-wider text-gray-500">
                    {issueCount}/{season.episodeCountTarget || '?'}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-white line-clamp-2">{season.title || '(untitled)'}</p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
