import { MUSIC_VIDEO_MEDIA_MODES, MUSIC_VIDEO_MEDIA_MODE_LABELS } from '../../../../server/lib/musicVideoMediaPolicy.js';

export default function MediaModePicker({ value = 'code-images-video', onChange, disabled = false, id = 'mv-media-mode' }) {
  return <div className="min-w-0 space-y-1">
    <label htmlFor={id} className="block text-xs text-port-text-muted">Design and composition media</label>
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="max-w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm">
      {MUSIC_VIDEO_MEDIA_MODES.map((mode) => <option key={mode} value={mode}>{MUSIC_VIDEO_MEDIA_MODE_LABELS[mode]}</option>)}
    </select>
    <p className="text-xs text-port-text-muted">Code authors the world, characters, camera, typography and timing. Code only excludes imported or generated images and video, including planning guides. Audio and local fonts remain available. Tool choices and budgets still constrain generation.</p>
  </div>;
}
