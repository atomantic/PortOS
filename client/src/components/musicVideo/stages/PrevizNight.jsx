import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Clapperboard, Moon, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { activeMusicVideoSubjects } from '../../../../../server/lib/musicVideoCastSelection.js';
import toast from '../../ui/Toast';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import WorldMap, { fitWorldView } from '../../catalog/WorldMapView';
import { formatCount } from '../../../utils/formatters.js';
import { worldClockText } from '../../../../../server/lib/worldMap.js';
import { musicVideoShotPlaceId } from '../../../../../server/lib/musicVideoRouteMaps.js';
import { placePrevizCutsOnNight, previzPawnColors, projectPreviz } from '../../../../../server/lib/musicVideoPreviz.js';
import { NIGHT_BEATS_MAX, NIGHT_PACES } from '../../../../../server/lib/musicVideoPrevizLimits.js';
import {
  draftNightFromShots, nightActorsAt, nightBeatProblems, nightClockAt, nightMinuteOfClock, previzNight,
} from '../../../../../server/lib/musicVideoPrevizNight.js';

const selectCls = 'min-h-[44px] min-w-0 max-w-full rounded border border-port-border bg-port-bg px-1.5 py-1 text-xs text-port-text pointer-fine:sm:min-h-0';
const buttonCls = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs disabled:opacity-50 pointer-fine:sm:min-h-0';
const chipCls = (on) => `inline-flex min-h-[44px] items-center gap-1 rounded-full border px-2 text-xs pointer-fine:sm:min-h-7 ${on ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`;
const HOURS = Array.from({ length: 24 }, (_, i) => i + 1);
// Story minutes per real second while watching: an 8-hour night plays in 8 minutes.
const WATCH_SPEED = 60;
const PACE_LABELS = { walk: 'Walk', run: 'Run', ride: 'Ride' };

const beatIdMaker = () => {
  const stamp = Date.now().toString(36);
  let n = 0;
  return () => `n${stamp}${(n += 1).toString(36)}`;
};
const toTimeValue = (clock) => worldClockText(clock);
const fromTimeValue = (value) => {
  const [h, m] = String(value).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const durationText = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
};

