import { MUSIC_VIDEO_GRADE_PRESETS, MUSIC_VIDEO_GRADE_DEFAULT_GRAIN } from '../../lib/musicVideoGrade.js';
import { compositionDraft } from './compositionDraft.js';

const LABELS = { neutral: 'Neutral (no effect)', 'teal-night': 'Teal night', 'golden-hour': 'Golden hour', monochrome: 'Monochrome' };
const inputCls = 'min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1 text-sm';
const options = MUSIC_VIDEO_GRADE_PRESETS.map((preset) => <option key={preset} value={preset}>{LABELS[preset]}</option>);

/** Explicit render-time looks; no provider calls or changes to generated assets. */
export default function GradePanel({ project, onSave }) {
  const composition = compositionDraft(project);
  if (!['composed', 'document'].includes(composition.mode)) return null;
  const grade = composition.grade || { preset: 'neutral', grain: MUSIC_VIDEO_GRADE_DEFAULT_GRAIN, sections: [] };
  const save = (patch) => {
    const update = { composition: { ...composition, grade: { ...grade, ...patch } } };
    onSave(update);
  };
  const setSection = (sceneId, preset) => save({ sections: [
    ...(grade.sections || []).filter((section) => section.sceneId !== sceneId),
    ...(preset ? [{ sceneId, preset }] : []),
  ] });
  return (
    <section aria-label="Render grade" className="space-y-2 border-t border-port-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Render grade</h3>
        <button type="button" className="min-h-[44px] text-xs text-port-accent"
          onClick={() => save({ preset: 'neutral', sections: [] })}>Reset grades to neutral</button>
      </div>
      <p className="text-xs text-port-text-muted">Opt-in color curves and repeatable grain on composed and document exports. Source footage stays unchanged. Render an excerpt to review the grade; the live document preview is ungraded.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor="mv-grade-preset" className="text-xs text-port-text-muted">Default section look</label>
          <select id="mv-grade-preset" className={inputCls} value={grade.preset || 'neutral'} onChange={(event) => save({ preset: event.target.value })}>{options}</select>
        </div>
        <div>
          <label htmlFor="mv-grade-grain" className="text-xs text-port-text-muted">Grain</label>
          <select id="mv-grade-grain" className={inputCls} value={grade.grain ?? MUSIC_VIDEO_GRADE_DEFAULT_GRAIN} onChange={(event) => save({ grain: Number(event.target.value) })}>
            <option value={0}>None</option><option value={MUSIC_VIDEO_GRADE_DEFAULT_GRAIN}>Fine</option><option value={0.03}>Strong</option>
            {grade.grain != null && ![0, MUSIC_VIDEO_GRADE_DEFAULT_GRAIN, 0.03].includes(grade.grain) && <option value={grade.grain}>Custom</option>}
          </select>
        </div>
      </div>
      <div className="max-h-60 space-y-2 overflow-y-auto">
        {(project.scenes || []).map((scene) => (
          <div key={scene.sceneId}>
            <label htmlFor={`mv-grade-${scene.sceneId}`} className="text-xs text-port-text-muted">{scene.label || scene.sectionLabel || 'Untitled section'}</label>
            <select id={`mv-grade-${scene.sceneId}`} className={inputCls}
              value={(grade.sections || []).find((section) => section.sceneId === scene.sceneId)?.preset ?? ''}
              onChange={(event) => setSection(scene.sceneId, event.target.value)}>
              <option value="">Default section look</option>{options}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}
