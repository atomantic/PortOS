/** Named graphics on the absolute document clock. No media or provider I/O. */
export const NARRATIVE_EVENT_KINDS = ['reveal', 'impact', 'silence', 'counter-change', 'motif-transformation'];

/** Resolve every anchor once, never relative to an excerpt or a seek. */
export function resolveNarrativeEvents(project, sections, fps = 24) {
  const duration = Math.min(project.audioAnalysis?.durationSec || 0, 900);
  const frames = Math.floor(duration * fps + 1e-6);
  const events = [];
  const unresolved = [];
  for (const event of project.composition?.narrativeEvents || []) {
    const anchor = event.anchor;
    let time = null;
    if (anchor?.kind === 'time') time = anchor.atSec;
    if (anchor?.kind === 'onset') time = project.audioAnalysis?.features?.onsets?.[anchor.band]?.[anchor.index];
    if (anchor?.kind === 'word') {
      const cue = (project.lyricCues || []).find((cue) => cue.id === anchor.cueId);
      time = cue?.words?.[anchor.wordIndex]?.startSec;
    }
    if (!Number.isFinite(time)) { unresolved.push(event.id); continue; }
    time += anchor.offsetSec || 0;
    const startFrame = Math.ceil(time * fps - 1e-6);
    if (startFrame < 0 || startFrame >= frames) { unresolved.push(event.id); continue; }
    const endFrame = Math.min(frames, startFrame + Math.max(1, Math.ceil(event.durationSec * fps - 1e-6)));
    const section = sections.find((section) => startFrame / fps >= section.startSec && startFrame / fps < section.endSec);
    events.push({ ...event, startFrame, endFrame, startSec: startFrame / fps, endSec: endFrame / fps, sectionId: section?.id || null });
  }
  return { events: events.sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)), unresolved };
}

/** Self-contained: embedded verbatim in both the preview and render pages. */
export function narrativeFrameState(song, time, fps) {
  const frame = Math.max(0, Math.floor(time * fps + 1e-6));
  const events = song.narrativeEvents || [];
  let holdFrame = null;
  let holdEnd = -1;
  let holdStart = -1;
  for (const event of events.filter((event) => event.kind === 'silence')) {
    if (event.startFrame > holdEnd) { holdStart = event.startFrame; holdEnd = event.endFrame; }
    else holdEnd = Math.max(holdEnd, event.endFrame);
    if (frame >= holdStart && frame < holdEnd) holdFrame = holdStart;
  }
  const drawFrame = holdFrame ?? frame;
  const t = drawFrame / fps;
  const section = (song.sections || []).find((section) => t >= section.startSec && t < section.endSec);
  const reactive = (song.reactiveSections || []).find((entry) => entry.sectionId === section?.id);
  const gain = reactive?.gain ?? 0.25;
  const maxGain = reactive?.maxGain ?? 0.35;
  const envelope = song.features?.envelopes;
  const level = envelope?.rms?.[Math.floor(t * envelope.fps)] ?? 0;
  const reactiveGain = holdFrame != null ? 0 : Math.max(0, Math.min(maxGain, level * gain));
  const activeEvents = events.filter((event) => event.kind !== 'silence' && drawFrame >= event.startFrame && drawFrame < event.endFrame)
    .map((event) => {
      const progress = Math.min(1, (drawFrame - event.startFrame) / Math.max(1, event.endFrame - event.startFrame - 1));
      return { ...event, progress, value: (event.fromValue ?? 0) + ((event.toValue ?? 1) - (event.fromValue ?? 0)) * progress };
    });
  return { frame: drawFrame, t, hold: holdFrame != null, reactiveGain, activeEvents };
}
