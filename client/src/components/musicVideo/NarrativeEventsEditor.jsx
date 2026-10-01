import { useEffect, useState } from 'react';
import { NARRATIVE_EVENT_KINDS } from '../../lib/musicVideoNarrativeEvents.js';
import { uuidv4 } from '../../lib/uuid.js';

const inputCls = 'w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1 text-xs';

/** Explicit saved event bindings; provider actions wait for this draft. */
export default function NarrativeEventsEditor({ project, sections = [], disabled, onSave, onPendingChange }) {
  const [events, setEvents] = useState(project.composition?.narrativeEvents || []);
  const [reactiveSections, setReactiveSections] = useState(project.composition?.reactiveSections || []);
  const dirty = JSON.stringify({ events, reactiveSections }) !== JSON.stringify({
    events: project.composition?.narrativeEvents || [], reactiveSections: project.composition?.reactiveSections || [],
  });
  useEffect(() => { onPendingChange(dirty); }, [dirty, onPendingChange]);
  const edit = (id, patch) => setEvents((events) => events.map((event) => event.id === id ? { ...event, ...patch } : event));
  const add = () => setEvents((events) => [...events, {
    id: `mne-${uuidv4()}`, name: 'New reveal', kind: 'reveal', anchor: { kind: 'time', atSec: 0 }, durationSec: 1,
    narrativeFunction: 'Introduce the next narrative beat', mediumRationale: 'Exact graphics use code over selected media',
  }]);
  const words = (project.lyricCues || []).flatMap((cue) => (cue.words || []).map((word, wordIndex) => ({
    cueId: cue.id, wordIndex, label: `${word.w || word.text} · ${word.startSec}s`,
  })));
  return <details className="rounded border border-port-border p-2 text-xs">
    <summary className="cursor-pointer py-2">Narrative events and section reactivity</summary>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); onSave({ narrativeEvents: events, reactiveSections }); }}>
      <fieldset disabled={disabled} className="space-y-3">
        <p className="text-port-text-muted">Bind exact graphics to a song time, measured onset, or aligned word. Silence holds the picture. Save, then revise events to retain accepted footage.</p>
        {events.map((event) => {
          const prefix = `mv-event-${event.id}`;
          const field = (key, label, numeric = false) => <div key={key}>
            <label htmlFor={`${prefix}-${key}`}>{label}</label>
            <input id={`${prefix}-${key}`} className={inputCls} type={numeric ? 'number' : 'text'}
              required={['name', 'narrativeFunction', 'mediumRationale', 'durationSec'].includes(key)}
              maxLength={key === 'text' ? 500 : key === 'narrativeFunction' || key === 'mediumRationale' ? 1000 : 120}
              min={key === 'durationSec' ? 0.042 : numeric ? -1000000 : undefined} max={key === 'durationSec' ? 900 : numeric ? 1000000 : undefined}
              step={numeric ? 'any' : undefined} value={event[key] ?? ''}
              onChange={(e) => edit(event.id, { [key]: numeric ? Number(e.target.value) : e.target.value })} />
          </div>;
          return <div key={event.id} className="space-y-2 rounded border border-port-border p-2">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {field('name', 'Event name')}
              <div><label htmlFor={`${prefix}-kind`}>Graphic action</label>
                <select id={`${prefix}-kind`} className={inputCls} value={event.kind} onChange={(e) => edit(event.id, { kind: e.target.value })}>
                  {NARRATIVE_EVENT_KINDS.map((kind) => <option key={kind}>{kind}</option>)}
                </select></div>
              <div><label htmlFor={`${prefix}-anchor`}>Timing source</label>
                <select id={`${prefix}-anchor`} className={inputCls} value={event.anchor?.kind || ''} onChange={(e) => {
                  const kind = e.target.value;
                  edit(event.id, { anchor: kind === 'time' ? { kind, atSec: 0 } : kind === 'onset' ? { kind, band: 'low', index: 0 }
                    : words.length ? { kind, cueId: words[0].cueId, wordIndex: words[0].wordIndex } : null });
                }}>
                  <option value="" disabled>Rebind after song change</option><option value="time">Song time</option>
                  <option value="onset">Band onset</option><option value="word" disabled={!words.length}>Aligned word</option>
                </select></div>
              {event.anchor?.kind === 'time' && <div><label htmlFor={`${prefix}-time`}>Song seconds</label>
                <input id={`${prefix}-time`} className={inputCls} type="number" min="0" max="36000" step="any" required value={event.anchor.atSec}
                  onChange={(e) => edit(event.id, { anchor: { ...event.anchor, atSec: Number(e.target.value) } })} /></div>}
              {event.anchor?.kind === 'onset' && <>
                <div><label htmlFor={`${prefix}-band`}>Onset band</label><select id={`${prefix}-band`} className={inputCls} value={event.anchor.band}
                  onChange={(e) => edit(event.id, { anchor: { ...event.anchor, band: e.target.value } })}>
                  {['low', 'mid', 'high'].map((band) => <option key={band}>{band}</option>)}</select></div>
                <div><label htmlFor={`${prefix}-index`}>Onset index (from 0)</label><input id={`${prefix}-index`} className={inputCls} type="number" min="0" max="100000" required value={event.anchor.index}
                  onChange={(e) => edit(event.id, { anchor: { ...event.anchor, index: Number(e.target.value) } })} /></div>
              </>}
              {event.anchor?.kind === 'word' && <div><label htmlFor={`${prefix}-word`}>Aligned word</label><select id={`${prefix}-word`} className={inputCls}
                value={JSON.stringify([event.anchor.cueId, event.anchor.wordIndex])} onChange={(e) => {
                  const [cueId, wordIndex] = JSON.parse(e.target.value); edit(event.id, { anchor: { ...event.anchor, cueId, wordIndex } });
                }}>
                {words.map((word) => <option key={`${word.cueId}-${word.wordIndex}`} value={JSON.stringify([word.cueId, word.wordIndex])}>{word.label}</option>)}
              </select></div>}
              {field('durationSec', 'Duration seconds', true)}
              {field('text', 'Graphic text')}
              {field('narrativeFunction', 'Narrative function')}
              {field('mediumRationale', 'Medium rationale')}
              {event.kind === 'counter-change' && <>{field('fromValue', 'Counter before', true)}{field('toValue', 'Counter after', true)}</>}
              {event.kind === 'motif-transformation' && <>{field('motif', 'Motif')}{field('before', 'Motif before')}{field('after', 'Motif after')}</>}
            </div>
            <button type="button" className="min-h-[44px] text-port-error" onClick={() => setEvents((events) => events.filter((other) => other.id !== event.id))}>Remove {event.name}</button>
          </div>;
        })}
        <button type="button" className="min-h-[44px] text-port-accent" disabled={events.length >= 200} onClick={add}>Add narrative event</button>
        {sections.map((section) => {
          const current = reactiveSections.find((entry) => entry.sectionId === section.id) || { sectionId: section.id, gain: 0.25, maxGain: 0.35 };
          return <div key={section.id} className="flex flex-wrap items-end gap-2">
            <span>{section.label || section.id}</span>
            {['gain', 'maxGain'].map((key) => <div key={key}><label htmlFor={`mv-reactive-${section.id}-${key}`}>{key === 'gain' ? 'Reactive gain' : 'Gain cap'}</label>
              <input id={`mv-reactive-${section.id}-${key}`} className={`${inputCls} max-w-24`} type="number" min="0" max="1" step="0.05" required value={current[key]}
                onChange={(e) => setReactiveSections((entries) => [...entries.filter((entry) => entry.sectionId !== section.id), { ...current, [key]: Number(e.target.value) }])} /></div>)}
          </div>;
        })}
        <button className="min-h-[44px] rounded border border-port-border px-2" type="submit" disabled={!dirty || events.some((event) => !event.anchor)}>Save event bindings</button>
        <button className="ml-2 min-h-[44px] rounded border border-port-border px-2" type="button" disabled={!dirty} onClick={() => {
          setEvents(project.composition?.narrativeEvents || []); setReactiveSections(project.composition?.reactiveSections || []);
        }}>Discard event edits</button>
      </fieldset>
    </form>
  </details>;
}
