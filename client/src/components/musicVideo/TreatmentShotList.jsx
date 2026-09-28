import useFieldDraft from '../../hooks/useFieldDraft.js';
import { formatTimecode } from '../../utils/formatters.js';

const MODES = ['performance', 'cutaway', 'graphic'];
const ROUTES = [['generated', 'Generated'], ['supplied-asset', 'Supplied asset'], ['code-2d', 'Title card / still']];
const REGIONS = [['none', 'No text region'], ['upper', 'Upper third'], ['center', 'Center'], ['lower', 'Lower third']];
const TYPE_ROLES = [['none', 'No text'], ['subtitle', 'Subtitle'], ['hero', 'Hero title']];
const cellCls = 'w-full bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs';

function DirectionText({ id, label, value, maxLength, onCommit }) {
  const draft = useFieldDraft(value, onCommit);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[10px] text-port-text-muted">{label}</label>
      <input id={id} value={draft.value} onChange={draft.onChange} onBlur={draft.onBlur} maxLength={maxLength} className={cellCls} />
    </div>
  );
}

function DirectionSelect({ id, label, value, options, onChange }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[10px] text-port-text-muted">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cellCls}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  );
}

/**
 * Per-shot direction (#8980), one row per board scene the treatment maps. Each
 * edit saves just that field for that scene; the scene's own timing stays
 * authoritative (a direction never moves a cut). Nothing reaches the scene's
 * prompts until the director applies the treatment.
 */
export default function TreatmentShotList({ project, treatment, onSave }) {
  const scenes = new Map((project.scenes || []).map((s) => [s.sceneId, s]));
  const beats = new Map((treatment.arc?.beats || []).map((b) => [b.id, b]));
  const save = (sceneId, patch) => onSave({ shotDirections: [{ sceneId, ...patch }] });
  const idFor = (sceneId, field) => `mv-dir-${project.id}-${sceneId}-${field}`;
  return (
    <details className="rounded border border-port-border p-2">
      <summary className="cursor-pointer text-xs text-port-text-muted select-none min-h-[32px] flex items-center">
        Shot direction ({treatment.shotDirections.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {treatment.shotDirections.map((d) => {
          const scene = scenes.get(d.sceneId);
          const beat = beats.get(d.beatId);
          return (
            <li key={d.sceneId} className="rounded border border-port-border/60 p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{scene ? (scene.label || scene.sectionLabel || 'Scene') : 'Deleted scene'}</span>
                {scene?.startSec != null && <span className="text-port-text-muted">{formatTimecode(scene.startSec)}–{formatTimecode(scene.endSec)}</span>}
                {beat && <span className="text-port-text-muted">· {beat.role}</span>}
                {scene?.lyricText ? <span className="text-port-text-muted truncate max-w-[16rem]">· “{scene.lyricText}”</span> : <span className="text-port-text-muted">· instrumental</span>}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-1.5">
                <DirectionSelect id={idFor(d.sceneId, 'mode')} label="Mode" value={d.mode}
                  options={MODES.map((m) => [m, m])} onChange={(mode) => save(d.sceneId, { mode })} />
                <DirectionSelect id={idFor(d.sceneId, 'route')} label="Route" value={d.route}
                  options={ROUTES} onChange={(route) => save(d.sceneId, { route })} />
                <DirectionSelect id={idFor(d.sceneId, 'type')} label="Typography" value={d.typographyRole}
                  options={TYPE_ROLES} onChange={(typographyRole) => save(d.sceneId, { typographyRole })} />
                <DirectionSelect id={idFor(d.sceneId, 'space')} label="Reserved region" value={d.negativeSpace}
                  options={REGIONS} onChange={(negativeSpace) => save(d.sceneId, { negativeSpace })} />
                <DirectionText id={idFor(d.sceneId, 'focal')} label="Focal subject" value={d.focalSubject} maxLength={500}
                  onCommit={(focalSubject) => save(d.sceneId, { focalSubject })} />
                <DirectionText id={idFor(d.sceneId, 'framing')} label="Framing" value={d.framing} maxLength={500}
                  onCommit={(framing) => save(d.sceneId, { framing })} />
                <DirectionText id={idFor(d.sceneId, 'emphasis')} label="Emphasis" value={d.emphasis} maxLength={500}
                  onCommit={(emphasis) => save(d.sceneId, { emphasis })} />
                <DirectionText id={idFor(d.sceneId, 'in')} label="Entry" value={d.transitionIn} maxLength={300}
                  onCommit={(transitionIn) => save(d.sceneId, { transitionIn })} />
                <DirectionText id={idFor(d.sceneId, 'out')} label="Exit" value={d.transitionOut} maxLength={300}
                  onCommit={(transitionOut) => save(d.sceneId, { transitionOut })} />
              </div>
              {d.rationale && <p className="text-[11px] text-port-text-muted">{d.rationale}</p>}
              {d.typographyRole !== 'none' && d.negativeSpace === 'none' && (
                <p className="text-[11px] text-port-warning">Text on this shot has no reserved region — it will sit over the subject.</p>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
