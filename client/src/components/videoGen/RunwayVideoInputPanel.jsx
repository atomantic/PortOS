import { RUNWAY_ACT_TWO_RATIOS, RUNWAY_ALEPH_ASPECTS } from '../../../../server/lib/runwaySpecialVideoModels.js';

/** Inputs owned by the page's form state; switching modes clears their distinct meanings. */
export default function RunwayVideoInputPanel({ mode, value, onChange }) {
  const performance = mode === 'character-performance';
  const change = (key, next) => onChange({ ...value, [key]: next });
  return <div className="col-span-2 space-y-3 text-sm">
    <label className="block">{performance ? 'Performance video' : 'Source video'}
      <input type="file" accept="video/*" className="block w-full mt-1" onChange={(e) => change('video', e.target.files?.[0] || null)} />
    </label>
    <p className="text-xs text-port-text-muted">{performance ? 'Use a 3–30 second performance with a visible face. Choose a character image below or a character video here.' : 'Use a 2–30 second video at 30 FPS or lower. An optional guidance image below anchors the edit at the beginning.'} Videos must be 512 bytes–200 MB. Files are uploaded privately to Runway when the job starts; uploads expire after 24 hours.</p>
    {performance ? <>
      <label className="block">Character video (instead of an image)
        <input type="file" accept="video/*" className="block w-full mt-1" onChange={(e) => change('characterVideo', e.target.files?.[0] || null)} />
      </label>
      <label className="block">Output canvas
        <select value={value.ratio || ''} onChange={(e) => change('ratio', e.target.value)} className="block bg-port-bg border border-port-border rounded p-2">
          <option value="">Runway default</option>{RUNWAY_ACT_TWO_RATIOS.map((r) => <option key={r} value={r}>{r.replace(':', ' × ')}</option>)}
        </select>
      </label>
      <label className="flex gap-2"><input type="checkbox" checked={value.bodyControl ?? true} onChange={(e) => change('bodyControl', e.target.checked)} />Apply body movements and gestures</label>
      <label className="block">Expression intensity
        <input type="number" min="1" max="5" step="1" value={value.expressionIntensity ?? 3} onChange={(e) => change('expressionIntensity', Number(e.target.value))} className="block bg-port-bg border border-port-border rounded p-2" />
      </label>
      <p className="text-xs text-port-text-muted">Act-Two follows the performance, including its audio; it does not accept a text prompt.</p>
    </> : <label className="block">Expand aspect ratio
      <select value={value.targetAspectRatio || ''} onChange={(e) => change('targetAspectRatio', e.target.value)} className="block bg-port-bg border border-port-border rounded p-2">
        <option value="">Preserve source framing</option>{RUNWAY_ALEPH_ASPECTS.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
    </label>}
    <label className="block">Runway seed (optional)
      <input type="number" min="0" max="4294967295" step="1" value={value.seed ?? ''} onChange={(e) => change('seed', e.target.value)} className="block bg-port-bg border border-port-border rounded p-2" />
    </label>
  </div>;
}
