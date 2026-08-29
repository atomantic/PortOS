// Brain > Ideas hosts two deliberately separate models, so it presents them as
// two sibling views rather than one merged list:
//   - "Brain ideas"     — native federated idea records (the shared MemoryTab surface)
//   - "IdeaLoom lists"  — machine-local ordered list documents (never federated)
// The active view lives in the URL (`?view=lists`) so it is shareable,
// bookmarkable, and reachable from ⌘K / voice, per client/src/AGENTS.md.
import { Lightbulb, ListOrdered } from 'lucide-react';
import useUrlParams from '../../../hooks/useUrlParams';
import TabPills from '../../ui/TabPills';
import MemoryTab from './MemoryTab';
import IdeaLoomLists from '../IdeaLoomLists';

const LISTS_VIEW = 'lists';

const VIEWS = [
  { id: 'ideas', label: 'Brain ideas', icon: Lightbulb },
  { id: LISTS_VIEW, label: 'IdeaLoom lists', icon: ListOrdered }
];

export default function IdeasTab({ onRefresh }) {
  const [searchParams, updateParams] = useUrlParams();
  const view = searchParams.get('view') === LISTS_VIEW ? LISTS_VIEW : 'ideas';

  // `list` addresses an IdeaLoom list, so it clears with the view that owns it.
  // Flipping a view replaces rather than pushes — Back should leave the page,
  // not walk the user back through every pill they clicked.
  const changeView = (next) => updateParams(
    next === LISTS_VIEW ? { view: LISTS_VIEW } : { view: null, list: null },
    { replace: true },
  );

  return (
    <div className="flex flex-col gap-3">
      <TabPills
        tabs={VIEWS}
        activeTab={view}
        onChange={changeView}
        variant="pills"
        size="sm"
        ariaLabel="Ideas views"
        controlsIdPrefix="brain-ideas"
      />
      <div id={`brain-ideas-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === LISTS_VIEW
          ? <IdeaLoomLists />
          : <MemoryTab onRefresh={onRefresh} fixedType="ideas" />}
      </div>
    </div>
  );
}
