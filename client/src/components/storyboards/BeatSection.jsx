import { useState } from 'react';
import { ChevronDown, ChevronUp, Pin, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { STORYBOARD_LIMITS, STORYBOARD_MUSICAL_ROLES } from '../../../../server/lib/storyboardVocabulary.js';
import { formatTimecode } from '../../utils/formatters';
import CommitField from './CommitField';
import PanelCard from './PanelCard';
import { beatSeconds, MUSICAL_ROLE_LABELS } from './storyboardArt';

const iconButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-30 disabled:pointer-events-none';

/**
 * One story beat: its title and musical role, its panels (a horizontal strip,
 * or with `grid` a storyboard sheet that wraps), and (behind the sliders
 * toggle) what happens, why it matters, and the emotion — the brief the song
 * gets written from. An opening beat can play before the song starts (a
 * music video's cold open, `canPlayBeforeSong`): then it has no song marker.
 * On a music video's board (`spanOf`, each panel's place on the song) the
 * beat shows where it starts and each panel when it plays and what is sung.
 */
export default function BeatSection({
  beat, beatIndex, beatCount, firstPanelNumber, aspectRatio, selectedPanelId, sketchNonce,
  onUpdate, onMove, onDelete, onAddPanel, onOpenPanel, addingPanel = false, pinOptions = [], grid = false,
  canPlayBeforeSong = false, spanOf = null,
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const seconds = beatSeconds(beat);
  const firstSpan = spanOf && beat.panels.length ? spanOf(beat.panels[0].id) : null;
  const fieldId = (name) => `beat-${beat.id}-${name}`;
  const itemClass = grid ? 'min-w-0' : 'snap-start shrink-0 w-36 sm:w-44';
  const beforeSong = beat.beforeSong === true;
  const pin = beat.pin && !beforeSong ? pinOptions.find((option) => option.id === beat.pin) : null;

  return (
    <section className={`${grid ? '@container ' : ''}rounded-xl border border-port-border bg-port-card/60`} aria-label={beat.title || `Beat ${beatIndex + 1}`}>
      {confirmDelete ? (
        <InlineConfirmRow
          variant="separator"
          question={`Delete this beat and its ${beat.panels.length} panel${beat.panels.length === 1 ? '' : 's'}?`}
          onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          onCancel={() => setConfirmDelete(false)}
          autoFocus
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-2">
        <span className="text-xs font-semibold text-gray-500 tabular-nums w-6 text-center">{beatIndex + 1}</span>
        <div className="flex-1 min-w-[10rem]">
          <CommitField
            id={fieldId('title')}
            value={beat.title}
            maxLength={STORYBOARD_LIMITS.beatTitle}
            placeholder="Beat title"
            ariaLabel="Beat title"
            onCommit={(title) => onUpdate({ title })}
            className="font-medium"
          />
        </div>
        <label htmlFor={fieldId('role')} className="sr-only">Musical role</label>
        <select
          id={fieldId('role')}
          value={beat.musicalRole || ''}
          onChange={(event) => onUpdate({ musicalRole: event.target.value || null })}
          className="min-h-[44px] bg-port-bg border border-port-border rounded px-2 text-sm text-white"
        >
          <option value="">No section</option>
          {STORYBOARD_MUSICAL_ROLES.map((role) => <option key={role} value={role}>{MUSICAL_ROLE_LABELS[role] || role}</option>)}
        </select>
        {firstSpan && !firstSpan.beforeSong ? (
          <span className="text-xs text-gray-500 tabular-nums" title="Where this beat starts on the song, and its length">
            {formatTimecode(firstSpan.startSec)} · {formatTimecode(seconds)}
          </span>
        ) : (
          <span className="text-xs text-gray-500 tabular-nums" title="Estimated length of this beat">{formatTimecode(seconds)}</span>
        )}
        {(beforeSong || canPlayBeforeSong) && (
          <button type="button" role="switch" aria-checked={beforeSong} onClick={() => onUpdate({ beforeSong: !beforeSong })}
            className={`min-h-[44px] inline-flex items-center rounded border px-2 text-xs sm:min-h-[28px] ${beforeSong ? 'border-port-accent text-port-accent' : 'border-port-border text-gray-400 hover:text-white'}`}>
            Before the song
          </button>
        )}
        {pin && (
          <span className="inline-flex max-w-[12rem] items-center gap-1 text-[11px] text-port-accent" title={`Starts at ${pin.label}`}>
            <Pin size={12} aria-hidden="true" /><span className="truncate">{pin.label}</span>
          </span>
        )}
        <div className="flex items-center ml-auto">
          <button type="button" className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconButton} ${showDetails ? 'text-port-accent' : ''}`} onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails} aria-controls={fieldId('details')} aria-label="Beat details">
            <SlidersHorizontal size={16} />
          </button>
          <button type="button" className={iconButton} onClick={() => onMove(beatIndex - 1)} disabled={beatIndex === 0} aria-label="Move beat up">
            <ChevronUp size={16} />
          </button>
          <button type="button" className={iconButton} onClick={() => onMove(beatIndex + 1)} disabled={beatIndex >= beatCount - 1} aria-label="Move beat down">
            <ChevronDown size={16} />
          </button>
          <button type="button" className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconButton} hover:text-port-error`} onClick={() => setConfirmDelete(true)} aria-label="Delete beat">
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      {showDetails ? (
        <div id={fieldId('details')} className="grid gap-2 px-2 pt-2 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId('what')} className="block text-[11px] text-gray-500 mb-0.5">What happens</label>
            <CommitField id={fieldId('what')} multiline value={beat.what} maxLength={STORYBOARD_LIMITS.beatText} onCommit={(what) => onUpdate({ what })} />
          </div>
          <div>
            <label htmlFor={fieldId('why')} className="block text-[11px] text-gray-500 mb-0.5">Why it matters</label>
            <CommitField id={fieldId('why')} multiline value={beat.why} maxLength={STORYBOARD_LIMITS.beatText} onCommit={(why) => onUpdate({ why })} />
          </div>
          <div>
            <label htmlFor={fieldId('emotion')} className="block text-[11px] text-gray-500 mb-0.5">Emotion</label>
            <CommitField id={fieldId('emotion')} value={beat.emotion} maxLength={STORYBOARD_LIMITS.emotion} onCommit={(emotion) => onUpdate({ emotion })} />
          </div>
          <div>
            <label htmlFor={fieldId('section')} className="block text-[11px] text-gray-500 mb-0.5">Song section note</label>
            <CommitField id={fieldId('section')} value={beat.sectionHint} maxLength={STORYBOARD_LIMITS.sectionHint} placeholder="e.g. first chorus, half-time" onCommit={(sectionHint) => onUpdate({ sectionHint })} />
          </div>
          {pinOptions.length > 0 && !beforeSong && (
            <div className="sm:col-span-2">
              <label htmlFor={fieldId('pin')} className="block text-[11px] text-gray-500 mb-0.5">Starts at (temp track)</label>
              <select id={fieldId('pin')} value={beat.pin || ''} onChange={(event) => onUpdate({ pin: event.target.value || null })}
                className="min-h-[44px] w-full bg-port-bg border border-port-border rounded px-2 text-sm text-white">
                <option value="">Not pinned: follows the beat before it</option>
                {pinOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
          )}
        </div>
      ) : null}

      <ol className={grid ? 'grid grid-cols-2 items-start gap-2 p-2 @2xl:grid-cols-3 @5xl:grid-cols-4' : 'flex gap-2 overflow-x-auto overscroll-x-contain snap-x p-2'} aria-label="Panels">
        {beat.panels.map((panel, index) => (
          <li key={panel.id} className={itemClass}>
            <PanelCard
              panel={panel}
              number={firstPanelNumber + index}
              aspectRatio={aspectRatio}
              selected={panel.id === selectedPanelId}
              sketchNonce={sketchNonce}
              onOpen={() => onOpenPanel(panel.id)}
              span={spanOf?.(panel.id) || null}
            />
          </li>
        ))}
        <li className={itemClass}>
          <button
            type="button"
            onClick={onAddPanel}
            disabled={addingPanel}
            className={`w-full h-full min-h-[5rem] rounded-lg border border-dashed border-port-border text-gray-400 hover:text-white hover:border-port-accent/60 inline-flex flex-col items-center justify-center gap-1 text-xs disabled:opacity-50`}
          >
            <Plus size={18} aria-hidden="true" />
            Panel
          </button>
        </li>
      </ol>
    </section>
  );
}
