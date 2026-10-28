import { useEffect, useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { applyMusicVideoStory, applyMusicVideoStoryBeats, getMusicVideoStoryContext, proposeMusicVideoStory, saveMusicVideoStorySummary } from '../../services/apiMusicVideo.js';
import { STORYBOARD_LIMITS, STORYBOARD_MUSICAL_ROLES, STORYBOARD_PANEL_FRAMINGS } from '../../../../server/lib/storyboardVocabulary.js';

const input = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm';
const button = 'min-h-[44px] rounded border border-port-border px-3 py-1.5 text-sm text-port-accent disabled:opacity-50';
const display = (value) => typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
const title = (key) => ({ prompt: 'Concept', style: 'Visual style', songStyle: 'Song style', premise: 'Narrative premise', mustHave: 'Must have', avoid: 'Avoid' }[key] || key.replace(/([A-Z])/g, ' $1'));
const fieldLimits = { prompt: 8000, style: 2000, songStyle: 2000, audience: 500, destination: 200, emotion: 500, premise: 2000, hookObjective: 1000, graphicLanguage: 1000, mustHave: 2000, avoid: 2000 };
const aspectRatios = ['16:9', '9:16', '1:1', '4:5', '2.39:1'];
// An omitted patch field retains its current value; an explicit null clears it.
const effective = (proposal, current, key) => Object.hasOwn(proposal, key) ? proposal[key] : current?.[key];
const currentSubjectSummary = (subject) => subject ? [subject.name, subject.kind, subject.role, subject.description].filter(Boolean).join(' · ') : 'No longer available';
const currentBeatSummary = (proposed, beat) => {
  if (!beat) return 'No longer available';
  const fields = ['title', 'what', 'why', 'emotion', 'musicalRole'];
  const details = fields.filter((key) => Object.hasOwn(proposed, key)).map((key) => `${title(key)}: ${beat[key] || 'Not set'}`);
  for (const panel of proposed.panels || []) {
    const index = beat.panels?.findIndex((item) => item.id === panel.id) ?? -1;
    if (index < 0) continue;
    for (const key of ['action', 'dialogue', 'framing', 'camera', 'seconds']) {
      if (Object.hasOwn(panel, key)) details.push(`Panel ${index + 1} ${title(key)}: ${beat.panels[index][key] ?? 'Not set'}`);
    }
  }
  return details.length ? details.join(' · ') : beat.title || 'No current details';
};

export default function StoryWorkbench({ project, disabled, onProject, onBoardChanged, active = true }) {
  const llm = useProviderModels({ withEffort: true, silent: true, enabled: active });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [summary, setSummary] = useState(project.storySummary || '');
  const [saved, setSaved] = useState(project.storySummary || '');
  const [latestSummary, setLatestSummary] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [messages, setMessages] = useState([]);
  const [proposal, setProposal] = useState(null);
  const [selected, setSelected] = useState({});
  const [context, setContext] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const flight = useRef(false);
  const saveFlight = useRef(false);
  const dirty = summary !== saved;
  useEffect(() => {
    if (!dirty && !saving && (project.storySummary || '') !== saved) {
      setSummary(project.storySummary || ''); setSaved(project.storySummary || '');
    }
  }, [project.storySummary, dirty, saved, saving]);
  const save = async () => {
    if (!dirty || saveFlight.current) return !dirty;
    saveFlight.current = true;
    setSaving(true); setError(''); setNotice('');
    const result = await saveMusicVideoStorySummary(project.id, { summary, baseSummary: saved }, { silent: true })
      .catch(async (err) => {
        if (err?.status === 409) {
          const latest = await getMusicVideoStoryContext(project.id, { silent: true }).catch(() => null);
          if (latest) setLatestSummary(latest.inputs.summary);
        }
        setError(err?.message || 'Could not save the story summary.');
        return null;
      });
    saveFlight.current = false; setSaving(false);
    if (!result) return false;
    setSaved(result.project.storySummary || ''); setLatestSummary(null);
    onProject({ storySummary: result.project.storySummary || '', updatedAt: result.project.updatedAt });
    return true;
  };
  const run = async (preview = false) => {
    if (flight.current || dirty || saving || !llm.selectedProviderId || (!summary.trim() && !instruction.trim())) return;
    flight.current = true; setBusy(true); setError(''); setNotice('');
    const text = instruction.trim() ? instruction : 'Develop the story from my summary and the existing project.';
    const turns = [...messages, { role: 'user', content: text }];
    const result = await proposeMusicVideoStory(project.id, { providerId: llm.selectedProviderId, model: llm.selectedModel || undefined,
      effort: effort || undefined, executionOptions, messages: turns, ...(proposal ? { draft: proposal } : {}), preview }, { silent: true })
      .catch((err) => { setError(err?.message || 'Could not develop the story.'); return null; });
    flight.current = false; setBusy(false);
    if (!result) return;
    setSent({ prompt: text, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
    if (!preview) {
      setContext(result); setProposal(result.proposal); setSelected({}); setInstruction('');
      setMessages([...turns, { role: 'assistant', content: result.reply }]);
    }
  };
  const refresh = async () => {
    setBusy(true); setError(''); setNotice('');
    const next = await getMusicVideoStoryContext(project.id, { silent: true }).catch((err) => { setError(err?.message || 'Could not read the current story.'); return null; });
    setBusy(false);
    if (next) { setContext(next); setSelected({}); setNotice('Current values refreshed. Review and select the changes again.'); }
  };
  const selectedProject = () => {
    const next = {};
    for (const group of ['concept', 'brief']) {
      const entries = Object.entries(proposal?.[group] || {}).filter(([key]) => selected[`${group}.${key}`]);
      if (entries.length) next[group] = Object.fromEntries(entries);
    }
    const subjects = (proposal?.subjects || []).filter((_, i) => selected[`subject.${i}`]);
    if (subjects.length) next.subjects = subjects;
    return next;
  };
  const applyProject = async () => {
    const patch = selectedProject();
    if (!context || !Object.keys(patch).length) return;
    setBusy(true); setError(''); setNotice('');
    const result = await applyMusicVideoStory(project.id, { basis: context.basis, proposal: patch }, { silent: true })
      .catch((err) => { setError(err?.message || 'Could not apply the proposal.'); return null; });
    if (!result) { setBusy(false); return; }
    onProject({ concept: result.project.concept, treatment: result.project.treatment, updatedAt: result.project.updatedAt });
    setProposal((old) => {
      const next = { ...old };
      for (const group of ['concept', 'brief']) {
        if (next[group]) next[group] = Object.fromEntries(Object.entries(next[group]).filter(([key]) => !selected[`${group}.${key}`]));
      }
      if (next.subjects) next.subjects = next.subjects.filter((_, i) => !selected[`subject.${i}`]);
      return next;
    });
    setSelected((old) => Object.fromEntries(Object.entries(old).filter(([key]) => key.startsWith('beat.'))));
    const next = await getMusicVideoStoryContext(project.id, { silent: true }).catch(() => null);
    if (next) setContext(next);
    setNotice('Selected direction and cast changes applied. Storyboard beats are applied separately.');
    setBusy(false);
  };
  const applyBeats = async () => {
    const beats = (proposal?.beats || []).filter((_, i) => selected[`beat.${i}`]);
    if (!context?.board || context.board.id !== project.storyboardId || !beats.length) return;
    setBusy(true); setError(''); setNotice('');
    const result = await applyMusicVideoStoryBeats(project.id, { boardId: context.board.id, boardBasis: context.board.basis, basis: context.basis, beats }, { silent: true })
      .catch((err) => { setError(err?.message || 'Could not apply storyboard beats.'); return null; });
    if (!result) { setBusy(false); return; }
    onBoardChanged?.();
    setProposal((old) => ({ ...old, beats: old.beats.filter((_, i) => !selected[`beat.${i}`]) }));
    setSelected((old) => Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith('beat.'))));
    const next = await getMusicVideoStoryContext(project.id, { silent: true }).catch(() => null);
    if (next) setContext(next);
    setNotice('Selected beats applied to the storyboard. Timed shots were not changed.');
    setBusy(false);
  };
  const setField = (group, key, value) => setProposal((old) => ({ ...old, [group]: { ...old[group], [key]: value } }));
  const setArray = (group, index, patch) => setProposal((old) => ({ ...old, [group]: old[group].map((item, i) => i === index ? { ...item, ...patch } : item) }));
  const tick = (key, label) => <input id={`mv-story-select-${key}`} type="checkbox" aria-label={label} checked={!!selected[key]} onChange={(e) => setSelected((old) => ({ ...old, [key]: e.target.checked }))} />;
  const canRun = !disabled && !busy && !saving && !dirty && !!llm.selectedProviderId && !!(summary.trim() || instruction.trim());
  return <section aria-label="Develop the story" aria-busy={busy} className="space-y-3 rounded-lg border border-port-border bg-port-card p-3">
    <fieldset disabled={busy} className="min-w-0 space-y-3">
    <h3 className="text-sm font-semibold">Develop the story</h3>
    {disabled && <p className="text-xs text-port-text-muted">Finish editing or saving story inputs before developing or applying a proposal.</p>}
    <label htmlFor="mv-story-summary" className="block text-xs text-port-text-muted">Story in your own words</label>
    <textarea id="mv-story-summary" className={input} rows={5} maxLength={20000} value={summary} onChange={(e) => setSummary(e.target.value)} onBlur={save}
      placeholder="Describe who is there, what happens, and how it ends — rough notes are welcome." />
    <div className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted"><span>{summary.length} / 20,000 characters · {saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
      {dirty && <button type="button" className={button} disabled={saving} onClick={save}>Save story notes</button>}</div>
    {latestSummary !== null && <div className="space-y-2 rounded border border-port-warning p-2 text-sm"><p>The saved summary changed elsewhere.</p>
      <p className="whitespace-pre-wrap break-words"><strong>Current:</strong> {latestSummary}</p><p className="whitespace-pre-wrap break-words"><strong>Yours:</strong> {summary}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={() => { onProject({ storySummary: latestSummary }); setSummary(latestSummary); setSaved(latestSummary); setLatestSummary(null); setError(''); }}>Use current</button>
        <button type="button" className={button} onClick={() => { setSaved(latestSummary); setLatestSummary(null); setError(''); }}>Keep mine for review</button></div></div>}
    <ProviderModelSelector providers={llm.providers} selectedProviderId={llm.selectedProviderId} selectedModel={llm.selectedModel}
      availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
      effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
      loading={llm.loading} disabled={busy || disabled} />
    {llm.providers.find((provider) => provider.id === llm.selectedProviderId)?.toolFreeOneShot === false && <p className="text-xs text-port-text-muted">This provider can use tools and requires host control.</p>}
    <div role="log" aria-label="Story conversation" className="max-h-64 space-y-1 overflow-y-auto break-words">
      {messages.map((message, i) => <p key={i} className="whitespace-pre-wrap text-sm"><strong>{message.role === 'user' ? 'You' : 'Creative assistant'}:</strong> {message.content}</p>)}
    </div>
    <label htmlFor="mv-story-instruction" className="block text-xs text-port-text-muted">Direction or follow-up</label>
    <textarea id="mv-story-instruction" className={input} rows={2} maxLength={16000} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should the assistant develop or change?" />
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!canRun || messages.length >= 40} onClick={() => run()}>{busy ? 'Working…' : proposal ? 'Refine story' : 'Develop story'}</button>
      <button type="button" className={button} disabled={!canRun || messages.length >= 40} onClick={() => run(true)}>Preview prompt and context</button></div>
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}{notice && <p role="status" className="text-sm text-port-text-muted">{notice}</p>}
    {sent && <SentPromptPanel {...sent} />}
    {proposal && <div className="space-y-3 border-t border-port-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">Review proposed changes</h4>
        <button type="button" className={button} disabled={busy} onClick={refresh}>Review current values</button></div>
      <p className="text-xs text-port-text-muted">Select only changes to apply. Existing story values and the proposal are shown together.</p>
      {['concept', 'brief'].map((group) => Object.entries(proposal[group] || {}).map(([key, value]) => <div key={`${group}.${key}`} className="space-y-1 rounded border border-port-border p-2">
        <label htmlFor={`mv-story-select-${group}.${key}`} className="flex items-center gap-2 text-sm">{tick(`${group}.${key}`, title(key))} {title(key)}</label>
        <p className="whitespace-pre-wrap break-words text-xs text-port-text-muted">Current: {display(context?.inputs?.[group]?.[key] || '')}</p>
        {key === 'aspectRatio' ? <select aria-label={`Proposed ${title(key)}`} className={input} value={value || ''} onChange={(e) => setField(group, key, e.target.value || null)}>
          <option value="">Any</option>{aspectRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select> : <textarea aria-label={`Proposed ${title(key)}`} className={input} rows={2} maxLength={fieldLimits[key]} value={value ?? ''} onChange={(e) => setField(group, key, e.target.value)} />}
      </div>))}
      {(proposal.subjects || []).map((subject, i) => {
        const existing = context?.inputs?.concept?.subjects?.find((item) => item.id === subject.id);
        return <div key={`subject-${i}`} className="space-y-1 rounded border border-port-border p-2">
        <label htmlFor={`mv-story-select-subject.${i}`} className="flex items-center gap-2 text-sm">{tick(`subject.${i}`, subject.id ? 'Update subject' : 'Add subject (kept in this video)')} {subject.id ? 'Update subject' : 'Add subject (kept in this video)'}</label>
        {subject.id && <p className="whitespace-pre-wrap break-words text-xs text-port-text-muted">Current: {currentSubjectSummary(existing)}</p>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><label className="text-xs">Kind<select className={input} disabled={!!subject.id} value={subject.kind} onChange={(e) => setArray('subjects', i, { kind: e.target.value })}><option value="character">Character</option><option value="place">Place</option><option value="object">Object</option></select></label>
          <label className="text-xs">Name<input className={input} value={subject.name} maxLength={120} onChange={(e) => setArray('subjects', i, { name: e.target.value })} /></label></div>
        {subject.kind === 'character' && <label className="block text-xs">Role<select className={input} value={effective(subject, existing, 'role') || ''} onChange={(e) => setArray('subjects', i, { role: e.target.value })}><option value="" disabled>Not specified</option><option value="protagonist">Protagonist</option><option value="band">Band</option><option value="supporting">Supporting</option></select></label>}
        <label className="block text-xs">Description<textarea className={input} value={effective(subject, existing, 'description') || ''} maxLength={1000} onChange={(e) => setArray('subjects', i, { description: e.target.value })} /></label>
      </div>; })}
      <button type="button" className={button} disabled={disabled || busy || !Object.keys(selectedProject()).length} onClick={applyProject}>Apply selected direction and cast</button>
      {(proposal.beats || []).map((beat, i) => {
        const existing = context?.board?.beats?.find((item) => item.id === beat.id);
        return <div key={`beat-${i}`} className="space-y-1 rounded border border-port-border p-2">
        <label htmlFor={`mv-story-select-beat.${i}`} className="flex items-center gap-2 text-sm">{tick(`beat.${i}`, beat.id ? 'Update beat' : 'Add beat')} {beat.id ? 'Update beat' : 'Add beat'}</label>
        {beat.id && <p className="whitespace-pre-wrap break-words text-xs text-port-text-muted">Current: {currentBeatSummary(beat, existing)}</p>}
        {['title', 'what', 'why', 'emotion'].map((key) => <label key={key} className="block text-xs">{title(key)}<textarea className={input} rows={key === 'what' ? 2 : 1} maxLength={key === 'title' ? STORYBOARD_LIMITS.beatTitle : key === 'emotion' ? STORYBOARD_LIMITS.emotion : STORYBOARD_LIMITS.beatText} value={effective(beat, existing, key) || ''} onChange={(e) => setArray('beats', i, { [key]: e.target.value })} /></label>)}
        <label className="block text-xs">Musical role<select className={input} value={effective(beat, existing, 'musicalRole') || ''} onChange={(e) => setArray('beats', i, { musicalRole: e.target.value || null })}><option value="">Not set</option>{STORYBOARD_MUSICAL_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
        {(beat.panels || []).map((panel, j) => {
          const savedPanel = existing?.panels?.find((item) => item.id === panel.id);
          return <div key={`panel-${j}`} className="rounded border border-port-border p-2"><p className="text-xs">{panel.id ? 'Existing panel' : 'New panel'} {j + 1}</p>
          {['action', 'dialogue', 'camera'].map((key) => <label key={key} className="block text-xs">{title(key)}<textarea className={input} rows={1} maxLength={key === 'camera' ? STORYBOARD_LIMITS.camera : STORYBOARD_LIMITS.panelText} value={effective(panel, savedPanel, key) || ''} onChange={(e) => setArray('beats', i, { panels: beat.panels.map((item, n) => n === j ? { ...item, [key]: e.target.value } : item) })} /></label>)}
          <label className="block text-xs">Framing<select className={input} value={effective(panel, savedPanel, 'framing') || ''} onChange={(e) => setArray('beats', i, { panels: beat.panels.map((item, n) => n === j ? { ...item, framing: e.target.value || null } : item) })}><option value="">Not set</option>{STORYBOARD_PANEL_FRAMINGS.map((framing) => <option key={framing} value={framing}>{framing}</option>)}</select></label>
          <label className="block text-xs">Estimated seconds<input className={input} type="number" min="0.01" max="600" value={effective(panel, savedPanel, 'seconds') ?? ''} onChange={(e) => setArray('beats', i, { panels: beat.panels.map((item, n) => n === j ? { ...item, seconds: e.target.value ? Number(e.target.value) : null } : item) })} /></label>
        </div>; })}
      </div>; })}
      {(proposal.beats || []).length > 0 && <div className="space-y-1"><p className="text-xs text-port-text-muted">{context?.board && context.board.id === project.storyboardId ? `Destination: ${context.board.name}` : 'Link or create a storyboard below, then review current values.'}</p>
        <button type="button" className={button} disabled={disabled || busy || !context?.board || context.board.id !== project.storyboardId || !(proposal.beats || []).some((_, i) => selected[`beat.${i}`])} onClick={applyBeats}>Apply selected beats to storyboard</button></div>}
      <button type="button" className={button} disabled={busy} onClick={() => { setProposal(null); setSelected({}); setMessages([]); setSent(null); setContext(null); setError(''); setNotice(''); }}>Discard proposal</button>
    </div>}
    </fieldset>
  </section>;
}
