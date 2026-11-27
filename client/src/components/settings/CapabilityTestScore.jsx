import { Check, X } from 'lucide-react';

const KeywordRow = ({ entry, required }) => (
  <div className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
    {entry.hit
      ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="found" />
      : <X size={13} className={`${required ? 'text-port-error' : 'text-gray-600'} shrink-0`} aria-label="not found" />}
    <span className={`text-xs ${entry.hit ? 'text-gray-300' : 'text-gray-500'}`}>{entry.label}</span>
    <span className="ml-auto text-[10px] text-gray-600 font-mono">{entry.any.join(' | ')}</span>
  </div>
);

/** Required/bonus keyword scoring for the vision test. */
function KeywordScore({ detail }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Required</h4>
          <span className="text-[11px] text-gray-500">{detail.requiredHit} of {detail.requiredTotal} — all needed to pass</span>
        </div>
        {detail.required.map((entry) => <KeywordRow key={entry.id} entry={entry} required />)}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Bonus</h4>
          <span className="text-[11px] text-gray-500">{detail.bonusHit} of {detail.bonusTotal} — detail work, never fails a run</span>
        </div>
        {detail.bonus.map((entry) => <KeywordRow key={entry.id} entry={entry} />)}
      </div>
    </div>
  );
}

/** Twelve-beat coverage for the story test. */
function BeatScore({ detail }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="text-xs font-medium text-gray-400">Beat coverage</h4>
        <span className="text-[11px] text-gray-500">
          {detail.found} of {detail.total}{detail.found > 1 && !detail.inOrder ? ' — out of order' : ' — in order'}
        </span>
      </div>
      {detail.beats.map((beat, i) => (
        <div key={beat.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
          {beat.hit
            ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="present" />
            : <X size={13} className="text-port-error shrink-0" aria-label="missing" />}
          <span className={`text-xs ${beat.hit ? 'text-gray-300' : 'text-gray-500'}`}>{i + 1} · {beat.label}</span>
          {!beat.hit && <span className="ml-auto text-[10px] text-gray-600">missing</span>}
        </div>
      ))}
      <p className="text-[11px] text-gray-500 mt-2 leading-snug">
        Coverage is structure, not quality — it only says the model held a twelve-part shape across a long
        generation. Whether the outline is any good is above.
      </p>
    </div>
  );
}

/** Structural checks for the fiction scene, kept distinct from prose quality. */
function FictionScore({ detail }) {
  const craftChecks = Object.entries(detail.craft || {});
  const craftPassed = craftChecks.filter(([, passed]) => passed).length;

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-gray-500">Words</dt><dd className="text-gray-200">{detail.wordCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Paragraphs</dt><dd className="text-gray-200">{detail.paragraphCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Dialogue</dt><dd className="text-gray-200">{detail.hasDialogue ? 'yes' : 'no'}</dd></div>
      </dl>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Scene anchors</h4>
          <span className="text-[11px] text-gray-500">{detail.requiredHit} of {detail.requiredTotal} — all needed to pass</span>
        </div>
        {(detail.required || []).map((entry) => <KeywordRow key={entry.id} entry={entry} required />)}
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h4 className="text-xs font-medium text-gray-400">Scene signals</h4>
          <span className="text-[11px] text-gray-500">{detail.bonusHit} of {detail.bonusTotal}</span>
        </div>
        {(detail.bonus || []).map((entry) => <KeywordRow key={entry.id} entry={entry} />)}
      </div>
      <p className="text-[11px] text-gray-500">Minimum craft checks: {craftPassed} of {craftChecks.length}</p>
      <p className="text-[11px] text-gray-500 leading-snug">
        This is a structural screen for a saved scene, not a literary-quality score. Read the scene above
        before choosing a writing model.
      </p>
    </div>
  );
}

/** On-disk checks for the sandbox test. */
function SandboxChecks({ detail }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500 leading-snug">
        Every check reads the sandbox on disk after the agent stopped, never the transcript. A model that
        says it fixed the module scores nothing for saying so.
      </p>
      {(detail.checks || []).map((check) => (
        <div key={check.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0">
          {check.ok
            ? <Check size={13} className="text-emerald-400 shrink-0" aria-label="passed" />
            : <X size={13} className="text-port-error shrink-0" aria-label="failed" />}
          <span className={`text-xs ${check.ok ? 'text-gray-300' : 'text-gray-500'}`}>{check.label}</span>
        </div>
      ))}
      <dl className="grid grid-cols-2 gap-2 text-xs pt-1">
        <div><dt className="text-gray-500">Tool calls</dt><dd className="text-gray-200">{detail.toolCalls ?? 0}</dd></div>
        <div><dt className="text-gray-500">Verify exit code</dt><dd className="text-gray-200">{detail.verifyExitCode ?? '—'}</dd></div>
        <div className="col-span-2">
          <dt className="text-gray-500">Verified with</dt>
          <dd className="text-gray-300 font-mono break-all">{detail.verifyCommand}</dd>
        </div>
        {detail.sandboxPath && (
          <div className="col-span-2">
            <dt className="text-gray-500">Sandbox kept at</dt>
            <dd className="text-gray-400 font-mono break-all text-[11px]">{detail.sandboxPath}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Calibration summary for the committed rhetoric reference corpus. */
function RhetoricReferenceScore({ detail }) {
  const worst = [...(detail.items || [])]
    .sort((a, b) => b.absoluteError - a.absoluteError)
    .slice(0, 5);
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500 leading-snug">
        PortOS compares the model&rsquo;s scores with a fixed, fictional gold set. Lower error is better;
        the verdict also requires broad agreement so a model cannot hide a few extreme misses behind an average.
      </p>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div><dt className="text-gray-500">References</dt><dd className="text-gray-200">{detail.evaluatedCount ?? detail.referenceCount ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Mean error</dt><dd className="text-gray-200">{detail.meanAbsoluteError ?? '—'} pts</dd></div>
        <div><dt className="text-gray-500">Within 10</dt><dd className="text-gray-200">{detail.within10Count ?? '—'}</dd></div>
        <div><dt className="text-gray-500">Within 20</dt><dd className="text-gray-200">{detail.within20Count ?? '—'}</dd></div>
      </dl>
      {worst.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-gray-400 mb-1">Largest calibration gaps</h4>
          {worst.map((item) => (
            <div key={item.id} className="flex items-center gap-2 py-1.5 border-b border-port-border/50 last:border-b-0 text-xs">
              <span className="font-mono text-gray-500">{item.id}</span>
              <span className="ml-auto text-gray-400">gold {item.expected}</span>
              <span className="text-gray-400">model {item.predicted}</span>
              <span className="text-port-warning">Δ {item.absoluteError}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SCORE_VIEWS = {
  'image-analysis': KeywordScore,
  'story-outline': BeatScore,
  'fiction-scene': FictionScore,
  'rhetoric-reference': RhetoricReferenceScore,
  'sandbox-repair': SandboxChecks,
};

export default function CapabilityTestScore({ testId, detail }) {
  const ScoreView = SCORE_VIEWS[testId];
  return detail && ScoreView
    ? <ScoreView detail={detail} />
    : <p className="text-xs text-gray-500">Nothing was scored — the run failed before it produced anything.</p>;
}