/** Each person's beats as a lane across the whole night; tap a beat to edit it. */
function NightStrip({ night, characters, colors, setName, selected, watchMin, onSelect }) {
  return (
    <div className="min-w-0 space-y-1" role="group" aria-label="Night strip">
      {characters.map((subject) => (
        <div key={subject.id} className="flex min-w-0 items-center gap-2">
          <span className="w-16 shrink-0 truncate text-xs text-port-text-muted">{subject.name}</span>
          <div className="relative h-7 min-w-0 flex-1 rounded bg-port-bg">
            {night.beats.filter((beat) => (beat.subjectIds || []).includes(subject.id)).map((beat) => (
              <button key={beat.id} type="button"
                aria-label={`${beat.kind === 'travel' ? `${PACE_LABELS[beat.pace] || 'Travel'} to ${setName(beat.toSetId)}` : setName(beat.setId)}, ${worldClockText(nightClockAt(night, beat.startMin))}`}
                aria-pressed={selected === beat.id}
                className={`absolute inset-y-0.5 rounded-sm border ${selected === beat.id ? 'border-port-accent' : 'border-transparent'}`}
                style={{
                  left: `${(beat.startMin / night.lengthMin) * 100}%`,
                  width: `${Math.max(0.6, ((beat.endMin - beat.startMin) / night.lengthMin) * 100)}%`,
                  background: beat.kind === 'travel'
                    ? `repeating-linear-gradient(90deg, ${colors[subject.id]?.figure.hex || '#888'} 0 4px, transparent 4px 7px)`
                    : colors[subject.id]?.figure.hex || '#888',
                  opacity: beat.kind === 'travel' ? 0.8 : 0.6,
                }}
                onClick={() => onSelect(selected === beat.id ? '' : beat.id)} />
            ))}
            <span className="pointer-events-none absolute inset-y-0 w-px bg-port-text" style={{ left: `${(watchMin / night.lengthMin) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function BeatEditor({ project, world, night, beat, characters, setName, onChange, onRemove }) {
  const problems = nightBeatProblems(project, world, beat);
  const span = beat.endMin - beat.startMin;
  const setStart = (value) => {
    const clock = fromTimeValue(value);
    if (clock === null) return;
    const startMin = nightMinuteOfClock(night, clock);
    // A time outside the night wraps past its end.
    if (startMin >= night.lengthMin) return;
    onChange({ startMin, endMin: startMin + span });
  };
  return (
    <div className="min-w-0 space-y-2 rounded border border-port-border p-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-1" htmlFor="night-beat-kind">
          <span className="text-port-text-muted">Beat</span>
          <select id="night-beat-kind" className={selectCls} value={beat.kind}
            onChange={(event) => onChange(event.target.value === 'travel'
              ? { kind: 'travel', toSetId: world.sets.find((set) => set.id !== beat.setId)?.id || null, pace: beat.pace || 'walk' }
              : { kind: 'stay', toSetId: null, pace: null })}>
            <option value="stay">Stay</option>
            <option value="travel">Travel</option>
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-1" htmlFor="night-beat-set">
          <span className="text-port-text-muted">{beat.kind === 'travel' ? 'From' : 'At'}</span>
          <select id="night-beat-set" className={selectCls} value={beat.setId} onChange={(event) => onChange({ setId: event.target.value })}>
            {world.sets.map((set) => <option key={set.id} value={set.id}>{setName(set.id)}</option>)}
          </select>
        </label>
        {beat.kind === 'travel' && (
          <>
            <label className="flex min-w-0 items-center gap-1" htmlFor="night-beat-to">
              <span className="text-port-text-muted">To</span>
              <select id="night-beat-to" className={selectCls} value={beat.toSetId || ''} onChange={(event) => onChange({ toSetId: event.target.value || null })}>
                <option value="">Pick a set</option>
                {world.sets.map((set) => <option key={set.id} value={set.id}>{setName(set.id)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1" htmlFor="night-beat-pace">
              <span className="text-port-text-muted">Pace</span>
              <select id="night-beat-pace" className={selectCls} value={beat.pace || 'walk'} onChange={(event) => onChange({ pace: event.target.value })}>
                {NIGHT_PACES.map((pace) => <option key={pace} value={pace}>{PACE_LABELS[pace]}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex items-center gap-1" htmlFor="night-beat-start">
          <span className="text-port-text-muted">Starts</span>
          <input id="night-beat-start" type="time" className={selectCls} value={toTimeValue(nightClockAt(night, beat.startMin))} onChange={(event) => setStart(event.target.value)} />
        </label>
        <label className="flex items-center gap-1" htmlFor="night-beat-length">
          <span className="text-port-text-muted">Minutes</span>
          <input id="night-beat-length" type="number" min="1" step="1" inputMode="numeric" className={`${selectCls} w-20`} value={Math.round(span)}
            onChange={(event) => {
              const minutes = Math.round(Number(event.target.value));
              if (minutes >= 1) onChange({ endMin: beat.startMin + minutes });
            }} />
        </label>
        <button type="button" className={`${buttonCls} ml-auto`} onClick={onRemove}><Trash2 size={12} aria-hidden="true" /> Remove beat</button>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1" role="group" aria-label="Who is in this beat">
        {characters.map((subject) => {
          const on = (beat.subjectIds || []).includes(subject.id);
          return (
            <button key={subject.id} type="button" aria-pressed={on} className={chipCls(on)}
              onClick={() => onChange({ subjectIds: on ? beat.subjectIds.filter((id) => id !== subject.id) : [...(beat.subjectIds || []), subject.id] })}>
              {subject.name}
            </button>
          );
        })}
      </div>
      {problems.length > 0 && <p className="text-port-warning">{problems.join(' · ')}</p>}
    </div>
  );
}

/**
 * The story night over the previz world: when it starts and how long it runs,
 * the beats (stay at a set, travel between sets) everyone's journey is
 * simulated from, a strip of those beats per person, and a top-down map to
 * watch the whole night play at 60x. The selected beat is `?beat=`. Drafting
 * also places the previz cuts on the night; "Place shots" fills cuts with no
 * story time yet. `onSave(patch)` saves fields of the previz.
 */
export default function PrevizNight({ project, world, places, locked, onSave: savePatch }) {
  const [params, setParams] = useSearchParams();
  const night = previzNight(project);
  const onSave = (next) => savePatch({ night: next });
  // One entry per character: the alternate picked on the Story step.
  const characters = activeMusicVideoSubjects(project.concept).filter((subject) => subject.kind === 'character');
  const colors = useMemo(() => previzPawnColors(project), [project]);
  const [startClock, setStartClock] = useState(1200);
  const [hours, setHours] = useState(8);
  const [watchMin, setWatchMin] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState(() => fitWorldView(world));
  const [confirmRedraft, setConfirmRedraft] = useState(false);
  const frame = useRef(null);
  const selected = params.get('beat') || '';
  const beat = night?.beats.find((entry) => entry.id === selected) || null;
  const setName = (setId) => {
    const set = world.sets.find((entry) => entry.id === setId);
    return (set && places[set.ingredientId]?.ingredient?.name) || (set ? '…' : 'Missing set');
  };
  const select = (id) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (id) next.set('beat', id); else next.delete('beat');
    return next;
  }, { replace: true });

  useEffect(() => {
    if (!playing || !night) return undefined;
    let last = performance.now();
    const tick = (now) => {
      const step = ((now - last) / 1000) * WATCH_SPEED;
      last = now;
      let ended = false;
      setWatchMin((min) => {
        const next = min + step;
        if (next < night.lengthMin) return next;
        ended = true;
        return night.lengthMin;
      });
      if (ended) setPlaying(false);
      else frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, night]);

  const timedShots = (project.scenes || []).filter((scene) => Number.isFinite(scene.startSec) && scene.endSec > scene.startSec).length;
  const draft = (from = { startClock, lengthMin: hours * 60 }) => {
    const { night: next, visits } = draftNightFromShots(project, world, {
      placeOfShot: (scene) => musicVideoShotPlaceId(project, scene), newId: beatIdMaker(), ...from,
    });
    if (!visits) {
      toast.error('No shot is set in a place on the world map yet. Link the shots\' places to the world\'s sets first.');
      return;
    }
    select('');
    setWatchMin(0);
    const withNight = { ...project, previz: { ...(project.previz || { cuts: [], tracks: [] }), night: next } };
    const { previz, placed } = placePrevizCutsOnNight(withNight, world);
    savePatch(projectPreviz(withNight) ? { night: next, cuts: previz.cuts } : { night: next });
    toast.success(`Night drafted: ${formatCount(next.beats.length)} beat${next.beats.length === 1 ? '' : 's'}${placed ? `, ${formatCount(placed)} shot${placed === 1 ? '' : 's'} placed on it` : ''}`);
  };
  const cuts = projectPreviz(project)?.cuts || [];
  const unplaced = cuts.filter((cut) => !Number.isFinite(cut.storyMin)).length;
  const placeShots = () => {
    const { previz, placed } = placePrevizCutsOnNight(project, world, { onlyUnplaced: true });
    if (!placed) { toast.error('None of the unplaced shots is at a set the night stays at.'); return; }
    savePatch({ cuts: previz.cuts });
    toast.success(`${formatCount(placed)} shot${placed === 1 ? '' : 's'} placed on the night`);
  };
  const editBeat = (patch) => onSave({ ...night, beats: night.beats.map((entry) => (entry.id === beat.id ? { ...entry, ...patch } : entry)) });
  const addBeat = () => {
    const after = beat || [...night.beats].sort((a, b) => b.endMin - a.endMin)[0];
    const startMin = after ? after.endMin : 0;
    const setId = after ? (after.kind === 'travel' ? after.toSetId : after.setId) || world.sets[0].id : world.sets[0].id;
    const added = { id: beatIdMaker()(), kind: 'stay', subjectIds: after?.subjectIds?.length ? after.subjectIds : characters.map((subject) => subject.id), startMin, endMin: startMin + 30, setId, toSetId: null, pace: null };
    onSave({ ...night, lengthMin: Math.max(night.lengthMin, added.endMin), beats: [...night.beats, added] });
    select(added.id);
  };

  if (!world.sets.length) return <p className="text-xs text-port-text-muted">Place a set on the world map to plan the night.</p>;
  if (!night) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1" htmlFor="night-start">
          <span className="text-port-text-muted">Starts</span>
          <input id="night-start" type="time" className={selectCls} value={toTimeValue(startClock)} onChange={(event) => { const clock = fromTimeValue(event.target.value); if (clock !== null) setStartClock(clock); }} />
        </label>
        <label className="flex items-center gap-1" htmlFor="night-hours">
          <span className="text-port-text-muted">Lasts</span>
          <select id="night-hours" className={selectCls} value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {HOURS.map((h) => <option key={h} value={h}>{h} h</option>)}
          </select>
        </label>
        <button type="button" className={buttonCls} disabled={locked || !timedShots} onClick={() => draft()}><Moon size={12} aria-hidden="true" /> Draft night from {formatCount(timedShots)} shot{timedShots === 1 ? '' : 's'}</button>
        <span className="text-port-text-muted">Their whole journey, stays and travel along the world's paths, played at real time; shots then catch moments of it.</span>
      </div>
    );
  }
  const actors = nightActorsAt(project, world, places, watchMin).map((actor) => ({ ...actor, color: colors[actor.subjectId]?.figure.hex || '#cccccc' }));
  const endClock = nightClockAt(night, night.lengthMin);
  return (
    <div className="min-w-0 space-y-2 text-xs">
      <fieldset disabled={locked} className="flex min-w-0 flex-wrap items-center gap-2">
        <legend className="sr-only">Night clock</legend>
        <label className="flex items-center gap-1" htmlFor="night-start">
          <span className="text-port-text-muted">Starts</span>
          <input id="night-start" type="time" className={selectCls} value={toTimeValue(night.startClock)}
            onChange={(event) => { const clock = fromTimeValue(event.target.value); if (clock !== null) onSave({ ...night, startClock: clock }); }} />
        </label>
        <label className="flex items-center gap-1" htmlFor="night-hours">
          <span className="text-port-text-muted">Lasts</span>
          <select id="night-hours" className={selectCls} value={Math.min(24, Math.max(1, Math.round(night.lengthMin / 60)))}
            onChange={(event) => onSave({ ...night, lengthMin: Math.max(Number(event.target.value) * 60, ...night.beats.map((entry) => entry.endMin)) })}>
            {HOURS.map((h) => <option key={h} value={h}>{h} h</option>)}
          </select>
        </label>
        <span className="text-port-text-muted">until {worldClockText(endClock)} · {formatCount(night.beats.length)} beat{night.beats.length === 1 ? '' : 's'}</span>
        {unplaced > 0 && <button type="button" className={buttonCls} onClick={placeShots}><Clapperboard size={12} aria-hidden="true" /> Place {formatCount(unplaced)} shot{unplaced === 1 ? '' : 's'} on the night</button>}
        <button type="button" className={buttonCls} disabled={night.beats.length >= NIGHT_BEATS_MAX} onClick={addBeat}><Plus size={12} aria-hidden="true" /> Add beat</button>
        {confirmRedraft
          ? <ConfirmButtonPair prompt="Redraft the night from the shots? Beat edits are replaced." confirmText="Redraft" largeTouchTargets
              onConfirm={() => { setConfirmRedraft(false); draft({ startClock: night.startClock, lengthMin: night.lengthMin }); }} onCancel={() => setConfirmRedraft(false)} />
          : <button type="button" className={buttonCls} onClick={() => setConfirmRedraft(true)}><RefreshCw size={12} aria-hidden="true" /> Redraft from shots</button>}
        <button type="button" className={buttonCls} onClick={() => { select(''); onSave(null); }}><Trash2 size={12} aria-hidden="true" /> Remove night</button>
      </fieldset>
      <NightStrip night={night} characters={characters} colors={colors} setName={setName} selected={selected} watchMin={watchMin} onSelect={select} />
      {beat && (
        <fieldset disabled={locked} className="min-w-0">
          <legend className="sr-only">Selected beat</legend>
          <BeatEditor project={project} world={world} night={night} beat={beat} characters={characters} setName={setName}
            onChange={editBeat} onRemove={() => { select(''); onSave({ ...night, beats: night.beats.filter((entry) => entry.id !== beat.id) }); }} />
        </fieldset>
      )}
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className={buttonCls} aria-label={playing ? 'Pause the night' : 'Watch the night'}
          onClick={() => { if (!playing && watchMin >= night.lengthMin) setWatchMin(0); setPlaying(!playing); }}>
          {playing ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
          {playing ? 'Pause' : 'Watch'}
        </button>
        <input type="range" aria-label="Story time" className="min-w-0 flex-1" min="0" max={night.lengthMin} step="1" value={watchMin}
          onChange={(event) => { setPlaying(false); setWatchMin(Number(event.target.value)); }} />
        <span className="w-24 shrink-0 text-right tabular-nums text-port-text">{worldClockText(nightClockAt(night, watchMin))} · {durationText(watchMin)}</span>
      </div>
      <div className="max-w-xl">
        <WorldMap world={world} places={places} view={view} onView={setView} actors={actors} />
      </div>
    </div>
  );
}
