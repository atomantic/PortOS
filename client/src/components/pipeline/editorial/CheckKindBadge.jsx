/**
 * The catalog kind → human label + tone for an editorial check, shared by the
 * catalog card (EditorialCheckCard) and the findings-triage group header
 * (EditorialFindingsTriage, #1604) so "rule vs LLM" reads identically in both.
 * A deterministic/rule check is a hard heuristic; an LLM check is a model
 * judgement — surfacing the distinction helps the user triage false positives.
 */
import { memo } from 'react';

const KIND_BADGE = {
  deterministic: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  llm: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
};

function CheckKindBadge({ kind, className = '' }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${KIND_BADGE[kind] || KIND_BADGE.deterministic} ${className}`}>
      {kind === 'llm' ? 'LLM' : 'rule'}
    </span>
  );
}

export default memo(CheckKindBadge);
