import { useMemo } from 'react';
import { Copy } from 'lucide-react';
import Drawer from '../Drawer';
import { copyToClipboard } from '../../lib/clipboard';
import { formatTimecode } from '../../utils/formatters';
import { STORYBOARD_DEFAULT_HOLD_SEC, storyboardSongBriefText, storyboardSongSections } from '../../../../server/lib/storyboardSongBrief.js';

/**
 * Song brief: the beats as a song map (section, target length, energy, mood,
 * lyric theme) to write or generate the song from. Built from the board on
 * the spot, with no model call; Copy puts the paste-ready text on the
 * clipboard for Suno or the Music Designer.
 */
export default function SongBriefDrawer({ open, board, onClose }) {
  const sections = useMemo(() => storyboardSongSections(board), [board]);
  const total = sections.reduce((sum, section) => sum + section.seconds, 0);

  return (
    <Drawer open={open} onClose={onClose} title="Song brief" subtitle={board.name} size="md" closeLabel="Close song brief">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-xs text-gray-400">
            About <span className="tabular-nums">{formatTimecode(total)}</span> across {sections.length} section{sections.length === 1 ? '' : 's'}.
            {sections.some((section) => section.estimated) && ` ~ marks a section with panels that have no seconds yet; each counts ${STORYBOARD_DEFAULT_HOLD_SEC} s, as Play holds it.`}
          </p>
          <button type="button" onClick={() => copyToClipboard(storyboardSongBriefText(board), 'Song brief copied')} disabled={!sections.length}
            className="min-h-[44px] inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-port-accent/50 bg-port-accent/20 px-3 text-sm text-white disabled:opacity-40">
            <Copy size={16} aria-hidden="true" /> Copy
          </button>
        </div>
        {!sections.length ? (
          <p className="text-sm text-gray-400">Add beats first; each beat becomes a section of the song.</p>
        ) : (
          <ol className="space-y-2" aria-label="Song sections">
            {sections.map((section, index) => (
              <li key={section.beatId} className="rounded-lg border border-port-border p-2 text-xs text-gray-400 space-y-0.5">
                <p className="flex items-baseline gap-2 text-sm text-white">
                  <span>{index + 1}. {section.label}</span>
                  <span className="text-[11px] text-gray-400 tabular-nums">{section.estimated ? '~' : ''}{formatTimecode(section.seconds)}</span>
                  {section.energy && <span className="ml-auto text-[11px] text-gray-400">{section.energy} energy</span>}
                </p>
                {section.title && section.title !== section.theme && <p>Beat: {section.title}</p>}
                {section.mood && <p>Mood: {section.mood}</p>}
                {section.theme && <p>Lyric theme: {section.theme}</p>}
                {section.sectionHint && <p>Note: {section.sectionHint}</p>}
                {section.lines.length > 0 && <p>Lines: {section.lines.join(' / ')}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Drawer>
  );
}
