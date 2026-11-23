import { useState, useId, useMemo } from 'react';
import { Link } from 'react-router';
import {
  Sparkles, Lock, Unlock, Check, RefreshCw, Loader2, ExternalLink, Wand2,
} from 'lucide-react';
import ListLoadError from '../ui/ListLoadError';
import toast from '../ui/Toast';
import EntryThumbSlot from '../universe/EntryThumbSlot';
import StyleProbeImage from '../universe/StyleProbeImage';
import ArcCanvas from '../pipeline/ArcCanvas';
import useFieldDraft from '../../hooks/useFieldDraft';
import useImageRenderSettings from '../../hooks/useImageRenderSettings';
import useSingleImageRender from '../../hooks/useSingleImageRender';
import { composeCanonStyledPrompt } from '../../lib/composeStyledPrompt';
import { descriptorForCanonEntry } from '../../lib/canonPrompt';
import { pipelineImageCfgToRenderOpts } from '../../lib/pipelineImageDefaults';
import { RENDER_TARGET } from '../../lib/imageGenBackends';
import { buildUniverseSectionRenderTag } from '../../lib/universeRunTag';
import { BEAT_KIND_COLORS, getBeatKindColor } from '../../lib/beatColors';
import {
  updateStorySession,
  generateStoryStep,
  refineStoryStep,
  setStoryIssueLock,
  generateStoryIssues,
} from '../../services/apiStoryBuilder.js';
import { updateUniverse, patchUniverseCanonEntry } from '../../services/apiUniverseBuilder.js';
import { useStoryStepRun } from './useStoryStepRuns.jsx';

const FIELD_INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-gray-200 focus:border-port-accent focus:outline-none';

// Static read-only display by default. Passing `onCommit` (only while the step is
// unlocked) swaps in a buffered input that commits on blur, so a small fix needs
// neither an AI refine call nor a trip to another page.
function FieldBlock({ label, value, onCommit, singleLine = false }) {
  const id = useId();
  const draft = useFieldDraft(value, (next) => onCommit?.(next));
  if (!onCommit) {
    return (
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">{label}</div>
        <div className="text-sm text-gray-200 whitespace-pre-wrap">{value || <span className="text-gray-600 italic">— empty —</span>}</div>
      </div>
    );
  }
  const Control = singleLine ? 'input' : 'textarea';
  return (
    <div>
      <label htmlFor={id} className="block text-xs uppercase tracking-wide text-gray-500 mb-0.5">{label}</label>
      <Control
        id={id}
        {...(singleLine ? { type: 'text' } : { rows: 3 })}
        value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur}
        className={FIELD_INPUT_CLASS}
      />
    </div>
  );
}

const splitList = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);

