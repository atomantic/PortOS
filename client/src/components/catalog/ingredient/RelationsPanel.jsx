import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, X } from 'lucide-react';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair.jsx';
import IngredientPicker from '../../IngredientPicker';
import { CATALOG_BADGE_BY_ID, RELATION_KINDS, getRelationKind, isFamilyRelationKind } from '../../../lib/catalogTypes';
import { ingredientPath } from '../../../lib/creativeLibraries';

// "Relations" panel — ingredient↔ingredient edges. Outbound edges (this
// ingredient → other) are user-editable here; inbound edges (other → this
// ingredient) are read-only because the owning ingredient is the other end.
export default function RelationsPanel({ record, relations, evidence, onAdd, onRemove, readOnly = false, retainedSourceId }) {
  // A character's family ties live in its Family picker.
  const shown = (r) => record.type !== 'character' || !isFamilyRelationKind(r.kind ?? r.id);
  const kinds = RELATION_KINDS.filter(shown);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [kind, setKind] = useState(kinds[0].id);
  const [armedRelation, setArmedRelation] = useState(null);
  const [removingRelation, setRemovingRelation] = useState(null);
  const outbound = Array.isArray(relations.outbound) ? relations.outbound.filter(shown) : [];
  const inbound = Array.isArray(relations.inbound) ? relations.inbound.filter(shown) : [];
  const evidenceList = Array.isArray(evidence)
    ? evidence.filter((item) => typeof item === 'string' && item.trim())
    : typeof evidence === 'string' && evidence.trim()
    ? evidence.split('\n').map((s) => s.trim()).filter(Boolean)
    : [];

  // Hide the current record + everything already linked outbound from the
  // picker so the user can't double-link or self-link.
  const excludeIds = [record.id, ...outbound.map((r) => r.toId)];

  const chip = (other) => {
    const badge = CATALOG_BADGE_BY_ID[other?.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
    return (
      <Link to={ingredientPath({ type: other?.type, id: other?.id })}
        className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-200 hover:opacity-80">
        <span className="truncate max-w-[16rem]">{other?.name || other?.id || '(unnamed)'}</span>
        <span className={`text-[9px] uppercase tracking-wider px-1 py-0.5 rounded border ${badge}`}>{other?.type}</span>
      </Link>
    );
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">Relations</h2>
        <div className="flex items-center gap-2">
          <label htmlFor="relation-kind" className="sr-only">Relation kind</label>
          <select id="relation-kind" disabled={readOnly} value={kind} onChange={(e) => setKind(e.target.value)}
            className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-xs text-white focus:outline-none focus:border-port-accent">
            {kinds.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <button type="button" onClick={() => setPickerOpen(true)} disabled={readOnly}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent hover:bg-port-accent/90 text-white text-xs font-medium">
            <Plus size={12} aria-hidden="true" /> Add relation
          </button>
        </div>
      </div>

      {outbound.length === 0 && inbound.length === 0 ? (
        <p className="text-xs text-gray-500">No relations yet. Link this ingredient to another (a character to the place they live, a scene to its cast, …).</p>
      ) : (
        <div className="space-y-3">
          {outbound.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Outbound</div>
              <ul className="space-y-2">
                {outbound.map((r) => {
                  const relationKey = `${r.toId}-${r.kind}`;
                  const relationName = r.other?.name || r.toId;
                  // Extraction stores exact directed kind/target prefixes in
                  // the source payload. A name mention cannot prove an edge.
                  const evidencePrefix = `${r.kind} → ${relationName}: `.replace(/\s+/g, ' ');
                  const matchedEvidence = evidenceList.find((item) => item.startsWith(evidencePrefix));
                  const evidenceSnippet = matchedEvidence?.slice(evidencePrefix.length);
                  return (
                    <li key={relationKey} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.label || r.kind}</span>
                        {chip(r.other)}
                        {!readOnly && !(retainedSourceId && [r.fromId, r.toId].includes(retainedSourceId)) && (armedRelation === relationKey ? (
                          <ConfirmButtonPair
                            prompt="Remove?"
                            confirmText="Remove"
                            busyText="Removing"
                            busy={removingRelation === relationKey}
                            ariaLabel={`Confirm removal of relation to ${relationName}`}
                            onCancel={() => setArmedRelation(null)}
                            onConfirm={async () => {
                              setRemovingRelation(relationKey);
                              await onRemove(r.toId, r.kind);
                              setRemovingRelation(null);
                              setArmedRelation(null);
                            }}
                          />
                        ) : (
                          <button type="button" onClick={() => setArmedRelation(relationKey)}
                            aria-label={`Remove relation to ${relationName}`}
                            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-port-error">
                            <X size={12} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                      {retainedSourceId && [r.fromId, r.toId].includes(retainedSourceId) && <p className="text-xs text-gray-500">Retained source relation · read-only</p>}
                      {evidenceSnippet && (
                        <p className="text-[11px] text-gray-400 italic pl-3 border-l border-port-border">
                          “{evidenceSnippet}”
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {inbound.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Inbound</div>
              <ul className="space-y-2">
                {inbound.map((r) => {
                  const inboundKey = `${r.fromId}-${r.kind}`;
                  // Incoming evidence belongs to the other ingredient and is
                  // not included in this detail response.
                  return (
                    <li key={inboundKey} className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-400">{getRelationKind(r.kind)?.inverseLabel || r.kind}</span>
                        {chip(r.other)}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      <IngredientPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => onAdd(picked, kind)}
        excludeIds={excludeIds}
      />
    </section>
  );
}
