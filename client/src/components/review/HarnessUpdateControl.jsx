import { useEffect, useRef, useState } from 'react';
import { getHarnessUpdateReference } from '../../services/api';
import { timeAgo } from '../../utils/formatters';

const DAY_MS = 24 * 60 * 60 * 1000;

function AdvisoryList({ title, result, fixed = [] }) {
  if (!result || result.state === 'unknown') return <p>{title}: advisory check unavailable.</p>;
  if (!result.items?.length) return <p>{title}: {result.state === 'checked' ? 'no matching GitHub-reviewed direct-package advisories found.' : 'advisory check incomplete.'}</p>;
  return <div>
    <p>{title}{result.state === 'partial' ? ' (incomplete check)' : ''}:</p>
    <ul className="list-disc pl-5">
      {result.items.map(item => <li key={item.id}>
        <a className="text-port-accent hover:underline" href={item.url} target="_blank" rel="noreferrer">{item.cve || item.id}</a>
        {' '}({item.severity}){fixed.includes(item.id) ? ' — GitHub identifies the npm candidate as the first patched version' : ''}
      </li>)}
    </ul>
  </div>;
}

export default function HarnessUpdateControl({ harness, warningDays, onWarningDays, onUpdate, disabled = false }) {
  const [reference, setReference] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (wasDisabled.current && !disabled) setAttempt(value => value + 1);
    wasDisabled.current = disabled;
  }, [disabled]);
  useEffect(() => {
    let active = true;
    setReference(null);
    setConfirming(false);
    getHarnessUpdateReference(harness.id, { silent: true, hostControlOptional: true })
      .then(value => { if (active) setReference(value); })
      .catch(error => { if (active) setReference({ state: error?.code === 'HOST_CONTROL_FORBIDDEN' ? 'host-control-required' : 'unknown' }); });
    return () => { active = false; };
  }, [harness.id, harness.installedVersion, harness.candidateVersion, attempt]);

  const valid = reference?.state === 'available' && reference.installedVersion === harness.installedVersion
    && reference.candidateVersion === harness.candidateVersion;
  const published = valid && reference.release?.state === 'verified' ? Date.parse(reference.release.publishedAt) : NaN;
  const young = warningDays > 0 && Number.isFinite(published) && Date.now() - published < warningDays * DAY_MS;
  const ageUnknown = warningDays > 0 && !Number.isFinite(published);
  const changed = reference?.state === 'changed';
  return <div className="w-full space-y-2 text-xs text-gray-400">
    {!reference && <p>Loading npm release and GitHub advisories…</p>}
    {reference && !valid && <p>{reference.state === 'host-control-required'
      ? 'Host control is required to review or update this harness.'
      : `Release and advisory details could not be verified${changed ? '; refresh the update card' : ''}.`}</p>}
    {reference?.unsupported && <p>Protected inline updates are not available on this platform.</p>}
    {reference && <button type="button" onClick={() => setAttempt(value => value + 1)} disabled={disabled}
      className="rounded border border-port-border px-3 py-2">Recheck update</button>}
    {valid && <>
      <p>npm reference: {reference.package} {reference.candidateVersion} — {Number.isFinite(published) ? `published ${timeAgo(reference.release.publishedAt)}` : 'publication date unknown'}.</p>
      {reference.checkedAt && <p>Reference last checked {timeAgo(reference.checkedAt)}.</p>}
      {reference.release?.state === 'incomparable' && <p>The public npm latest differs from the configured registry’s candidate; its age is unverified here.</p>}
      <AdvisoryList title={`npm reference at observed CLI version ${reference.installedVersion}`} result={reference.installed} fixed={reference.fixed} />
      <AdvisoryList title={`npm candidate ${reference.candidateVersion}`} result={reference.candidate} />
      <p>GitHub results cover reviewed direct-package advisories only. The installed binary’s source and bundled dependencies are not verified; the vendor updater may choose a different release.</p>
    </>}
    <label className="flex flex-wrap items-center gap-2">
      Warn about recent npm releases in this browser
      <select aria-label={`Recent release warning for ${harness.label}`} value={warningDays} onChange={event => onWarningDays(Number(event.target.value))}
        className="rounded border border-port-border bg-port-bg px-2 py-1 text-gray-300">
        <option value={0}>Off</option><option value={1}>Under 1 day</option><option value={3}>Under 3 days</option><option value={7}>Under 7 days</option>
      </select>
    </label>
    {!confirming ? <button type="button" onClick={() => setConfirming(true)} disabled={disabled || !reference?.ticket || changed}
      className="rounded border border-port-accent/30 px-3 py-2 text-port-accent disabled:opacity-40">Update {harness.label}</button> : <div className="space-y-2 rounded border border-port-warning/30 p-2">
      {young && <p className="text-port-warning">The npm reference was published less than {warningDays} {warningDays === 1 ? 'day' : 'days'} ago.</p>}
      {ageUnknown && <p className="text-port-warning">The npm release age is unknown, so the warning window cannot be checked.</p>}
      {warningDays > 0 && <p className="text-port-warning">The actual updater target and its publication age are unknown; this is a warning about the npm reference only.</p>}
      <p>Age does not prove a release is safe. Waiting may leave security issues exposed. The vendor updater may install a different version.</p>
      {warningDays > 0 && <p>If you believe a security issue is urgent, you can choose to update now.</p>}
      <p>Updating does not wait for running agents. Most keep working on the version they started with, but one that loads files from the harness mid-run, or starts during the update, can fail and need a retry.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setConfirming(false)} className="rounded border border-port-border px-3 py-2">Wait</button>
        {warningDays > 0 && <button type="button" onClick={() => onUpdate({ ...harness, ticket: reference.ticket })} disabled={disabled || changed}
          className="rounded border border-port-border px-3 py-2 text-gray-300 disabled:opacity-40">Update now anyway</button>}
        <button type="button" onClick={() => onUpdate({ ...harness, ticket: reference.ticket })} disabled={disabled || changed}
          className="rounded bg-port-accent px-3 py-2 text-white disabled:opacity-40">{warningDays > 0 ? 'Update now for urgent security' : 'Start update'}</button>
      </div>
    </div>}
  </div>;
}
