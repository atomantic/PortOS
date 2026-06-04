import {
  Clapperboard, Loader2, RefreshCcw, AlertTriangle, Check,
  Users, MapPin as MapPinIcon, ArrowRight, SlidersHorizontal,
} from 'lucide-react';

// 3-step setup that replaces the old single "Run Adapt" CTA. Recommended
// order is characters → settings → script so Adapt's prompt has the bibles
// to cite (otherwise the LLM re-improvises descriptions every scene). The
// user can skip any step (clicking later steps directly is allowed) or just
// click "Run all in order" to fire the sequential pipeline.
export function StoryboardSetup({
  charactersCount,
  placesCount,
  onRunCharacters,
  onRunPlaces,
  onRunAdapt,
  onRunFullPipeline,
  runningKind,
}) {
  const isRunning = !!runningKind;
  const charDone = charactersCount > 0;
  const setDone = placesCount > 0;

  const Step = ({ n, kind, done, label, sublabel, hint, onClick, primary = false }) => {
    const running = runningKind === kind;
    const Icon = done ? Check : kind === 'characters' ? Users : kind === 'places' ? MapPinIcon : Clapperboard;
    return (
      <div className={`flex items-start gap-2.5 p-2.5 border rounded ${
        done ? 'border-port-success/40 bg-port-success/5' :
        running ? 'border-port-accent/60 bg-port-accent/5' :
        'border-port-border bg-port-card/30'
      }`}>
        <div className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-semibold ${
          done ? 'border-port-success text-port-success' :
          running ? 'border-port-accent text-port-accent' :
          'border-port-border text-gray-500'
        }`}>
          {done ? <Check size={10} /> : running ? <Loader2 size={10} className="animate-spin" /> : n}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon size={12} className={done ? 'text-port-success' : running ? 'text-port-accent' : 'text-gray-500'} />
            <span className="text-[11px] font-medium text-gray-200">{label}</span>
            {done && <span className="text-[10px] text-port-success">{sublabel}</span>}
          </div>
          {!done && (
            <div className="text-[10px] text-gray-500 mt-0.5">{hint}</div>
          )}
          <button
            type="button"
            onClick={onClick}
            disabled={isRunning || !onClick}
            className={`mt-1.5 inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded disabled:opacity-50 ${
              primary
                ? 'bg-port-accent text-white hover:bg-port-accent/80'
                : 'border border-port-border text-gray-300 hover:bg-port-border/40'
            }`}
          >
            {running ? <Loader2 size={10} className="animate-spin" /> : null}
            {done ? 'Re-run' : running ? 'Running…' : `Run ${kind === 'script' ? 'Adapt' : kind}`}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="px-1 py-1 space-y-3">
      <div className="text-center space-y-1">
        <Clapperboard size={24} className="mx-auto text-gray-600" />
        <div className="text-[12px] text-gray-300 font-medium">No storyboard yet</div>
        <div className="text-[11px] text-gray-500 max-w-[36ch] mx-auto">
          For best results, scan your prose for characters and settings first — Adapt will reference both bibles when generating scene descriptions, keeping people and places visually consistent.
        </div>
      </div>

      <div className="space-y-1.5">
        <Step
          n={1}
          kind="characters"
          done={charDone}
          label="Extract characters"
          sublabel={`${charactersCount} found`}
          hint="Names, image-gen-ready physical descriptions, personality, role"
          onClick={onRunCharacters}
        />
        <Step
          n={2}
          kind="places"
          done={setDone}
          label="Extract places / world"
          sublabel={`${placesCount} location${placesCount === 1 ? '' : 's'}`}
          hint="Locations keyed by slugline (description, palette, era, recurring details)"
          onClick={onRunPlaces}
        />
        <Step
          n={3}
          kind="script"
          done={false}
          label="Run Adapt"
          sublabel=""
          hint="Break prose into scene-by-scene storyboard. Cites the bibles above for consistency."
          onClick={onRunAdapt}
          primary
        />
      </div>

      <button
        type="button"
        onClick={onRunFullPipeline}
        disabled={isRunning || !onRunFullPipeline}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-port-accent text-white text-[11px] rounded hover:bg-port-accent/80 disabled:opacity-50"
        title="Runs all three steps sequentially: characters → settings → Adapt. Skip if you want to run them individually."
      >
        {isRunning ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
        {isRunning ? `Running ${runningKind}…` : 'Run all in order →'}
      </button>

      {(charDone || setDone) && (
        <div className="text-[10px] text-gray-500 text-center">
          Tip: edit either bible in its tab above before running Adapt.
        </div>
      )}
    </div>
  );
}

export function FailedAdaptBanner({ failure, onRunAdapt, runningAdapt, onOpenConfig, hasPriorScript }) {
  const error = failure?.error || 'Adapt failed for an unknown reason';
  const isTimeout = /timed out/i.test(error);
  return (
    <div className="p-3 mb-2 border border-port-error/40 bg-port-error/5 rounded text-[11px] space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-port-error mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-port-error font-medium">Adapt failed</div>
          <div className="text-gray-300 break-words">{error}</div>
          {isTimeout && (
            <div className="text-gray-500 mt-1">
              Long drafts are heavy for small/light models — try a faster model
              (e.g. an API provider) in the Config tab.
            </div>
          )}
          {!hasPriorScript && (
            <div className="text-gray-500 mt-1">
              No prior storyboard to fall back to — re-running will create the first one.
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          onClick={onOpenConfig}
          className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40"
        >
          <SlidersHorizontal size={10} /> Adjust LLM
        </button>
        <button
          onClick={onRunAdapt}
          disabled={runningAdapt || !onRunAdapt}
          className="flex items-center gap-1 px-2 py-1 bg-port-error/20 border border-port-error/40 text-port-error rounded text-[10px] hover:bg-port-error/30 disabled:opacity-50"
        >
          {runningAdapt ? <Loader2 size={10} className="animate-spin" /> : <RefreshCcw size={10} />}
          Re-run Adapt
        </button>
      </div>
    </div>
  );
}

// Surfaced when the storyboard exists but one or both bibles are empty —
// Adapt's visualPrompts won't be referencing canonical descriptions, so
// the user gets visual drift across scenes. Inline run buttons let them
// fix it without leaving the panel; re-running Adapt afterwards picks up
// the populated bibles.
export function BiblesMissingNotice({ charactersMissing, placesMissing, onRunCharacters, onRunPlaces, runningKind }) {
  const isRunning = !!runningKind;
  const missing = [
    charactersMissing && 'character bible',
    placesMissing && 'places bible',
  ].filter(Boolean);
  return (
    <div className="flex items-start gap-2 p-2 mb-1 border border-port-warning/40 bg-port-warning/5 rounded text-[11px]">
      <AlertTriangle size={12} className="text-port-warning mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-port-warning">
          Storyboard built without {missing.join(' or ')}
        </div>
        <div className="text-gray-500">
          Scene visualPrompts re-improvise descriptions every render — populating the bibles and re-running Adapt locks them in.
        </div>
        <div className="flex gap-1.5 mt-1.5">
          {charactersMissing && (
            <button
              onClick={onRunCharacters}
              disabled={isRunning || !onRunCharacters}
              className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40 disabled:opacity-50"
            >
              {runningKind === 'characters' ? <Loader2 size={10} className="animate-spin" /> : <Users size={10} />}
              Extract characters
            </button>
          )}
          {placesMissing && (
            <button
              onClick={onRunPlaces}
              disabled={isRunning || !onRunPlaces}
              className="flex items-center gap-1 px-2 py-1 border border-port-border text-gray-300 rounded text-[10px] hover:bg-port-border/40 disabled:opacity-50"
            >
              {runningKind === 'places' ? <Loader2 size={10} className="animate-spin" /> : <MapPinIcon size={10} />}
              Extract places
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function StaleBanner({ onRunAdapt, runningAdapt }) {
  return (
    <div className="flex items-start gap-2 p-2 mb-1 border border-port-warning/40 bg-port-warning/5 rounded text-[11px]">
      <AlertTriangle size={12} className="text-port-warning mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-port-warning">Storyboard is older than your current draft.</div>
        <div className="text-gray-500">Re-run Adapt to refresh scenes against the latest prose.</div>
      </div>
      <button
        onClick={onRunAdapt}
        disabled={runningAdapt || !onRunAdapt}
        className="flex items-center gap-1 px-2 py-1 bg-port-warning/20 border border-port-warning/40 text-port-warning rounded text-[10px] hover:bg-port-warning/30 disabled:opacity-50"
      >
        {runningAdapt ? <Loader2 size={10} className="animate-spin" /> : <RefreshCcw size={10} />}
        Re-run
      </button>
    </div>
  );
}
