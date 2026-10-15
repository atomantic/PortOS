import { MUSIC_VIDEO_LYRIC_ROLES, MUSIC_VIDEO_LYRIC_SIZES } from '../../lib/musicVideoLayers.js';

// The lyric spots in reading order: the top row, the middle, the bottom row, then none.
const ZONES = [
  ['upper-left', 'Top left'], ['upper', 'Top'], ['upper-right', 'Top right'], ['center', 'Centre'],
  ['lower-left', 'Bottom left'], ['lower', 'Bottom'], ['lower-right', 'Bottom right'], ['none', 'No lyrics'],
];
const ROLE_LABELS = { line: 'Sung line', hook: 'Hook slam', stamp: 'Stamp', data: 'Data caption' };
const SIZE_LABELS = { small: 'Small', large: 'Large' };
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 min-h-[44px] sm:min-h-0';

/**
 * Where the lyrics sung over a shot sit, their style and size. The player and
 * the final render both draw them this way; Auto keeps the lyric sheet's choice.
 */
export default function SceneLyricType({ fieldId, scene, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor={fieldId('text-zone')} className="font-medium">Lyrics</label>
      <select id={fieldId('text-zone')} value={scene.textZone || ''} onChange={(e) => onChange({ textZone: e.target.value || null })}
        title="Where the lyrics sit in this shot, so they stay off the subject" className={SELECT}>
        <option value="">Auto spot</option>
        {ZONES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
      {scene.textZone !== 'none' && (
        <>
          <label htmlFor={fieldId('lyric-role')} className="sr-only">Lyric style</label>
          <select id={fieldId('lyric-role')} value={scene.lyricRole || ''} onChange={(e) => onChange({ lyricRole: e.target.value || null })}
            title="The style of the lines sung over this shot" className={SELECT}>
            <option value="">Auto style</option>
            {MUSIC_VIDEO_LYRIC_ROLES.map((value) => <option key={value} value={value}>{ROLE_LABELS[value]}</option>)}
          </select>
          <label htmlFor={fieldId('lyric-size')} className="sr-only">Lyric size</label>
          <select id={fieldId('lyric-size')} value={scene.lyricSize || ''} onChange={(e) => onChange({ lyricSize: e.target.value || null })}
            title="The lyric size over this shot" className={SELECT}>
            <option value="">Normal size</option>
            {MUSIC_VIDEO_LYRIC_SIZES.map((value) => <option key={value} value={value}>{SIZE_LABELS[value]}</option>)}
          </select>
        </>
      )}
    </div>
  );
}
