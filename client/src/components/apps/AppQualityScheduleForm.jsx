import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { WEEKDAYS } from '../../utils/cronHelpers';
import { applyAppQualitySchedule, getAppQualitySchedule, previewAppQualitySchedule } from '../../services/apiApps';
import FormField from '../ui/FormField';
import toast from '../ui/Toast';

// The planner lays the week out Monday-first, so the preview reads in the same
// order; WEEKDAYS itself is cron's Sunday-first numbering.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const hourLabel = hour => `${String(hour).padStart(2, '0')}:00`;

// Display copy for the drain types the server offers. An id with no entry here
// still renders — as itself — so adding a drain type server-side is not a
// broken option in the browser.
const CLAIM_TASK_LABELS = {
  'claim-work': 'Claim work (routes to this app’s tracker)',
  'claim-issue': 'Claim issue (GitHub/GitLab)',
  'plan-task': 'Plan task (PLAN.md)',
};

// How long an edited control sits still before the form asks for a new plan.
// The planner is read-only, but each preview is a repository scan and a
// database read, and walking a 24-option hour select fires a change per step.
const PREVIEW_DEBOUNCE_MS = 300;

const selectClass = 'block w-full bg-port-bg border border-port-border rounded p-2';

/**
 * Schedule every applicable quality check for one app in a single form.
 *
 * The user picks WHAT (which checks, filing issues or implementing fixes) and
 * roughly HOW OFTEN; the server picks the actual hours, spreading the checks
 * across all seven days and keeping them out of the windows the app's other
 * scheduled jobs already occupy. Nothing is written until Apply.
 */
