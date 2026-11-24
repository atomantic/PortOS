import { useState } from 'react';
import { Plus, Trash2, Mic, BadgeCheck } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../../lib/bibleLimits';
import useFieldDraft from '../../../hooks/useFieldDraft';
import { REL_INPUT_CLASS, REL_SELECT_CLASS } from './editorClasses';
import BoxedSection from './BoxedSection';
import DraftNumber from '../../ui/DraftNumber';

const VOICE_SOURCE_POLICIES = Object.freeze(['designed', 'consented-performance', 'licensed']);

const splitProductionTerms = (value, max, itemMax) => value
  .split(',')
  .map((item) => item.trim().slice(0, itemMax))
  .filter(Boolean)
  .slice(0, max);

function VoiceCanonPronunciationRow({ row, idx, onChange, onRemove, disabled }) {
  const term = useFieldDraft(row.term || '', (value) => onChange({ term: value }));
  const pronunciation = useFieldDraft(row.pronunciation || '', (value) => onChange({ pronunciation: value }));
  return (
    <div className="flex items-start gap-1.5">
      <input
        type="text" value={term.value} onChange={term.onChange} onBlur={term.onBlur}
        maxLength={L.VOICE_CANON_PRONUNCIATION_TERM_MAX} placeholder="term"
        disabled={disabled} aria-label={`pronunciation ${idx + 1} term`}
        className={REL_SELECT_CLASS}
      />
      <input
        type="text" value={pronunciation.value} onChange={pronunciation.onChange} onBlur={pronunciation.onBlur}
        maxLength={L.VOICE_CANON_PRONUNCIATION_VALUE_MAX} placeholder="how it is said"
        disabled={disabled} aria-label={`pronunciation ${idx + 1} pronunciation`}
        className={REL_SELECT_CLASS}
      />
      <button
        type="button" onClick={onRemove} disabled={disabled}
        title="Remove pronunciation" aria-label={`remove pronunciation ${idx + 1}`}
        className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 text-gray-500 hover:text-port-error disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export default function VoiceCanonSection({ entry, onPatch, disabled }) {
  const canon = entry.voiceCanon || {};
  const [newPronunciation, setNewPronunciation] = useState({ term: '', pronunciation: '' });
  const commit = (patch) => {
    const approvalPatch = Object.hasOwn(patch, 'approved') ? {} : { approved: false };
    onPatch?.({
      voiceCanon: { version: 1, ...canon, ...patch, ...approvalPatch },
    });
  };
  const description = useFieldDraft(canon.description || '', (value) => commit({ description: value }));
  const delivery = useFieldDraft(canon.defaultDelivery || '', (value) => commit({ defaultDelivery: value }));
  const emotionalRange = useFieldDraft((canon.emotionalRange || []).join(', '), (value) => commit({
    emotionalRange: splitProductionTerms(value, L.VOICE_CANON_RANGE_MAX, L.VOICE_CANON_RANGE_ITEM_MAX),
  }));
  const avoid = useFieldDraft((canon.avoid || []).join(', '), (value) => commit({
    avoid: splitProductionTerms(value, L.VOICE_CANON_AVOID_MAX, L.VOICE_CANON_AVOID_ITEM_MAX),
  }));
  const pronunciations = Array.isArray(canon.pronunciations) ? canon.pronunciations : [];
  const newTerm = newPronunciation.term.trim();
  const newValue = newPronunciation.pronunciation.trim();
  const addPronunciation = () => {
    if (!newTerm || !newValue) return;
    commit({ pronunciations: [...pronunciations, { term: newTerm, pronunciation: newValue }] });
    setNewPronunciation({ term: '', pronunciation: '' });
  };
  const approved = canon.approved === true;
  return (
    <BoxedSection icon={Mic} label="Voice canon" summary={approved ? `v${canon.version || 1} approved` : 'candidate'}>
      <p className="text-[10px] leading-snug text-gray-500">
        Portable performance direction only. Local profiles, recordings, providers, and model artifacts stay machine-local.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <label htmlFor={`voice-canon-version-${entry.id}`} className="block text-[10px] uppercase tracking-wider text-gray-500">Revision</label>
          <DraftNumber integer min={1} max={L.VOICE_CANON_VERSION_MAX} value={canon.version || 1} onCommit={(version) => commit({ version })}>
            {(field) => <input type="number" id={`voice-canon-version-${entry.id}`} disabled={disabled} className={REL_INPUT_CLASS} {...field} />}
          </DraftNumber>
        </div>
        <div>
          <label htmlFor={`voice-canon-source-${entry.id}`} className="block text-[10px] uppercase tracking-wider text-gray-500">Source policy</label>
          <select
            id={`voice-canon-source-${entry.id}`} value={canon.sourcePolicy || ''}
            onChange={(e) => commit({ sourcePolicy: e.target.value || null })} disabled={disabled}
            className={REL_INPUT_CLASS}
          >
            <option value="">— unset —</option>
            {VOICE_SOURCE_POLICIES.map((policy) => <option key={policy} value={policy}>{policy}</option>)}
          </select>
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-gray-300">
        <input type="checkbox" checked={approved} onChange={(e) => commit({ approved: e.target.checked })} disabled={disabled} />
        <BadgeCheck size={12} className={approved ? 'text-port-success' : 'text-gray-500'} />
        {approved ? 'Approved revision' : 'Candidate revision'}
      </label>
      <textarea
        value={description.value} onChange={description.onChange} onBlur={description.onBlur}
        placeholder="Voice description: timbre, texture, breath, and register"
        maxLength={L.VOICE_CANON_DESCRIPTION_MAX} disabled={disabled} rows={2}
        aria-label="voice canon description" className={REL_INPUT_CLASS}
      />
      <textarea
        value={delivery.value} onChange={delivery.onChange} onBlur={delivery.onBlur}
        placeholder="Default delivery: pacing, pauses, energy, and distance"
        maxLength={L.VOICE_CANON_DELIVERY_MAX} disabled={disabled} rows={2}
        aria-label="voice canon default delivery" className={REL_INPUT_CLASS}
      />
      <input
        type="text" value={emotionalRange.value} onChange={emotionalRange.onChange} onBlur={emotionalRange.onBlur}
        placeholder="Emotional range, comma-separated" maxLength={L.VOICE_CANON_RANGE_MAX * L.VOICE_CANON_RANGE_ITEM_MAX}
        disabled={disabled} aria-label="voice canon emotional range" className={REL_INPUT_CLASS}
      />
      <input
        type="text" value={avoid.value} onChange={avoid.onChange} onBlur={avoid.onBlur}
        placeholder="Avoid in delivery, comma-separated" maxLength={L.VOICE_CANON_AVOID_MAX * L.VOICE_CANON_AVOID_ITEM_MAX}
        disabled={disabled} aria-label="voice canon avoid" className={REL_INPUT_CLASS}
      />
      <div className="space-y-1">
        <span className="block text-[10px] uppercase tracking-wider text-gray-500">Pronunciations</span>
        {pronunciations.map((row, idx) => (
          <VoiceCanonPronunciationRow
            key={idx} row={row} idx={idx} disabled={disabled}
            onChange={(patch) => commit({ pronunciations: pronunciations.map((item, i) => i === idx ? { ...item, ...patch } : item) })}
            onRemove={() => commit({ pronunciations: pronunciations.filter((_, i) => i !== idx) })}
          />
        ))}
        <div className="flex items-start gap-1.5">
          <input
            type="text" value={newPronunciation.term}
            onChange={(e) => setNewPronunciation((current) => ({ ...current, term: e.target.value }))}
            maxLength={L.VOICE_CANON_PRONUNCIATION_TERM_MAX} placeholder="new term"
            disabled={disabled} aria-label="new pronunciation term" className={REL_SELECT_CLASS}
          />
          <input
            type="text" value={newPronunciation.pronunciation}
            onChange={(e) => setNewPronunciation((current) => ({ ...current, pronunciation: e.target.value }))}
            maxLength={L.VOICE_CANON_PRONUNCIATION_VALUE_MAX} placeholder="how it is said"
            disabled={disabled} aria-label="new pronunciation value" className={REL_SELECT_CLASS}
          />
        </div>
        <button
          type="button" disabled={disabled || !newTerm || !newValue || pronunciations.length >= L.VOICE_CANON_PRONUNCIATIONS_MAX}
          onClick={addPronunciation}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 rounded border border-port-border text-gray-400 hover:text-white hover:border-gray-500 disabled:opacity-40"
        >
          <Plus size={10} /> Add pronunciation
        </button>
      </div>
    </BoxedSection>
  );
}
