import { useCallback, useState } from 'react';
import { Scale } from 'lucide-react';
import Pill from '../ui/Pill';
import BrailleSpinner from '../BrailleSpinner';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures';
import { scoreAppScopeAdherence } from '../../services/api';

/**
 * An on-demand, ADVISORY answer to "does this change advance what the product
 * says it is for?", rendered under one issue or pull-request row.
 *
 * Three deliberate constraints:
 *
 *  1. **Nothing is gated on it.** No button is disabled by a verdict, no row is
 *     hidden, no claim or merge is blocked. The output is a sentence naming a
 *     clause the reader can go and argue with.
 *  2. **It runs only when clicked.** The scorer is a 9 GB local model that
 *     loads on first use; scoring every visible row on mount would be exactly
 *     the cold-bootstrap work the AI Provider Usage Policy forbids.
 *  3. **It disappears when the feature is off.** An install that has not
 *     opted into the jev scorer never sees a button whose only outcome would
 *     be "not installed".
 */

const TONE = { aligned: 'success', contradicts: 'warning', unrelated: 'muted' };
const LABEL = { aligned: 'Advances', contradicts: 'Works against', unrelated: 'Unrelated' };

// Operator-facing wording for the failure codes this surface can actually
// produce. An unmapped code is a bug, not something to render raw at someone.
const REASON = {
  'scope-adherence-disabled': 'The local scope scorer is turned off for this install.',
  'scope-adherence-change-empty': 'This row has no title or description to score.',
  'scope-adherence-corpus-missing': 'This repository has no PRD.md or GOALS.md to score against.',
  'scope-adherence-corpus-unreadable': 'This repository\'s PRD.md / GOALS.md could not be read.',
  'scope-adherence-no-clause': 'No stated goal in this repository is close enough to score against.',
  'jev-not-installed': 'The local scorer is not installed yet — see Models > LLMs > jev.',
  'jev-start-failed': 'The local scorer could not start. Check Models > LLMs > jev.',
  'jev-timeout': 'The local scorer did not answer in time.',
};

const reasonFor = (code) => REASON[code] || 'The local scorer could not answer for this change.';

export default function ScopeAdherenceCheck({ appId, kind, title, body = '', diffSummary = '' }) {
  const { isFeatureEnabled } = useInstanceFeatures();
  const [result, setResult] = useState(null);
  const [scoring, setScoring] = useState(false);

  const check = useCallback(() => {
    setScoring(true);
    setResult(null);
    scoreAppScopeAdherence(appId, { kind, title, body, diffSummary })
      .then((response) => setResult(response || { ok: false }))
      // The tab owns its error UI and an uninstalled scorer is an ordinary
      // answer here, so a failed request reads as "no advisory", never a toast.
      .catch(() => setResult({ ok: false }))
      .finally(() => setScoring(false));
  }, [appId, kind, title, body, diffSummary]);

  if (!isFeatureEnabled('jev')) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        onClick={check}
        disabled={scoring}
        className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-0.5 text-gray-400 hover:text-port-accent hover:border-port-accent/40 disabled:opacity-50"
        title="Advisory only — scores this change against the repository's PRD.md and GOALS.md locally"
      >
        {scoring ? <BrailleSpinner /> : <Scale size={12} />}
        {scoring ? 'Scoring…' : 'Check scope'}
      </button>

      {result?.ok && result.verdict !== 'abstained' && (
        <>
          <Pill tone={TONE[result.verdict]} size="xs">{LABEL[result.verdict]}</Pill>
          {/* The clause, not just the score. A bare margin is noise. */}
          <span className="text-gray-400">
            {result.clause?.sourceFile}
            {result.clause?.headingPath ? ` § ${result.clause.headingPath}` : ''}
          </span>
          <span className="text-gray-600 italic">advisory only</span>
        </>
      )}

      {result?.ok && result.verdict === 'abstained' && (
        <span className="text-gray-500">No advisory — the scorer could not separate the options.</span>
      )}

      {result && !result.ok && <span className="text-gray-500">{reasonFor(result.code)}</span>}
    </div>
  );
}
