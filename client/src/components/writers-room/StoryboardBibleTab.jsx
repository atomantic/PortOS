import { Loader2, RefreshCcw } from 'lucide-react';
import CharactersBible from './CharactersBible';
import PlacesBible from './PlacesBible';
import ObjectsBible from './ObjectsBible';

const BIBLE_KINDS = {
  characters: {
    label: 'Character bible',
    sub: 'Persisted across runs · feeds image-gen prompts',
    refreshNoun: 'characters',
    Component: CharactersBible,
    propName: 'characters',
    changeProp: 'onCharactersChange',
  },
  world: {
    label: 'World / places bible',
    sub: 'Locations keyed by slugline · feeds image-gen prompts',
    refreshNoun: 'world',
    Component: PlacesBible,
    propName: 'places',
    changeProp: 'onPlacesChange',
  },
  objects: {
    label: 'Recurring objects',
    sub: 'Symbolic / recurring items the prose returns to',
    refreshNoun: 'objects',
    Component: ObjectsBible,
    propName: 'objects',
    changeProp: 'onObjectsChange',
  },
};

function RefreshHeader({ noun, label, sub, running, anyRunning, onRefresh, empty }) {
  return (
    <div className="flex items-start justify-between gap-2 pb-2 border-b border-port-border">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-gray-200">{label}</div>
        <div className="text-[10px] text-gray-500">{sub}</div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={anyRunning || !onRefresh}
        className="shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-port-bg border border-port-border text-gray-300 hover:bg-port-card hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
        title={empty ? `Extract ${noun} from prose` : `Re-extract ${noun} from prose (merges into existing)`}
      >
        {running
          ? <Loader2 size={10} className="animate-spin text-port-accent" />
          : <RefreshCcw size={10} />
        }
        {running ? 'Refreshing…' : empty ? 'Extract from prose' : 'Refresh from prose'}
      </button>
    </div>
  );
}

export default function StoryboardBibleTab({
  kind,
  workId,
  items,
  onItemsChange,
  onRefresh,
  running,
  anyRunning,
  readingTheme,
  hotRefId = null,
}) {
  const meta = BIBLE_KINDS[kind];
  const Bible = meta.Component;
  const bibleProps = {
    workId,
    [meta.propName]: items,
    [meta.changeProp]: onItemsChange,
    readingTheme,
    hotRefId,
  };
  return (
    <div className="px-3 py-3 space-y-3">
      <RefreshHeader
        noun={meta.refreshNoun}
        label={meta.label}
        sub={meta.sub}
        running={running}
        anyRunning={anyRunning}
        onRefresh={onRefresh}
        empty={items.length === 0}
      />
      <Bible {...bibleProps} />
    </div>
  );
}