export default function AppQualityScheduleForm({ app }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [modes, setModes] = useState({});
  const [options, setOptions] = useState(null);
  // The initial GET already carries the plan for the untouched form, so the
  // first run of the preview effect has nothing to ask for.
  const untouched = useRef(true);
  // Only a preview issued after the newest edit may land; an older in-flight
  // one would repaint the grid with a plan the form no longer describes.
  const revision = useRef(0);

  useEffect(() => {
    let live = true;
    getAppQualitySchedule(app.id)
      .then(response => {
        if (!live) return;
        setData(response);
        setSelected(response.plan.slots.map(slot => slot.taskType));
        setModes(Object.fromEntries(response.plan.slots.map(slot => [slot.taskType, slot.fileIssues])));
        setOptions(response.plan.options);
      })
      .catch(err => live && setError(err.message || 'Could not load the quality schedule'));
    return () => { live = false; };
  }, [app.id]);

  // `options` always comes from the server's own resolved bag, so every field
  // the schema accepts is already present — no client-side default ladder.
  const body = useCallback(() => ({ taskTypes: selected || [], fileIssuesByType: modes, ...options }), [selected, modes, options]);

  // Re-plan after the form settles. The endpoint writes nothing, so the only
  // cost of an extra round trip is the scan behind it — which the debounce and
  // the untouched-first-render guard are there to avoid paying needlessly.
  useEffect(() => {
    if (!selected || !options) return undefined;
    if (untouched.current) { untouched.current = false; return undefined; }
    const mine = ++revision.current;
    const timer = setTimeout(() => {
      previewAppQualitySchedule(app.id, body())
        .then(response => { if (mine === revision.current) { setData(response); setError(''); } })
        .catch(err => { if (mine === revision.current) setError(err.message || 'Could not re-plan the schedule'); });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `data` is deliberately NOT a dependency — this effect writes it, so
    // depending on it would re-plan forever. `body` closes over every field the
    // plan actually reads.
  }, [app.id, selected, options, body]);

  const apply = async () => {
    setBusy(true);
    const result = await applyAppQualitySchedule(app.id, body()).catch(err => ({ failure: err }));
    setBusy(false);
    if (result?.failure) return toast.error(result.failure.message || 'Could not save the quality schedule');
    setData(result);
    toast.success(`Scheduled ${result.plan.slots.length} quality checks across the week`);
  };

  if (error && !data) return <section aria-label="Weekly quality schedule" className="border-t border-port-border pt-3">
    <h4 className="font-medium">Weekly quality schedule</h4>
    <p role="alert" className="text-sm text-port-error">{error}</p>
  </section>;
  if (!data || !selected || !options) return <p className="text-sm text-gray-400" role="status">Loading the weekly quality schedule…</p>;

  const { plan, checks, capabilities, scanned, busySources, claimTaskTypes = [] } = data;
  const toggle = taskType => setSelected(previous => previous.includes(taskType)
    ? previous.filter(type => type !== taskType)
    : [...previous, taskType]);
  const setOption = (key, value) => setOptions(previous => ({ ...previous, [key]: value }));
  const setMode = (taskType, fileIssues) => setModes(previous => ({ ...previous, [taskType]: fileIssues }));
  const applicable = checks.filter(check => check.applicable);
  const skipped = checks.filter(check => !check.applicable);
  const byDay = WEEK_ORDER.map(day => ({ day, slots: plan.slots.filter(slot => slot.day === day) })).filter(entry => entry.slots.length);

  return (
    <section aria-label="Weekly quality schedule" className="border-t border-port-border pt-3 space-y-3">
      <h4 className="font-medium">Weekly quality schedule</h4>
      <p className="text-xs text-gray-400">
        Spreads the selected checks across all seven days and picks the hours itself, avoiding the windows this app’s other
        scheduled jobs already run in. {applicable.length} of {checks.length} checks apply to this repository
        {scanned > 0 ? '' : ' (repository could not be scanned, so every check is offered)'}
        {skipped.length > 0 && `; ${skipped.length} skipped`}. Nothing is saved until you press Apply.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
        <FormField label="Checks per day">
          <select className={selectClass} value={options.checksPerDay ?? ''} disabled={busy}
            onChange={event => setOption('checksPerDay', event.target.value === '' ? null : Number(event.target.value))}>
            <option value="">Spread evenly over the week</option>
            {[1, 2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count} per day</option>)}
          </select>
        </FormField>
        <FormField label="Earliest hour">
          <select className={selectClass} value={options.windowStartHour} disabled={busy}
            onChange={event => setOption('windowStartHour', Number(event.target.value))}>
            {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
          </select>
        </FormField>
        <FormField label="Latest hour">
          <select className={selectClass} value={options.windowEndHour} disabled={busy}
            onChange={event => setOption('windowEndHour', Number(event.target.value))}>
            {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
          </select>
        </FormField>
        <FormField label="Default delivery">
          {/* Changing the form-wide default clears the per-check overrides —
              otherwise a row the user never touched would keep the old mode. */}
          <select className={selectClass} value={options.fileIssues === false ? 'fix' : 'file'} disabled={busy}
            onChange={event => { setModes({}); setOption('fileIssues', event.target.value === 'file'); }}>
            <option value="file">Plan and file issues</option>
            <option value="fix">Implement the fix</option>
          </select>
        </FormField>
        <FormField label="Between checks">
          <select className={selectClass} value={options.claimBetween === false ? '' : options.claimTaskType} disabled={busy}
            onChange={event => setOptions(previous => ({
              ...previous,
              claimBetween: event.target.value !== '',
              ...(event.target.value && { claimTaskType: event.target.value }),
            }))}>
            <option value="">Do not run a claim job</option>
            {claimTaskTypes.map(taskType => (
              <option key={taskType} value={taskType}>{CLAIM_TASK_LABELS[taskType] || taskType}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Claim job starts">
          <select className={selectClass} value={options.claimOffsetHours} disabled={busy || options.claimBetween === false}
            onChange={event => setOption('claimOffsetHours', Number(event.target.value))}>
            {[1, 2, 3, 4, 5, 6, 8, 12].map(hours => <option key={hours} value={hours}>{hours}h after each check</option>)}
          </select>
        </FormField>
      </div>

      {plan.warnings.map(warning => <p key={warning} className="text-xs text-port-warning">{warning}</p>)}
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}

      <details className="text-xs text-gray-400">
        <summary className="cursor-pointer text-port-accent">Checks ({selected.length} of {checks.length} selected)</summary>
        <ul className="mt-2 space-y-1">{checks.map(check => (
          <li key={check.taskType} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <input type="checkbox" id={`quality-check-${check.taskType}`} className="accent-port-accent" disabled={busy}
              checked={selected.includes(check.taskType)} onChange={() => toggle(check.taskType)} />
            <label htmlFor={`quality-check-${check.taskType}`} className={check.applicable ? 'text-gray-200' : 'text-gray-500'}>
              {check.label}
            </label>
            {selected.includes(check.taskType) && (
              <select aria-label={`${check.label} delivery`} className="bg-port-bg border border-port-border rounded px-1 py-0.5" disabled={busy}
                value={(modes[check.taskType] ?? options.fileIssues !== false) ? 'file' : 'fix'}
                onChange={event => setMode(check.taskType, event.target.value === 'file')}>
                <option value="file">file issues</option>
                <option value="fix">implement</option>
              </select>
            )}
            {check.reason && <span className="text-gray-500">— {check.reason}</span>}
          </li>
        ))}</ul>
        {scanned > 0 && <p className="mt-2">
          Detected in this repository: {Object.entries(capabilities).filter(([, present]) => present).map(([name]) => name).join(', ') || 'none'} ({scanned} tracked files scanned).
        </p>}
      </details>

      {!!busySources.length && <details className="text-xs text-gray-400">
        <summary className="cursor-pointer text-port-accent">Planned around {busySources.length} existing job{busySources.length === 1 ? '' : 's'}</summary>
        <ul className="mt-1">{busySources.map(source => (
          <li key={`${source.taskType}-${source.origin}-${source.cron}`}>{source.taskType} · <code>{source.cron}</code></li>
        ))}</ul>
      </details>}

      {!!byDay.length && <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <caption className="sr-only">Planned weekly quality schedule</caption>
          <thead className="text-gray-400"><tr><th className="py-1 pr-3">Day</th><th className="py-1 pr-3">Checks</th></tr></thead>
          <tbody>{byDay.map(({ day, slots }) => (
            <tr key={day} className="border-t border-port-border align-top">
              <th scope="row" className="py-1.5 pr-3 font-medium whitespace-nowrap">{WEEKDAYS[day].label}</th>
              <td className="py-1.5 pr-3">{slots.map(slot => (
                <span key={slot.taskType} className="inline-block mr-3 whitespace-nowrap">
                  <span className="text-gray-400">{hourLabel(slot.hour)}</span> {slot.label}
                  <span className="text-gray-500"> ({slot.fileIssues ? 'issues' : 'fix'})</span>
                </span>
              ))}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>}

      {plan.claim && <p className="text-xs text-gray-400">
        <code>{plan.claim.taskType}</code> drains the backlog daily at {plan.claim.hours.map(hourLabel).join(', ')} — {options.claimOffsetHours}h after each check, so the issues an audit files get worked before the next one runs.
      </p>}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={apply} disabled={busy || !plan.slots.length}
          className="px-3 py-2 rounded bg-port-accent text-port-bg text-sm font-medium disabled:opacity-50">
          {busy ? 'Applying…' : `Apply schedule (${plan.slots.length} check${plan.slots.length === 1 ? '' : 's'}${plan.claim ? ' + claim job' : ''})`}
        </button>
        <Link to="/cos/schedule" className="text-xs text-port-accent hover:underline">Review on the Schedule page</Link>
      </div>
      <p className="text-xs text-gray-500">
        Applying enables the selected checks on this app with the planned cron expressions and DISABLES the ones you left out.
        Other task types are untouched, and every entry stays editable on the Schedule page afterwards.
      </p>
    </section>
  );
}