// A compact timeline of the reader map's emotional beats: each beat is a bar
// positioned along the arc (normalized from `atArcPosition`) with its height
// set by `intensity` and its color by `kind`. Gives the reader-map step the
// at-a-glance escalation/pacing view the plain list can't. Beats without a
// position fall back to even spacing so they still render.
function ReaderMapBeatTimeline({ readerMap }) {
  const beats = Array.isArray(readerMap?.beats) ? readerMap.beats : [];
  if (beats.length === 0) return null;

  const W = 320;
  const H = 64;
  const PAD = 4;
  // Normalize positions: beats use an arbitrary `atArcPosition` scale (0..9999),
  // so map the observed [min,max] span onto the plot width. When every beat
  // shares a position (or none have one), fall back to even spacing by index.
  const positioned = beats.filter((b) => Number.isFinite(b.atArcPosition));
  const minPos = positioned.length ? Math.min(...positioned.map((b) => b.atArcPosition)) : 0;
  const maxPos = positioned.length ? Math.max(...positioned.map((b) => b.atArcPosition)) : 0;
  const span = maxPos - minPos;
  const xFor = (b, i) => {
    const usable = W - PAD * 2;
    if (span > 0 && Number.isFinite(b.atArcPosition)) {
      return PAD + ((b.atArcPosition - minPos) / span) * usable;
    }
    return beats.length === 1 ? W / 2 : PAD + (i / (beats.length - 1)) * usable;
  };

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Beat timeline</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-16 bg-port-bg border border-port-border rounded"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Reader-map beat timeline — ${beats.length} beats`}
      >
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#2a2a2a" strokeWidth="1" />
        {beats.map((b, i) => {
          const x = xFor(b, i);
          const intensity = Number.isFinite(b.intensity) ? Math.max(0, Math.min(1, b.intensity)) : 0.5;
          // Floor the drawn height so a real beat with intensity 0 still shows a
          // visible marker instead of a zero-height (invisible) bar.
          const barH = Math.max(2, (H - PAD * 2) * intensity);
          const color = getBeatKindColor(b.kind);
          return (
            <g key={b.id || i}>
              <rect x={x - 1.5} y={H - PAD - barH} width="3" height={barH} fill={color} rx="1" />
              <title>{`${b.kind}${b.intensity != null ? ` ${Math.round(intensity * 100)}%` : ''}${b.note ? ` — ${b.note}` : ''}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
        {Object.entries(BEAT_KIND_COLORS).map(([kind, color]) => (
          <span key={kind} className="inline-flex items-center gap-1 text-[10px] text-gray-500">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ backgroundColor: color }} /> {kind}
          </span>
        ))}
      </div>
    </div>
  );
}

// Compact read-only summary of the arc's ticking clock — shown above the reader
// map so the countdown the reader anticipates sits alongside the hooks/payoffs
// it threads through. Authored in the Arc Canvas; null/disabled clocks hide.
function TickingClockSummary({ clock }) {
  if (!clock || clock.enabled !== true) return null;
  const span = clock.plantedAtArcPosition != null || clock.dueAtArcPosition != null
    ? ` · arc ${clock.plantedAtArcPosition ?? '?'} → ${clock.dueAtArcPosition ?? '?'}` : '';
  const reminderCount = Array.isArray(clock.reminders) ? clock.reminders.length : 0;
  return (
    <div className="rounded border border-port-warning/40 bg-port-bg/50 px-2 py-1.5">
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-0.5">Ticking clock</div>
      <div className="text-sm text-gray-300">
        ⏱ {clock.label || '(unnamed countdown)'} <span className="text-gray-500">({clock.kind || 'custom'}{span})</span>
      </div>
      {clock.stakes ? <div className="text-xs text-gray-400 mt-0.5">{clock.stakes}</div> : null}
      {reminderCount ? <div className="text-[11px] text-gray-500 mt-0.5">{reminderCount} reminder beat(s)</div> : null}
    </div>
  );
}

function ReaderMapView({ readerMap, tickingClock }) {
  if (!readerMap && !(tickingClock && tickingClock.enabled === true)) {
    return <p className="text-gray-600 italic text-sm">No reader map yet. Generate one to plan the audience experience.</p>;
  }
  const Section = ({ title, items, render }) => (
    items?.length ? (
      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">{title} ({items.length})</div>
        <ul className="space-y-1">{items.map((it) => <li key={it.id} className="text-sm text-gray-300">{render(it)}</li>)}</ul>
      </div>
    ) : null
  );
  return (
    <div className="space-y-3">
      <TickingClockSummary clock={tickingClock} />
      <Section title="Hooks" items={readerMap?.hooks} render={(h) => `${h.atArcPosition != null ? `@${h.atArcPosition} · ` : ''}${h.label}${h.note ? ` — ${h.note}` : ''}`} />
      <Section title="Payoffs" items={readerMap?.payoffs} render={(p) => `${p.atArcPosition != null ? `@${p.atArcPosition} · ` : ''}${p.label}`} />
      <Section title="Beats" items={readerMap?.beats} render={(b) => `[${b.kind}${b.intensity != null ? ` ${Math.round(b.intensity * 100)}%` : ''}] ${b.note || ''}`} />
      <Section title="Cliffhangers" items={readerMap?.cliffhangers} render={(c) => `after #${c.atIssueBoundary ?? '?'} — ${c.note || ''}`} />
    </div>
  );
}

function RefineBox({ onRefine, disabled, busy, running, phase }) {
  const [feedback, setFeedback] = useState('');
  return (
    <div className="border-t border-port-border pt-3 mt-3">
      <label htmlFor="story-refine-feedback" className="block text-xs text-gray-500 mb-1">AI refinement feedback</label>
      <div className="flex gap-2">
        <input
          id="story-refine-feedback"
          type="text" value={feedback} onChange={(e) => setFeedback(e.target.value)}
          placeholder="e.g. make the midpoint reveal land harder"
          disabled={disabled || busy}
          className="flex-1 bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm disabled:opacity-50"
        />
        <button
          onClick={() => onRefine(feedback)} disabled={busy || disabled}
          className="inline-flex items-center gap-1 bg-port-card border border-port-border hover:border-port-accent px-3 py-1.5 rounded text-sm disabled:opacity-50 whitespace-nowrap"
        >
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
          {running ? (phase || 'Refining…') : 'Refine'}
        </button>
      </div>
    </div>
  );
}

// Buffered physicalDescription editor for one character row. Commits on blur
// through the canon-entry PATCH (never a full characters[] replace, which could
// clobber a sibling's just-persisted imageRefs), so the preview button beside it
// works the moment a description exists.
function CharacterDescriptionField({ character, universeId, onUniverseUpdate }) {
  const id = useId();
  const draft = useFieldDraft(character.physicalDescription, async (text) => {
    const result = await patchUniverseCanonEntry(universeId, 'character', character.id, { physicalDescription: text.trim() }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Save failed'); return null; });
    if (result?.universe) onUniverseUpdate?.(result.universe);
  });
  const fallback = Array.isArray(character.descriptor) ? character.descriptor.map((d) => d.value).join(', ') : '';
  return (
    <div>
      <label htmlFor={id} className="sr-only">{`Description for ${character.name}`}</label>
      <textarea
        id={id} rows={2}
        value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur}
        placeholder={fallback || 'Describe their appearance to enable a preview'}
        className="w-full bg-port-card border border-port-border rounded px-2 py-1 text-xs text-gray-300 focus:border-port-accent focus:outline-none"
      />
    </div>
  );
}

// Characters step — review the cast and generate a styled preview image per
// character so the world style + character style can be eyeballed together.
// Reuses the Universe Builder's exact render path via the shared
// `composeCanonStyledPrompt` helper + `useSingleImageRender` jobId lifecycle →
// EntryThumbSlot (spinner → image), and persists the resulting filename onto
// the universe canon entry's imageRefs.
function StepCharacters({ session, universe, locked, onChanged, onUniverseCharRef, onUniverseUpdate }) {
  const cast = universe?.characters || [];
  // Universe canon renders, so they resolve the universe's pin ladder (see renderPinLadder).
  const { imageCfg } = useImageRenderSettings({ record: universe, target: RENDER_TARGET.UNIVERSE_BIBLE });
  // Which character the in-flight refine targets rides on the RUN (`meta`), not
  // on local state — this panel unmounts when the user clicks another step on
  // the rail, and the run outlives it (#3905), so local state would come back
  // empty and the spinner would land on nobody.
  const { start: startRefine, busy: refineBusy, phase: refinePhase, meta: refineMeta } = useStoryStepRun('characters');
  const refiningId = refineMeta?.entryId || null;

  // Section-local renders now carry a durable `universeRun.entryRef` tag (#1362),
  // so the server-side `appendEntryImageRef` hook persists the filename onto the
  // character's `imageRefs[]` — the client no longer refetches + PATCHes (a
  // full-array `updateUniverse` could clobber a sibling's just-persisted ref
  // with a stale list). Just mirror the ref into the loaded universe draft
  // optimistically for an instant thumbnail.
  const onCharRendered = (filename, charId) => {
    if (!universe?.id || !filename) return;
    onUniverseCharRef?.(charId, filename);
  };

  // One render per character, keyed by char id. `buildPrompt(charId)` composes
  // the universe-styled prompt for that character; a blank description aborts
  // the render (the hook returns null) after toasting why. Reuses the canon
  // styled-render routine the Universe Builder's canon section renders through.
  const { renderingJobs, render: queueCharRender, handleComplete: onCharComplete } = useSingleImageRender({
    buildPrompt: (charId) => {
      const c = cast.find((x) => x.id === charId);
      if (!c) return null;
      const description = descriptorForCanonEntry('characters', c);
      if (!description.trim()) { toast.error(`Add a description for ${c.name} before generating a preview`); return null; }
      const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
      return composeCanonStyledPrompt({ name: c.name, description, universe, baseNegative: baseOpts.negativePrompt });
    },
    onComplete: onCharRendered,
    onError: (err) => toast.error(err?.message || 'Render failed'),
  });

  const renderChar = (c) => {
    // Tag the render so the server auto-files it onto the character's
    // `imageRefs[]` (#1362). `useSingleImageRender.render` merges the third arg
    // into the generate payload.
    const tag = buildUniverseSectionRenderTag(universe, 'characters', c);
    queueCharRender(imageCfg, c.id, tag ? { universeRun: tag } : undefined);
  };

  const refineChar = (entryId) => {
    if (refineBusy) return;
    startRefine('refine',
      () => refineStoryStep(session.id, 'characters', { entryId }, { silent: true }),
      { onComplete: (frame) => {
          toast.success(frame.changes?.length ? `Refined — ${frame.changes.length} change(s)` : 'Refined');
          onChanged();
        },
        onError: (err) => toast.error(err?.message || 'Refine failed') },
      { entryId });
  };

  return (
    <div className="space-y-3">
      {cast.length === 0 && (
        <p className="text-gray-600 italic text-sm">
          No characters yet. Add them in the <Link to={universe?.id ? `/universes/${universe.id}` : '/universes'} className="text-port-accent">Universe Builder</Link> or after generating the arc.
        </p>
      )}
      {cast.length > 0 && (
        <p className="text-xs text-gray-500">Generate a preview for each character to check the world style and character read correctly together.</p>
      )}
      {cast.map((c) => (
        <div key={c.id} className="bg-port-bg border border-port-border rounded p-2 flex items-start gap-3">
          <EntryThumbSlot
            imageRefs={c.imageRefs}
            inFlightJobId={renderingJobs[c.id] || null}
            onRender={() => renderChar(c)}
            onComplete={(fn) => onCharComplete(fn, c.id)}
            canRender={!locked && Boolean(universe?.id)}
            disabledHint={locked ? 'This story is locked' : 'Pick a universe to enable rendering'}
            alt={c.name}
          />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm">{c.name} {c.locked && <Lock className="w-3 h-3 inline text-port-success" />}</div>
            {!locked && universe?.id ? (
              <CharacterDescriptionField character={c} universeId={universe.id} onUniverseUpdate={onUniverseUpdate} />
            ) : (
              <div className="text-xs text-gray-400">{c.physicalDescription || (Array.isArray(c.descriptor) ? c.descriptor.map((d) => d.value).join(', ') : '')}</div>
            )}
          </div>
          {!locked && (
            <button
              onClick={() => refineChar(c.id)} disabled={refineBusy}
              className="text-xs inline-flex items-center gap-1 border border-port-border rounded px-2 py-1 hover:border-port-accent disabled:opacity-50 shrink-0 whitespace-nowrap"
            >
              {refiningId === c.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
              {refiningId === c.id ? (refinePhase || 'Refining…') : 'Refine'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function IssuesPanel({ session, series, issues, issuesState, issuesError, retryIssues, onChanged }) {
  const locks = session.steps?.issues?.issueLocks || {};
  const [busyId, setBusyId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const hasSeasons = Array.isArray(series?.seasons) && series.seasons.length > 0;

  const toggleIssue = async (issueId, next) => {
    setBusyId(issueId);
    const res = await setStoryIssueLock(session.id, issueId, next, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed'); return null; });
    setBusyId(null);
    if (res) { toast.success(next ? 'Issue marked done' : 'Issue reopened'); onChanged(); }
  };

  // Seed issues from the arc — generates a per-episode breakdown for every
  // season and persists one issue per episode, so the user never leaves the
  // builder. Provider/model is resolved server-side from the session picker.
  const generateIssues = async () => {
    setGenerating(true);
    const res = await generateStoryIssues(session.id, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Failed to generate issues'); return null; });
    setGenerating(false);
    if (!res) return;
    const created = res.createdIssues?.length || 0;
    const seasons = res.seasons || [];
    // Skipped = genuinely ineligible (locked / no synopsis); failed = a
    // transient provider/LLM error. Surface them separately so an infra
    // failure never reads as a config skip. Distinct reasons are deduped so a
    // multi-season batch shows every cause, not just the first.
    const skipped = seasons.filter((s) => s.skipped);
    const failed = seasons.filter((s) => s.failed);
    const reasons = (list) => [...new Set(list.map((s) => s.reason).filter(Boolean))].join('; ');
    const noun = (n) => (n === 1 ? 'season' : 'seasons');
    if (created > 0) {
      toast.success(`Created ${created} issue${created === 1 ? '' : 's'} from the arc`);
      // A skipped season is an expected config state (locked / no synopsis) —
      // warn (yellow), don't error (red). A failed season is a real error.
      if (skipped.length) toast.warning(`Skipped ${skipped.length} ${noun(skipped.length)}: ${reasons(skipped)}`);
      if (failed.length) toast.error(`Couldn't generate ${failed.length} ${noun(failed.length)}: ${reasons(failed)}`);
    } else if (failed.length) {
      toast.error(`Couldn't generate issues — ${reasons(failed) || 'a provider error occurred'}`);
    } else if (skipped.length) {
      toast.warning(`No issues created — ${reasons(skipped)}`);
    } else {
      toast.error('No issues were generated');
    }
    onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-gray-400">Complete issues one at a time. Lock issue #1 before moving to #2.</p>
        <div className="flex items-center gap-3">
          {hasSeasons && (
            <button
              onClick={generateIssues} disabled={generating}
              title="Generate a per-episode breakdown for every season and create the issues here"
              className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Generate issues from arc
            </button>
          )}
          {series?.id && (
            <Link to={`/pipeline/series/${series.id}`} className="text-sm text-port-accent inline-flex items-center gap-1">
              Plan issues in Pipeline <ExternalLink className="w-4 h-4" />
            </Link>
          )}
        </div>
      </div>
      {issuesState === 'error' ? (
        <ListLoadError what="pipeline issues" error={issuesError} onRetry={retryIssues} />
      ) : null}
      {issuesState === 'ready' && issues.length === 0 && (
        <p className="text-gray-600 italic text-sm">
          {hasSeasons
            ? 'No issues yet — “Generate issues from arc” seeds one issue per episode for each season, or plan them in the Pipeline.'
            : 'No issues yet — generate seasons on the plot-arc step first, then seed issues from the arc.'}
        </p>
      )}
      {(issues || []).map((i) => {
        const isLocked = locks[i.id]?.locked;
        return (
          <div key={i.id} className="flex items-center justify-between bg-port-bg border border-port-border rounded px-3 py-2">
            <div className="flex items-center gap-2">
              {isLocked ? <Check className="w-4 h-4 text-port-success" /> : <span className="w-4 h-4" />}
              <span className="text-sm">#{i.number} {i.title}</span>
              <span className="text-xs text-gray-500">{i.status}</span>
            </div>
            <div className="flex items-center gap-2">
              <Link to={`/pipeline/issues/${i.id}/idea`} className="text-xs text-gray-400 hover:text-port-accent inline-flex items-center gap-1">
                Open <ExternalLink className="w-3 h-3" />
              </Link>
              <button
                onClick={() => toggleIssue(i.id, !isLocked)} disabled={busyId === i.id}
                className={`text-xs inline-flex items-center gap-1 border rounded px-2 py-1 disabled:opacity-50 ${isLocked ? 'border-port-success text-port-success' : 'border-port-border hover:border-port-accent'}`}
              >
                {busyId === i.id ? <Loader2 className="w-3 h-3 animate-spin" /> : (isLocked ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />)}
                {isLocked ? 'Reopen' : 'Mark done'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function StepPanel({
  session, universe, series, issues, issuesState, issuesError, retryIssues,
  stepId, locked, onChanged, onSeriesUpdate, onIssuesUpdate, onFlushPending,
  onRegisterDraftFlush, onUniverseCharRef, onSessionFields, onUniverseUpdate,
}) {
  const { start, busy, phase, op } = useStoryStepRun(stepId);
  const arc = series?.arc || {};
  const isRunning = (which) => busy && op === which;

  // True when at least one issue already carries text content — the prerequisite
  // for backfilling an upstream step (idea / arc) FROM the downstream work.
  const issuesHaveContent = useMemo(() => (issues || []).some((iss) => {
    const st = iss.stages || {};
    return ['comicScript', 'teleplay', 'prose', 'idea']
      .some((sid) => (st[sid]?.input?.trim() || st[sid]?.output?.trim()));
  }), [issues]);

  const runGenerate = () => start('generate',
    () => generateStoryStep(session.id, stepId, {}, { silent: true }),
    { onComplete: () => { toast.success('Generated'); onChanged(); },
      onError: (err) => toast.error(err?.message || 'Generation failed') });

  // Backfill: synthesize this upstream step from the series' existing issue
  // content instead of from its conventional upstream (start-from-anywhere).
  const runBackfill = () => start('backfill',
    () => generateStoryStep(session.id, stepId, { fromDownstream: true }, { silent: true }),
    { onComplete: () => { toast.success('Backfilled from existing issues'); onChanged(); },
      onError: (err) => toast.error(err?.message || 'Backfill failed') });

  const backfillButton = () => (
    <button
      onClick={runBackfill} disabled={busy || locked}
      title="Reverse-engineer this step from the scripts / prose your issues already have"
      className="inline-flex items-center gap-2 bg-port-card border border-port-border hover:border-port-accent disabled:opacity-50 px-3 py-1.5 rounded text-sm"
    >
      {isRunning('backfill') ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
      {isRunning('backfill') ? (phase || 'Working…') : 'Backfill from existing issues'}
    </button>
  );
  const runRefine = (feedback, entryId) => start('refine',
    () => refineStoryStep(session.id, stepId, { feedback, entryId }, { silent: true }),
    { onComplete: (frame) => {
        toast.success(frame.changes?.length ? `Refined — ${frame.changes.length} change(s)` : 'Refined');
        onChanged();
      },
      onError: (err) => toast.error(err?.message || 'Refine failed') });

  // Once a step has generated content, the button becomes "Re-generate" (with a
  // refresh icon) so it's clear it has already been run. While running, the
  // button surfaces the live SSE phase ("Planning the plot arc…").
  const genButton = (label = 'Generate with AI', hasContent = false) => (
    <button
      onClick={runGenerate} disabled={busy || locked}
      className="inline-flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-3 py-1.5 rounded text-sm"
    >
      {isRunning('generate') ? <Loader2 className="w-4 h-4 animate-spin" /> : (hasContent ? <RefreshCw className="w-4 h-4" /> : <Sparkles className="w-4 h-4" />)}
      {isRunning('generate') ? (phase || 'Working…') : (hasContent ? 'Re-generate' : label)}
    </button>
  );

  // Inline edits write straight to the owning record (no AI call) and fold the
  // server's answer into local state. A rejected write toasts and leaves the
  // persisted value showing, so the field visibly snaps back.
  const commitSession = (key) => async (text) => {
    const next = text.trim();
    if (key === 'title' && !next) { toast.error('Title cannot be empty'); return; }
    const updated = await updateStorySession(session.id, { [key]: next }, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Save failed'); return null; });
    if (updated) onSessionFields?.({ [key]: updated[key] ?? next });
  };
  const saveUniverse = async (patch) => {
    if (!universe?.id) return;
    const updated = await updateUniverse(universe.id, patch, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Save failed'); return null; });
    if (updated) onUniverseUpdate?.(updated);
  };
  const commitInfluences = (key) => (text) => saveUniverse({
    influences: { embrace: universe?.influences?.embrace || [], avoid: universe?.influences?.avoid || [], [key]: splitList(text) },
  });

  const editUniverse = !locked && universe?.id ? true : undefined;

  if (stepId === 'idea') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Working title" value={session.title} singleLine onCommit={locked ? undefined : commitSession('title')} />
        <FieldBlock label="Starter idea" value={session.seedIdea} onCommit={locked ? undefined : commitSession('seedIdea')} />
        <div className="flex items-center gap-2 flex-wrap">
          {!locked && genButton('Expand idea with AI', Boolean((universe?.logline || '').trim()))}
          {!locked && issuesHaveContent && backfillButton()}
        </div>
        <p className="text-xs text-gray-500">
          Expanding seeds the universe starter prompt and series premise for the next steps.
          {issuesHaveContent && ' Already drafted issues? Backfill reverse-engineers the idea from their content.'}
        </p>
      </div>
    );
  }
  if (stepId === 'universeAesthetic') {
    return (
      <div className="space-y-3">
        <FieldBlock label="Logline" value={universe?.logline} onCommit={editUniverse && ((t) => saveUniverse({ logline: t.trim() }))} />
        <FieldBlock label="Premise" value={universe?.premise} onCommit={editUniverse && ((t) => saveUniverse({ premise: t.trim() }))} />
        <FieldBlock label="Style notes" value={universe?.styleNotes} onCommit={editUniverse && ((t) => saveUniverse({ styleNotes: t.trim() }))} />
        <FieldBlock label="Influences — embrace" value={(universe?.influences?.embrace || []).join(', ')} singleLine onCommit={editUniverse && commitInfluences('embrace')} />
        <FieldBlock label="Influences — avoid" value={(universe?.influences?.avoid || []).join(', ')} singleLine onCommit={editUniverse && commitInfluences('avoid')} />
        <div className="border-t border-port-border pt-3">
          {/* No `key` remount — `useSingleImageRender` scopes the probe per
              universe via `scopeId`, so the in-flight render/completion follows
              the displayed universe without a settings refetch on each switch. */}
          <StyleProbeImage universe={universe} onUniverseChange={() => onChanged()} canRender={!locked} />
        </div>
        <div className="flex items-center gap-2">
          {!locked && genButton('Expand aesthetic', Boolean((universe?.premise || universe?.styleNotes || '').trim()))}
          {universe?.id && (
            <Link to={`/universes/${universe.id}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-port-accent">
              <ExternalLink className="w-4 h-4" /> Deep-edit in Universe Builder
            </Link>
          )}
        </div>
        {!locked && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />}
      </div>
    );
  }
  if (stepId === 'plotArc') {
    const hasArc = Boolean((arc.logline || arc.summary || '').trim());
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {!locked && genButton('Generate plot arc', hasArc)}
          {!locked && issuesHaveContent && backfillButton()}
          {series?.id && (
            <Link to={`/pipeline/series/${series.id}`} className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-port-accent">
              <ExternalLink className="w-4 h-4" /> Open the full Arc Canvas page
            </Link>
          )}
        </div>
        {issuesHaveContent && !hasArc && (
          <p className="text-xs text-gray-500">Started from drafted issues? Backfill extracts the arc from their scripts / prose.</p>
        )}
        {/* Embed the Arc Canvas inline once an arc exists AND the step is
            unlocked, so the logline / summary / protagonist arc / themes /
            Vonnegut shape AND the season roadmap are editable in-builder instead
            of read-only field blocks + a deep-link. The arc step is the right
            home for the whole-roadmap editor: it owns series.arc. We show the
            read-only field summary when there's no arc yet (ArcCanvas has
            nothing to render) OR when the step is LOCKED — ArcCanvas has no
            read-only mode and could otherwise edit (or internally unlock) a
            locked arc, bypassing the builder's "Unlock to revise" lock workflow.
            The deep-link below covers intentional editing of a locked arc. The
            `@container` wrapper activates ArcCanvas's `@5xl:` two-column layout. */}
        {hasArc && !locked ? (
          <div className="@container">
            <ArcCanvas
              series={series}
              issues={issues}
              onSeriesUpdate={onSeriesUpdate}
              onIssuesUpdate={onIssuesUpdate}
              onFlushPending={onFlushPending}
              onRegisterDraftFlush={onRegisterDraftFlush}
            />
          </div>
        ) : (
          <>
            <FieldBlock label="Arc logline" value={arc.logline} />
            <FieldBlock label="Arc summary" value={arc.summary} />
            <FieldBlock label="Protagonist arc" value={arc.protagonistArc} />
            <FieldBlock label="Themes" value={(arc.themes || []).join(', ')} />
            <FieldBlock label="Emotional shape (Vonnegut)" value={arc.shape} />
          </>
        )}
        {!locked && hasArc && (
          <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />
        )}
      </div>
    );
  }
  if (stepId === 'readerMap') {
    return (
      <div className="space-y-3">
        <ReaderMapBeatTimeline readerMap={arc.readerMap} />
        <ReaderMapView readerMap={arc.readerMap} tickingClock={arc.tickingClock} />
        {!locked && genButton('Generate reader map', Boolean(arc.readerMap))}
        {!locked && arc.readerMap && <RefineBox onRefine={(fb) => runRefine(fb)} busy={busy} running={isRunning('refine')} phase={phase} />}
      </div>
    );
  }
  if (stepId === 'characters') {
    return <StepCharacters session={session} universe={universe} locked={locked} onChanged={onChanged} onUniverseCharRef={onUniverseCharRef} onUniverseUpdate={onUniverseUpdate} />;
  }
  if (stepId === 'issues') {
    return <IssuesPanel session={session} series={series} issues={issues} issuesState={issuesState} issuesError={issuesError} retryIssues={retryIssues} onChanged={onChanged} />;
  }
  if (stepId === 'production') {
    const locks = session.steps?.issues?.issueLocks || {};
    const done = (issues || []).filter((i) => locks[i.id]?.locked);
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-400">Render each completed issue. Production happens on the Pipeline issue page.</p>
        {done.length === 0 && <p className="text-gray-600 italic text-sm">Lock at least one issue on the previous step first.</p>}
        {done.map((i) => (
          <div key={i.id} className="flex items-center justify-between bg-port-bg border border-port-border rounded px-3 py-2">
            <span className="text-sm">#{i.number} {i.title}</span>
            <Link to={`/pipeline/issues/${i.id}/storyboards`} className="text-sm text-port-accent inline-flex items-center gap-1">
              Open production <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        ))}
      </div>
    );
  }
  return null;
}
