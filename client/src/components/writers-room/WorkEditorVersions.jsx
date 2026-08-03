import { useEffect, useState } from 'react';
import { Check, Clock } from 'lucide-react';
import { listCatalogIngredientsForRef } from '../../services/apiCatalog';

// WorkEditorVersions — the Versions drawer body for WorkEditor: the draft
// version list with the referenced-ingredient chips under each row.
// Extracted from WorkEditor (#3387).
export default function WorkEditorVersions({ work, dirty, onSwitch }) {
  const drafts = (work.drafts || []).slice().reverse();

  // Resolve referenced ingredient ids (stored per draft version) into display
  // names from the work's linked catalog cast. Only fetch when at least one
  // version actually carries refs — most works have none and we shouldn't hit
  // the catalog for them. The map is id → name; ids that no longer resolve
  // (unlinked since the version was saved) fall back to a short id chip.
  const hasRefs = drafts.some((d) => Array.isArray(d.referencedIngredientIds) && d.referencedIngredientIds.length > 0);
  const [nameById, setNameById] = useState({});
  useEffect(() => {
    if (!hasRefs || !work.id) return undefined;
    let cancelled = false;
    listCatalogIngredientsForRef('work', work.id, { silent: true })
      .then((rows) => {
        if (cancelled) return;
        const map = {};
        for (const row of rows || []) {
          const ing = row?.ingredient;
          if (ing?.id) map[ing.id] = ing.name || ing.id;
        }
        setNameById(map);
      })
      .catch(() => { if (!cancelled) setNameById({}); });
    return () => { cancelled = true; };
  }, [hasRefs, work.id]);

  if (drafts.length === 0) {
    return <div className="text-xs text-gray-500 italic">No versions yet. Click Snapshot in the header to create one.</div>;
  }
  return (
    <>
      {dirty && (
        <div className="mb-2 px-2 py-1.5 text-[11px] border border-port-warning/40 bg-port-warning/5 text-port-warning rounded">
          Save or snapshot before switching versions — unsaved edits will be lost.
        </div>
      )}
      <ul className="space-y-1 text-xs">
        {drafts.map((draft) => {
          const isActive = draft.id === work.activeDraftVersionId;
          const refIds = Array.isArray(draft.referencedIngredientIds) ? draft.referencedIngredientIds : [];
          return (
            <li key={draft.id}>
              <button
                onClick={() => onSwitch(draft.id)}
                disabled={isActive}
                className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-left ${
                  isActive ? 'bg-port-accent/20 text-port-accent cursor-default' : 'text-gray-400 hover:bg-port-bg hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {isActive ? <Check size={11} /> : <Clock size={11} />}
                  {draft.label}
                </span>
                <span className="text-[10px] text-gray-500">{draft.wordCount}w</span>
              </button>
              {refIds.length > 0 && (
                <div className="flex flex-wrap gap-1 px-2 pt-1 pb-0.5">
                  {refIds.map((id) => (
                    <span
                      key={id}
                      className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] text-gray-400 truncate max-w-[10rem]"
                      title={nameById[id] || id}
                    >
                      {nameById[id] || `${id.slice(0, 12)}…`}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
