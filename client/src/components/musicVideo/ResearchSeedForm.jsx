import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import InfoTooltip from '../ui/InfoTooltip';
import useProviderModels from '../../hooks/useProviderModels.js';
import socket from '../../services/socket';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';
const COUNTS = [1, 2, 3, 4];
const OPEN_HINT = 'Opens a short form first (subject, photo count, agent); nothing runs until you press Find photos there.';

/**
 * Research and seed (#14822), shared by a shot and a roster cameo: the subject,
 * how many photos, and the agent that searches (agent CLIs only: a direct API
 * model has no web search). `start(body)` posts the request; the result
 * arrives as `music-video:research-seed` for `match` (`{ sceneId }` or
 * `{ cameoId }`), and `onSaved(project)` applies the saved record.
 */
export default function ResearchSeedForm({ projectId, match, start, onSaved, room, limitNote, defaultSubject = '', disabled = false, intro }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(defaultSubject);
  const [count, setCount] = useState(3);
  const llm = useProviderModels({ withEffort: true, silent: true, enabled: open });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [status, setStatus] = useState(null); // null | 'running' | { error } | { added }
  const [sent, setSent] = useState(null);
  const flight = useRef(false);
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const searchProviders = (llm.providers || []).filter((p) => p?.type !== 'api');
  const apiPicked = (llm.providers || []).find((p) => p?.id === llm.selectedProviderId)?.type === 'api';
  const providerId = apiPicked ? '' : llm.selectedProviderId;
  const [key, value] = Object.entries(match)[0];
  const fieldId = `mv-research-${value}`;

  useEffect(() => {
    const receive = (event) => {
      if (event?.projectId !== projectId || event?.[key] !== value) return;
      if (event.status === 'running') { setStatus('running'); return; }
      if (event.status === 'failed') { setStatus({ error: event.error || 'Research found no usable photos.' }); return; }
      if (event.project) saved.current(event.project);
      setStatus({ added: event.added || 0 });
    };
    socket.on('music-video:research-seed', receive);
    return () => socket.off('music-video:research-seed', receive);
  }, [projectId, key, value]);

  const run = async (preview = false) => {
    if (flight.current || disabled || subject.trim().length < 2 || !providerId) return;
    flight.current = true;
    if (!preview) setStatus('running');
    const result = await start({
      subject: subject.trim(), count: Math.min(count, Math.max(room, 1)), providerId,
      model: llm.selectedModel || undefined, effort: effort || undefined, executionOptions, preview,
    }).catch((err) => { setStatus(preview ? null : { error: err?.message || 'Could not start research.' }); return null; });
    flight.current = false;
    if (result) setSent({ prompt: subject.trim(), sentPrompt: result.sentPrompt, additions: result.promptAdditions || [] });
  };

  const running = status === 'running';
  const ready = !running && !disabled && subject.trim().length >= 2 && !!providerId;
  return (
    <div className="space-y-1">
      {!open && (
        <span className="inline-flex items-center">
          <button type="button" onClick={() => { setSubject((s) => s || defaultSubject); setOpen(true); }} disabled={disabled} title={OPEN_HINT}
            className="inline-flex min-h-[44px] items-center gap-1 text-[11px] underline sm:min-h-0">
            <Search size={12} aria-hidden="true" /> Research and seed
          </button>
          <InfoTooltip label="About researching photos" placement="below" align="start" width={280}>
            {OPEN_HINT} An agent with web search then looks for real photos of the subject; {intro}
          </InfoTooltip>
        </span>
      )}
      {running && <p role="status" className="text-[11px] text-port-text-muted">Searching for photos…</p>}
      {open && (
        <section aria-label="Research and seed settings" className="space-y-2 rounded border border-port-border p-2">
          <p className="text-xs text-port-text-muted">An agent CLI that can search the web (Claude Code, Codex, Gemini, Grok) looks for real photos of the subject; {intro} Each keeps a link to where it came from.</p>
          <label htmlFor={`${fieldId}-subject`} className="block text-xs text-port-text-muted">Subject
            <input id={`${fieldId}-subject`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} disabled={running}
              placeholder="For example: Bernedoodle (Bernese Mountain Dog × Poodle), adult"
              className="w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm" />
          </label>
          <label htmlFor={`${fieldId}-count`} className="block text-xs text-port-text-muted">Photos
            <select id={`${fieldId}-count`} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={running}
              className="ml-2 min-h-[44px] rounded border border-port-border bg-port-bg px-2 text-sm sm:min-h-0">
              {COUNTS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <ProviderModelSelector providers={searchProviders} emptyProviderOption="Pick an agent that can search the web" selectedProviderId={providerId} selectedModel={llm.selectedModel}
            availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
            effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
            loading={llm.loading} disabled={running || disabled} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={!ready || room < 1} onClick={() => run()}>
              <Search size={14} aria-hidden="true" /> {running ? 'Researching…' : 'Find photos'}
            </button>
            <button type="button" className={BUTTON} disabled={!ready} onClick={() => run(true)}>Preview prompt</button>
            <button type="button" className={BUTTON} onClick={() => setOpen(false)}>Close</button>
          </div>
          {room < 1 && <p className="text-xs text-port-text-muted">{limitNote}</p>}
          {sent && <SentPromptPanel {...sent} />}
        </section>
      )}
      {status?.error && <p role="alert" className="text-xs text-port-error">{status.error}</p>}
      {status?.added > 0 && <p role="status" className="text-xs text-port-text-muted">Added {status.added} photo{status.added === 1 ? '' : 's'}. Remove any that look wrong before rendering.</p>}
    </div>
  );
}
