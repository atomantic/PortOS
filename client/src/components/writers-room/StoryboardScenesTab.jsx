// ─── Scenes (outline from prose headings) ─────────────────────────────────
export default function StoryboardScenesTab({ activeDraft, onJumpToScene }) {
  const segs = activeDraft?.segmentIndex || [];
  if (segs.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-gray-500 italic">
        No segments yet. Use <code className="text-gray-300"># Chapter</code> /{' '}
        <code className="text-gray-300">## Scene</code> /{' '}
        <code className="text-gray-300">### Beat</code> headings in your prose to populate the outline.
      </div>
    );
  }
  return (
    <ul className="px-3 py-3 space-y-1 text-[11px]">
      {segs.map((seg) => {
        const indent = seg.kind === 'beat' ? 'pl-4' : seg.kind === 'scene' ? 'pl-2' : '';
        const tone = seg.kind === 'chapter' ? 'text-white font-semibold' : seg.kind === 'scene' ? 'text-gray-200' : 'text-gray-500';
        return (
          <li key={seg.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={onJumpToScene ? () => onJumpToScene({ heading: seg.heading }) : undefined}
              disabled={!onJumpToScene}
              className={`flex-1 truncate text-left hover:text-port-accent disabled:hover:text-inherit ${indent} ${tone}`}
              title={onJumpToScene ? 'Jump to this segment in the prose' : seg.heading}
            >
              {seg.heading}
            </button>
            <span className="text-[9px] text-gray-600 shrink-0">{seg.wordCount}w</span>
          </li>
        );
      })}
    </ul>
  );
}
