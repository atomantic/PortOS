import { useId, useMemo, useRef } from 'react';
import { Wand2, X, Check, Star, Crown } from 'lucide-react';
import useFocusTrap from '../../hooks/useFocusTrap.js';
import { GOAL_TYPE_CONFIG } from './goalConstants';

export default function OrganizePanel({ suggestion, goals, onApply, onClose, applying }) {
  const goalMap = useMemo(() => new Map((goals || []).map(g => [g.id, g])), [goals]);
  const headingId = useId();
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  useFocusTrap(Boolean(suggestion), panelRef, { initialFocusRef: headingRef });

  if (!suggestion) return null;

  const handleKeyDown = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={handleKeyDown} className="absolute top-12 right-3 z-20 bg-port-card border border-port-border rounded-lg p-4 w-96 max-w-[calc(100vw-1rem)] max-h-dvh-cap [--dvh-cap:80dvh] overflow-y-auto shadow-xl">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-port-accent" aria-hidden="true" />
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-white">Goal Organization</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center"><X className="w-4 h-4" aria-hidden="true" /></button>
      </div>

      {suggestion.analysis && (
        <p className="text-xs text-gray-400 mb-3 leading-relaxed">{suggestion.analysis}</p>
      )}

      {/* Apex goal suggestion */}
      {suggestion.apexGoal && (
        <div className="mb-3 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-center gap-1.5 mb-1">
            <Crown className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <h3 className="text-xs font-medium text-amber-400">Apex Goal (North Star)</h3>
          </div>
          {suggestion.apexGoal.existingId ? (
            <p className="text-xs text-gray-300">{goalMap.get(suggestion.apexGoal.existingId)?.title || suggestion.apexGoal.existingId}</p>
          ) : (
            <div>
              <p className="text-xs text-white font-medium">{suggestion.apexGoal.suggestedTitle}</p>
              {suggestion.apexGoal.suggestedDescription && (
                <p className="text-xs text-gray-400 mt-0.5">{suggestion.apexGoal.suggestedDescription}</p>
              )}
              <span className="text-xs text-amber-300 italic">New goal — will be created when applied</span>
            </div>
          )}
        </div>
      )}

      {/* Organization */}
      {suggestion.organization?.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <h3 className="text-xs font-medium text-gray-400">Proposed Hierarchy</h3>
          {suggestion.organization.map(item => {
            const goal = goalMap.get(item.id);
            const typeCfg = GOAL_TYPE_CONFIG[item.goalType] || GOAL_TYPE_CONFIG.standard;
            const parent = item.suggestedParentId ? goalMap.get(item.suggestedParentId) : null;
            return (
              <div key={item.id} className="p-2 rounded bg-port-bg/50 border border-port-border/50">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${typeCfg.bg} ${typeCfg.color}`}>
                    {typeCfg.label}
                  </span>
                  <span className="text-xs text-white truncate">{goal?.title || item.id}</span>
                </div>
                {parent && (
                  <div className="text-xs text-gray-400 mt-0.5 ml-1">
                    under: {parent.title}
                  </div>
                )}
                {item.reasoning && (
                  <p className="text-xs text-gray-400 mt-0.5 ml-1">{item.reasoning}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Suggested sub-apex goals */}
      {suggestion.suggestedSubApex?.length > 0 && (
        <div className="mb-3 space-y-1.5">
          <h3 className="text-xs font-medium text-gray-400">Suggested Sub-Apex Goals</h3>
          {suggestion.suggestedSubApex.map((sg, i) => (
            <div key={i} className="p-2 rounded bg-purple-500/5 border border-purple-500/20">
              <div className="flex items-center gap-1.5">
                <Star className="w-3 h-3 text-purple-400" aria-hidden="true" />
                <span className="text-xs text-white font-medium">{sg.title}</span>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{sg.description}</p>
              <span className="text-xs text-purple-300 italic">New goal — will be created when applied</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-2 border-t border-port-border">
        <button
          type="button"
          onClick={onApply}
          disabled={applying}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 min-h-[40px]"
        >
          <Check className="w-4 h-4" aria-hidden="true" />
          {applying ? 'Applying...' : 'Apply Changes'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 text-sm rounded-lg bg-port-border text-gray-300 hover:bg-gray-600 min-h-[40px]"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

