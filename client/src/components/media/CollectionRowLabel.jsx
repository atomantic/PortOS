import { splitCollectionName } from '../../lib/mediaCollectionList.js';

// Collection name as rendered inside a CollectionPickerShell row (#3312) — the
// dropdown twin of the MediaCollections card title (#3283).
//
// Every Creative Director project / Writers Room batch / universe / series
// render bucket auto-files itself as a collection named
// "<Creator>: <the part that actually differs>". Rendered flat in a ~240px
// popover row those all read as the same clipped prefix, so `splitCollectionName`
// lifts the prefix into a small badge above the title and the distinguishing
// tail gets the full row width. User-named collections (and mood boards) have no
// prefix and render as a plain title, exactly as before.
//
// The full original name stays reachable as the `title` tooltip, matching the
// card.
export default function CollectionRowLabel({ name }) {
  const { badge, title } = splitCollectionName(name);
  return (
    <span className="min-w-0 flex-1 flex flex-col items-start gap-0.5" title={name}>
      {badge && (
        <span className="text-[9px] uppercase tracking-wide text-gray-400 bg-port-bg border border-port-border rounded px-1 py-px leading-tight">
          {badge}
        </span>
      )}
      <span className="break-words text-left">{title}</span>
    </span>
  );
}
