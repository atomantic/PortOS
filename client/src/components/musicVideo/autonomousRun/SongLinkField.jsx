import { inputClass } from '../controlClasses.js';

export default function SongLinkField({ song }) {
  return (
    <div>
      <label htmlFor="mv-run-song-link" className="block text-xs text-port-text-muted mb-1">
        {song.canAdopt ? 'Suno song link or ID' : 'Or a version you made or revised in Suno (paste its link)'}
      </label>
      <input
        id="mv-run-song-link"
        type="text"
        value={song.linkText}
        onChange={(e) => song.setLinkText(e.target.value)}
        placeholder="https://suno.com/song/…"
        className={`${inputClass} text-xs`}
      />
      {song.invalidLink && <p className="text-xs text-port-error mt-1">Enter a Suno song link or ID.</p>}
    </div>
  );
}
