import { CAMERA_FAMILIES, CAMERA_MOVEMENTS, CAMERA_SPEEDS, getCameraMovement } from '../../../../server/lib/cameraMovements.js';

const FIELD = 'bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0';
const BY_FAMILY = CAMERA_FAMILIES.map((family) => [family, CAMERA_MOVEMENTS.filter((move) => move.family === family)])
  .filter(([, moves]) => moves.length);

/**
 * A shot's planned camera move (#10589): one of the shared catalog moves, its
 * speed, whether it lands on the downbeat, and why a still camera holds. The
 * i2v prompt carries it as the four-part camera block and a composed still
 * plays it through the layered camera rig.
 */
export default function SceneCameraControls({ scene, fieldId, onEditLocal, onSave }) {
  const camera = scene.camera && getCameraMovement(scene.camera.move) ? scene.camera : null;
  const move = camera ? getCameraMovement(camera.move) : null;
  const save = (next) => {
    const value = next?.move ? Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v !== undefined && v !== false)) : null;
    onEditLocal(scene.sceneId, { camera: value });
    onSave(scene.sceneId, { camera: value });
  };
  return (
    <div className="flex flex-wrap gap-2 items-center text-xs">
      <label htmlFor={fieldId('camera')}>Camera</label>
      <select id={fieldId('camera')} value={camera?.move || ''} className={FIELD}
        title="The planned camera move. Video prompts describe it as movement, speed, framing and end; composed stills play it."
        onChange={(e) => save(e.target.value ? { ...camera, move: e.target.value, ...(getCameraMovement(e.target.value).still ? {} : { reason: undefined }) } : null)}>
        <option value="">None</option>
        {BY_FAMILY.map(([family, moves]) => (
          <optgroup key={family} label={family}>
            {moves.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </optgroup>
        ))}
      </select>
      {move && (
        <>
          <label htmlFor={fieldId('camera-speed')}>Speed</label>
          <select id={fieldId('camera-speed')} value={camera.speed || ''} className={FIELD}
            onChange={(e) => save({ ...camera, speed: e.target.value || undefined })}>
            <option value="">Default ({move.speed})</option>
            {CAMERA_SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}</option>)}
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={camera.onBeat === true} onChange={(e) => save({ ...camera, onBeat: e.target.checked })} />
            On beat
          </label>
          {move.still && (
            <>
              <label htmlFor={fieldId('camera-reason')}>Why it holds</label>
              <input id={fieldId('camera-reason')} type="text" maxLength={300} value={camera.reason || ''}
                placeholder="The reason for a static camera"
                onChange={(e) => onEditLocal(scene.sceneId, { camera: { ...camera, reason: e.target.value } })}
                onBlur={(e) => save({ ...camera, reason: e.target.value.trim() || undefined })}
                className={`min-w-0 flex-1 basis-40 ${FIELD}`} />
            </>
          )}
        </>
      )}
    </div>
  );
}
