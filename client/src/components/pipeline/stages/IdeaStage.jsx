import { useMemo, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import TextStagePanel from './TextStagePanel';
import toast from '../../ui/Toast';
import { generatePipelineStage } from '../../../services/api';

// Pulls the bullets out of a `## Open questions` markdown section. Returns
// [] when the section is absent or empty — which is the desired steady state.
function parseOpenQuestions(markdown) {
  if (!markdown) return [];
  const match = markdown.match(/##\s+Open questions\b[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function buildRefinementSeed(originalSeed, qa) {
  const block = qa
    .map(({ q, a }) => `- Q: ${q}\n  A: ${a || '(no specific answer — make a decisive choice that fits the bible)'}`)
    .join('\n');
  return `${originalSeed.trim()}

## User answers to open questions

The previous beat sheet raised the questions below. Apply these answers throughout the revised beat sheet and OMIT the "Open questions" section entirely in this revision.

${block}`;
}

export default function IdeaStage(props) {
  const { issue, series, onStageUpdate, actionsGated = false } = props;
  const output = issue.stages?.idea?.output || '';
  const seedInput = issue.stages?.idea?.input || '';
  const questions = useMemo(() => parseOpenQuestions(output), [output]);
  const [answers, setAnswers] = useState({});
  const [refining, setRefining] = useState(false);

  const handleRefine = async () => {
    setRefining(true);
    const qa = questions.map((q, i) => ({ q, a: (answers[i] || '').trim() }));
    const augmented = buildRefinementSeed(seedInput, qa);
    const result = await generatePipelineStage(issue.id, 'idea', {
      seedInput: augmented,
      providerId: series?.llm?.provider || undefined,
      model: series?.llm?.model || undefined,
    }).catch((err) => {
      toast.error(err.message || 'Refinement failed');
      return null;
    });
    setRefining(false);
    if (!result) return;
    onStageUpdate?.('idea', result.stage);
    setAnswers({});
    toast.success('Beat sheet refined with your answers');
  };

  return (
    <div className="space-y-4">
      <TextStagePanel
        {...props}
        stageId="idea"
        generateLabel="Generate beat sheet"
        seedPlaceholder="A rough idea for this issue — a single sentence is fine. The LLM expands it into a beat sheet."
        outputPlaceholder="The generated beat sheet will appear here. You can edit it freely; downstream stages use this content verbatim as upstream context."
        actionsGated={actionsGated}
      />

      {questions.length > 0 ? (
        <section className="bg-port-warning/5 border border-port-warning/30 rounded-lg p-4 space-y-3">
          <header className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-port-warning">
              {questions.length} open question{questions.length === 1 ? '' : 's'} from the LLM
            </h3>
            <button
              type="button"
              onClick={handleRefine}
              disabled={refining || actionsGated}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border bg-port-bg text-port-warning border-port-warning/40 hover:bg-port-warning/10 disabled:opacity-40"
              title={actionsGated ? 'Saving settings…' : 'Re-run the beat sheet, folding your answers in and dropping the open-questions section'}
            >
              {refining ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Refine with answers
            </button>
          </header>
          <p className="text-xs text-gray-400">
            Answer below, then refine. Blank answers tell the LLM to commit to its own best guess on that question.
          </p>
          <ul className="space-y-2">
            {questions.map((q, i) => (
              <li key={i} className="space-y-1">
                <div className="text-xs text-gray-300">{q}</div>
                <input
                  type="text"
                  value={answers[i] || ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [i]: e.target.value }))}
                  placeholder="Your answer (optional — leave blank for LLM's choice)"
                  className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
                  disabled={refining}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
