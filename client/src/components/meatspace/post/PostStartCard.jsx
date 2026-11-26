import { Link } from 'react-router';
import { ArrowRight, ChevronRight, Compass, Dumbbell, Layers, Play, Target, Timer, Zap } from 'lucide-react';
import { FormField } from '../../ui/FormField';
import { QUICK_DURATION_MINUTES } from '../../../lib/postQuickSession.js';
import { DOMAINS, DRILL_LABELS } from './constants';
import { buildCleanConditions } from './postLauncherBuilders';
import { CONDITION_SELECT_FIELDS } from './postLauncherConditions';

export default function PostStartCard({
  primaryAction, compositionExcludesAll, domainCount, quickPlan,
  quickDurationMin, quickDurationSaveState, handleQuickDurationChange,
  handleQuickSession, hasSessionDrills, handleStart, mode, setMode,
  benchmarkState, benchmarkError, handleBenchmarkSession,
  conditions, setConditions, showConditions, setShowConditions,
}) {
  // Count of condition fields filled in, surfaced on the collapsed disclosure so
  // entered values aren't invisible once it's closed. Reuses the same
  // sanitizer the submit path uses, so "filled in" can't drift from "actually
  // sent".
  const filledConditionCount = Object.keys(buildCleanConditions(conditions)).length;

  // The CTA renders as a <Link> for a routed rec and a <button> for an in-page
  // start, but is otherwise identical — so build the shared parts once. A
  // navigation gets the Compass icon; a session start gets the mode's own icon.
  const PrimaryIcon = primaryAction?.to ? Compass : (mode === 'train' ? Dumbbell : Play);
  const primaryCtaClass = `w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
    mode === 'train' && !primaryAction?.to
      ? 'bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2'
      : 'bg-port-accent hover:bg-port-accent/80 text-white'
  }`;
  const primaryCtaInner = primaryAction && (
    <>
      <PrimaryIcon size={18} className="shrink-0" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block font-medium truncate">{primaryAction.label}</span>
        {primaryAction.detail && <span className="block text-xs opacity-75 truncate">{primaryAction.detail}</span>}
      </span>
      <ArrowRight size={16} className="shrink-0" />
    </>
  );

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      {/* Composition-excludes-everything notice — the start buttons are
          disabled because Session Composition filtered out all enabled drills. */}
      {compositionExcludesAll && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-port-warning/10 border border-port-warning/30 text-sm text-port-warning">
          <Layers size={16} className="mt-0.5 shrink-0" />
          <span>Your Session Composition excludes every enabled drill — adjust it under Config → Session Composition to run a session.</span>
        </div>
      )}

      {/* Recommended next action — dispatches the top "Up next" rec through
          the SAME resolver the rec rows use, so the two can't diverge. */}
      {primaryAction && (
        primaryAction.to ? (
          <Link to={primaryAction.to} className={primaryCtaClass}>{primaryCtaInner}</Link>
        ) : (
          <button type="button" onClick={primaryAction.onClick} className={primaryCtaClass}>{primaryCtaInner}</button>
        )
      )}

      {/* Standard sessions */}
      {domainCount >= 2 && (
        <div className="bg-port-bg/50 border border-port-border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <label htmlFor="post-quick-duration" className="text-sm text-gray-300">Quick session budget</label>
            <select
              id="post-quick-duration"
              aria-label="Quick session duration"
              value={quickDurationMin}
              onChange={handleQuickDurationChange}
              className="bg-port-card border border-port-border rounded px-2 py-1 text-sm text-white"
            >
              {QUICK_DURATION_MINUTES.map(minutes => (
                <option key={minutes} value={minutes}>{minutes} minutes</option>
              ))}
            </select>
          </div>
          <div className="text-xs text-gray-400" aria-label="Quick session preview">
            <div>
              Preview: {quickPlan.selected.map(candidate => candidate.reviewLabel || DRILL_LABELS[candidate.type] || candidate.type).join(' · ') || 'No drills fit this budget'}
            </div>
            <div>
              Estimated {Math.ceil(quickPlan.estimatedDurationSec / 60)} min of {quickDurationMin} min target.
            </div>
            {quickPlan.omittedDomains.length > 0 && (
              <div>Omitted domains: {quickPlan.omittedDomains.map(domain => DOMAINS[domain]?.label || domain).join(', ')}.</div>
            )}
            {quickPlan.omittedReviews.length > 0 && (
              <div>Omitted maintenance reviews: {quickPlan.omittedReviews.join(', ')}.</div>
            )}
            {quickDurationSaveState === 'saving' && <div>Saving budget...</div>}
            {quickDurationSaveState === 'saved' && <div>Budget saved.</div>}
            {quickDurationSaveState === 'error' && <div role="alert" className="text-port-error">Budget could not be saved; reverted.</div>}
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-3">
        {domainCount >= 2 && (
          <button
            onClick={handleQuickSession}
            disabled={!quickPlan.selected.length}
            className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
              mode === 'train'
                ? 'bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2'
                : 'bg-port-success hover:bg-port-success/80 text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors`}
          >
            <Timer size={18} />
            Quick {quickDurationMin} Min ({domainCount} domains)
          </button>
        )}
        <button
          onClick={handleStart}
          disabled={!hasSessionDrills}
          className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
            mode === 'train'
              ? 'bg-port-accent-2/70 hover:bg-port-accent-2/80 text-port-on-accent-2'
              : 'bg-port-accent hover:bg-port-accent/80 text-white'
          } disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors`}
        >
          {mode === 'train' ? <Dumbbell size={18} /> : <Play size={18} />}
          {mode === 'train' ? 'Full Training' : 'Full POST'}
        </button>
      </div>

      {mode === 'test' && (
        <div className="border-t border-port-border pt-3 space-y-2">
          <button
            type="button"
            onClick={handleBenchmarkSession}
            disabled={benchmarkState === 'loading'}
            className="w-full flex items-center justify-center gap-2 px-6 py-2.5 bg-port-card border border-port-accent text-port-accent hover:bg-port-accent/10 disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors"
          >
            <Target size={17} />
            {benchmarkState === 'loading' ? 'Loading Benchmark...' : 'Fixed Benchmark POST'}
          </button>
          <p className="text-xs text-gray-500">
            Versioned two-drill battery with alternating forms for comparable progress.
          </p>
          {benchmarkError && <p role="alert" className="text-xs text-port-error">{benchmarkError}</p>}
        </div>
      )}

      {/* Mode toggle — compact, on the same card as the starts it governs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode('test')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'test'
              ? 'bg-port-accent text-white'
              : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
          }`}
        >
          <Zap size={14} />
          Test
        </button>
        <button
          onClick={() => setMode('train')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            mode === 'train'
              ? 'bg-port-accent-2 text-port-on-accent-2'
              : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
          }`}
        >
          <Dumbbell size={14} />
          Train
        </button>
      </div>
      <p className="text-xs text-gray-500">
        {mode === 'train'
          ? 'Training mode: immediate feedback, hints on wrong answers. Not scored.'
          : 'Test mode: timed drills with scoring. Saved to history.'}
      </p>

      {/* Conditions — optional session metadata, collapsed by default so it
          can't push the start buttons below the fold. Values are held in
          `conditions` above, so collapsing never discards what was set.
          Fixed enums (issue #4442) instead of free text so values are
          filterable/comparable across sessions. */}
      {mode === 'test' && (
        <div className="border-t border-port-border pt-3">
          <button
            type="button"
            onClick={() => setShowConditions(v => !v)}
            aria-expanded={showConditions}
            className="w-full flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <ChevronRight size={14} className={`transition-transform ${showConditions ? 'rotate-90' : ''}`} />
            Conditions (optional)
            {!showConditions && filledConditionCount > 0 && (
              <span className="text-port-accent">· {filledConditionCount} set</span>
            )}
          </button>
          {showConditions && (
            <div className="grid grid-cols-3 gap-3 mt-3">
              {CONDITION_SELECT_FIELDS.map(({ key, label, options }) => (
                <FormField key={key} labelClassName="text-xs text-gray-500 mb-1 block" label={label}>
                  <select
                    value={conditions[key]}
                    onChange={e => setConditions(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none capitalize"
                  >
                    <option value="">—</option>
                    {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                </FormField>
              ))}
              <FormField className="col-span-3" labelClassName="text-xs text-gray-500 mb-1 block" label="Note">
                <input
                  type="text"
                  value={conditions.note}
                  onChange={e => setConditions(prev => ({ ...prev, note: e.target.value }))}
                  placeholder="Anything else worth remembering about this session"
                  maxLength={500}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
                />
              </FormField>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
