/**
 * CharacterDetailEditor — sectioned form for the extended character fields
 * (pronouns, motivations, stats, color palette, props, expressions, hand
 * gestures, etc.) used by the Universe Builder Cast tab.
 *
 * Mirrors the WardrobeSection draft+blur pattern in CanonCard.jsx: per-field
 * drafts buffered locally and PATCHed on blur (or row mutation) so typing
 * doesn't fire a universe-wide round-trip per keystroke. The parent owns the
 * persisted `entry` and the `onPatch(patch)` write channel — this component
 * only knows the field shape.
 */

import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import { WandSparkles, Loader2, Palette, Hand, Smile, Package, BookOpen, Eye, Activity, Drama, KeyRound, Mic, Images } from 'lucide-react';
import { BIBLE_LIMITS as L } from '../../lib/bibleLimits';
import { formatCount } from '../../utils/formatters';
import { formatHeight, typicalHeightCm } from '../../../../server/lib/characterHeight.js';
import { characterHeightStat } from '../../../../server/lib/catalogAppearance.js';
// Shared narrative-framework definitions (#2175, #6417) — one source of truth
// with the server store/schema and the Writers Room cast editor.
import { CHARACTER_FRAMEWORK_EDITOR_FIELDS, CHARACTER_MOTIVATIONS_FIELD, CHARACTER_SECRETS_FIELD } from '../../lib/characterFramework';
import useFieldDraft from '../../hooks/useFieldDraft';
import VoicePicker from '../voice/VoicePicker';
import TabPills from '../ui/TabPills';
import useDrawerTab from '../../hooks/useDrawerTab';
import { DraftCommitMode } from '../../hooks/useDraftCommitMode';
import BoxedSection from './character/BoxedSection';
import ListSectionEditor from './character/ListSectionEditor';
import ArcFrameworkControls from './character/ArcFrameworkControls';
import RelationshipsSection from './character/RelationshipsSection';
import PsychologySection from './character/PsychologySection';
import IdentityPackSection from './character/IdentityPackSection';
import VoiceCanonSection from './character/VoiceCanonSection';
import VoiceProfileSection from './character/VoiceProfileSection';

const SECTIONS = Object.freeze([
  {
    key: 'identity', label: 'Identity', icon: BookOpen,
    fields: [
      { name: 'pronouns', label: 'Pronouns', placeholder: 'she/her · they/them · it/its', max: L.PRONOUNS_MAX, type: 'input' },
      { name: 'age', label: 'Age', placeholder: '27 · centuries old · unknown', max: L.AGE_MAX, type: 'input' },
      { name: 'coreTheme', label: 'Core theme', placeholder: 'one-sentence essence', max: L.CORE_THEME_MAX, type: 'textarea' },
      { name: 'speechAccent', label: 'Accent', placeholder: 'clipped Edinburgh · Brooklyn drawl · off-world inflection', max: L.SPEECH_ACCENT_MAX, type: 'textarea' },
      { name: 'speechPattern', label: 'Speech pattern', placeholder: 'rarely contracts; nautical metaphors; trails off into ellipses when uncertain', max: L.SPEECH_PATTERN_MAX, type: 'textarea' },
      { name: 'visualNotes', label: 'Visual notes (at-a-glance)', placeholder: 'layered streetwear; faded mustard + charcoal; chunky boots', max: L.VISUAL_NOTES_MAX, type: 'textarea' },
      { name: 'role', label: 'Role / Archetype', max: L.ROLE_MAX, type: 'textarea' },
    ],
  },
  {
    key: 'personality', label: 'Personality & motivations', icon: Smile,
    fields: [
      { name: 'personality', label: 'Personality', max: L.PERSONALITY_MAX, type: 'textarea' },
      { ...CHARACTER_MOTIVATIONS_FIELD, type: 'textarea' },
      { name: 'likes', label: 'Likes', placeholder: 'short prose; comma-separated', max: L.LIKES_MAX, type: 'textarea' },
      { name: 'dislikes', label: 'Dislikes', placeholder: 'short prose; comma-separated', max: L.DISLIKES_MAX, type: 'textarea' },
      { name: 'mannerisms', label: 'Mannerisms', placeholder: 'habitual physical / verbal tics', max: L.MANNERISMS_MAX, type: 'textarea' },
      { name: 'relationships', label: 'Relationships', placeholder: 'who they\'re connected to and the tenor of each connection', max: L.RELATIONSHIPS_MAX, type: 'textarea' },
      { name: 'skills', label: 'Skills', placeholder: 'concrete abilities, soft and hard', max: L.SKILLS_MAX, type: 'textarea' },
    ],
  },
  {
    key: 'framework', label: 'Character framework', icon: Drama,
    // Shared with the Writers Room cast editor (#6417) — same Ghost → Wound →
    // Lie → Need → Want definitions, adapted there onto BibleSection's compact
    // field config instead of being restated.
    fields: CHARACTER_FRAMEWORK_EDITOR_FIELDS.map((f) => ({ ...f, type: 'textarea' })),
  },
  {
    key: 'history', label: 'Background & notes', icon: BookOpen,
    fields: [
      { name: 'background', label: 'Background', max: L.BACKGROUND_MAX, type: 'textarea' },
      { name: 'notes', label: 'Notes', max: L.NOTES_MAX, type: 'textarea' },
    ],
  },
  {
    key: 'visualIdentity', label: 'Visual identity', icon: Eye,
    fields: [
      { name: 'physicalDescription', label: 'Physical Description', max: L.PHYSICAL_DESCRIPTION_MAX, type: 'textarea' },
      { name: 'silhouetteNotes', label: 'Silhouette notes', placeholder: 'compact upper body; tapered lower half; short hair adds 5cm height', max: L.SILHOUETTE_NOTES_MAX, type: 'textarea' },
      { name: 'postureNotes', label: 'Posture notes', placeholder: 'slight forward lean; weight in left foot; shoulders loose', max: L.POSTURE_NOTES_MAX, type: 'textarea' },
      { name: 'specialTraits', label: 'Special traits', placeholder: 'quick hands; scar on right eyebrow; observant', max: L.SPECIAL_TRAITS_MAX, type: 'textarea' },
      { name: 'visualIdentity', label: 'Visual identity (design language)', placeholder: 'knobs + sights; urban utilitarian; analog tech feel', max: L.VISUAL_IDENTITY_MAX, type: 'textarea' },
    ],
  },
]);

// Height lives in the character's "Height" stat (what sheets and renders read);
// this field edits that stat directly so it is not buried in the Stats list.
const HEIGHT_FIELD = Object.freeze({ name: 'height', label: 'Height', max: L.STAT_VALUE_MAX, type: 'input' });
const heightPlaceholder = (age) => {
  const cm = typicalHeightCm(age);
  return cm ? `${formatHeight(cm)}, typical at this age` : '5 ft 7 in (170 cm)';
};
function withHeightStat(stats, value) {
  const list = Array.isArray(stats) ? stats : [];
  const text = String(value || '').trim();
  const at = list.findIndex((stat) => /^\s*height\s*$/i.test(String(stat?.label || '')));
  if (!text) return at < 0 ? list : list.filter((_, i) => i !== at);
  if (at < 0) return [...list, { label: 'Height', value: text }];
  return list.map((stat, i) => (i === at ? { ...stat, value: text } : stat));
}

const LIST_SECTIONS = Object.freeze([
  {
    key: 'stats', label: 'Stats', icon: Activity, field: 'stats',
    addLabel: 'Add stat', singular: 'stat',
    columns: [
      { name: 'label', placeholder: 'Height · Eyes · Form', max: L.STAT_LABEL_MAX },
      { name: 'value', placeholder: '5\'7" · amber · vapor', max: L.STAT_VALUE_MAX },
    ],
    summary: (s) => `${s.label}${s.value ? `: ${s.value}` : ''}`,
  },
  {
    key: 'colorPalette', label: 'Color palette', icon: Palette, field: 'colorPalette',
    addLabel: 'Add swatch', singular: 'swatch',
    columns: [
      { name: 'name', placeholder: 'amber', max: L.COLOR_NAME_MAX },
      { name: 'hex', placeholder: '#f59e0b', max: L.COLOR_HEX_MAX, narrow: true },
      { name: 'role', placeholder: 'skin · jacket primary · boot leather', max: L.COLOR_ROLE_MAX },
    ],
    summary: (c) => `${c.name}${c.hex ? ` ${c.hex}` : ''}${c.role ? ` — ${c.role}` : ''}`,
    swatchHex: (row) => row.hex,
  },
  {
    key: 'props', label: 'Props', icon: Package, field: 'props',
    addLabel: 'Add prop', singular: 'prop',
    columns: [
      { name: 'name', placeholder: 'Radio · Map case', max: L.PROP_NAME_MAX },
      { name: 'purpose', placeholder: 'comms · navigation · talisman', max: L.PROP_PURPOSE_MAX },
      { name: 'materials', placeholder: 'aluminum + ABS plastic', max: L.PROP_MATERIALS_MAX },
      { name: 'notes', placeholder: 'Prop notes', max: L.PROP_NOTES_MAX },
    ],
    summary: (p) => `${p.name}${p.purpose ? ` (${p.purpose})` : ''}`,
  },
  {
    key: 'expressions', label: 'Expression sheet', icon: Smile, field: 'expressions',
    addLabel: 'Add expression', singular: 'expression',
    columns: [
      { name: 'name', placeholder: 'neutral · curious · worried', max: L.EXPRESSION_NAME_MAX },
      { name: 'description', placeholder: 'wide eyes; lips parted; brow raised', max: L.EXPRESSION_DESC_MAX },
    ],
    summary: (e) => `${e.name}${e.description ? ` — ${e.description}` : ''}`,
  },
  {
    key: 'secrets', label: 'Secrets', icon: KeyRound, field: 'secrets',
    addLabel: 'Add secret', singular: 'secret',
    // `secrets` is a plain string[] on the server (cleanStringArray). The
    // generic ListRow works on row objects keyed by column name, so this
    // section stores each secret as `{ text }` and marshals to/from string[]
    // via `toRows` / `fromRows` below (see ListSectionEditor).
    stringList: true,
    columns: [
      { name: 'text', placeholder: CHARACTER_SECRETS_FIELD.placeholder, max: CHARACTER_SECRETS_FIELD.max },
    ],
    summary: (s) => s.text,
  },
  {
    key: 'handGestures', label: 'Hand gestures', icon: Hand, field: 'handGestures',
    addLabel: 'Add gesture', singular: 'gesture',
    columns: [
      { name: 'name', placeholder: 'pointing · peace sign · gripping radio', max: L.GESTURE_NAME_MAX },
      { name: 'description', placeholder: 'open palm; index extended; relaxed', max: L.GESTURE_DESC_MAX },
    ],
    summary: (g) => `${g.name}${g.description ? ` — ${g.description}` : ''}`,
  },
]);

// Buffered text input — wraps useFieldDraft, commits to onCommit on blur.
function DraftField({ field, value, onCommit, disabled, idPrefix, videoDescriptionLimit }) {
  const draft = useFieldDraft(typeof value === 'string' ? value : '', onCommit);
  // idPrefix scopes the field id to one editor instance so two open
  // character cards don't render duplicate `chr-field-pronouns` DOM ids
  // and break the label/input association.
  const id = `chr-field-${idPrefix || 'unknown'}-${field.name}`;
  const showVideoCount = field.name === 'physicalDescription' && videoDescriptionLimit;
  // `id` stays off the shared spread and is written at each call site: a
  // control whose id arrives through `{...common}` reads as unnamed to any
  // reader — human or the a11y scan — that cannot resolve the spread.
  const common = {
    value: draft.value,
    onChange: draft.onChange,
    onBlur: draft.onBlur,
    disabled,
    placeholder: field.placeholder,
    maxLength: field.max,
    ...(showVideoCount ? { 'aria-describedby': `${id}-video-count` } : {}),
    className: 'w-full px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white disabled:opacity-50',
  };
  return (
    <div className="space-y-0.5">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wider text-gray-500">
        {field.label}
      </label>
      {field.type === 'textarea'
        ? <textarea id={id} {...common} rows={2} />
        : <input type="text" id={id} {...common} />}
      {showVideoCount && <p id={`${id}-video-count`} className={`text-xs ${draft.value.length > videoDescriptionLimit ? 'text-port-error' : 'text-port-text-muted'}`}>
        {formatCount(draft.value.length)} / {formatCount(videoDescriptionLimit)} characters for linked music videos
      </p>}
    </div>
  );
}

const SHEET_PAGES = [
  { id: 'attributes', label: 'Attributes', icon: Activity },
  { id: 'story', label: 'Story', icon: BookOpen },
  { id: 'appearance', label: 'Appearance', icon: Eye },
  { id: 'voice', label: 'Voice', icon: Mic },
];
const SHEET_PAGE_IDS = SHEET_PAGES.map((page) => page.id);

export default function CharacterDetailEditor({ draftMode = 'blur', ...props }) {
  return <DraftCommitMode.Provider value={draftMode}><CharacterDetailForm {...props} /></DraftCommitMode.Provider>;
}

function CharacterDetailForm({ entry, universeId = null, onPatch, onExpand, expanding = false, disabled = false, actionsDisabled = false,
  characters = [], portrait = null, identityControls = null, primaryActions = null, storyExtra = null, navigationId = null, onPageChange = null,
  contextLoading = false, saveHint = 'Edits save when you leave a field', videoDescriptionLimit = null, children }) {
  const [activePage, setActivePage] = useDrawerTab(`castSheet-${navigationId || entry?.id}`, 'attributes', SHEET_PAGE_IDS);
  // Keep visited pages mounted so pending list rows and local voice drafts survive
  // navigation. Unvisited production tools do not load until explicitly opened.
  const [visited, setVisited] = useState({});
  useEffect(() => {
    setVisited((previous) => previous[activePage] ? previous : { ...previous, [activePage]: true });
    onPageChange?.(activePage);
  }, [activePage, onPageChange]);
  if (!entry) return null;

  const patchField = (name, value) => onPatch?.({ [name]: value });
  const renderFields = (fields) => fields.map((field) => (
    <DraftField key={field.name} field={field} value={entry[field.name]}
      onCommit={(value) => patchField(field.name, value)} disabled={disabled} idPrefix={entry.id} videoDescriptionLimit={videoDescriptionLimit} />
  ));
  const proseSection = (key) => {
    const section = SECTIONS.find((item) => item.key === key);
    const filled = section.fields.filter((field) => typeof entry[field.name] === 'string' && entry[field.name].trim()).length;
    return <BoxedSection icon={section.icon} label={section.label} summary={`${filled}/${section.fields.length} filled`}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{renderFields(key === 'visualIdentity' ? section.fields.slice(1) : section.fields)}</div>
    </BoxedSection>;
  };
  const listSection = (key) => <ListSectionEditor section={LIST_SECTIONS.find((item) => item.key === key)}
    entry={entry} onPatchList={patchField} disabled={disabled} />;

  return (
    <div className="space-y-3">
      {(universeId || onExpand) && <div className="flex flex-wrap items-center justify-end gap-2">
        {universeId && (<Link
        to={`/voices?${new URLSearchParams({ universeId, characterId: entry.id })}`}
        className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
      >
        <Mic size={14} /> Create or assign a voice in Voice Studio
      </Link>)}
        {onExpand ? (
          <button type="button" onClick={onExpand} disabled={expanding || disabled || actionsDisabled}
            className="inline-flex min-h-[40px] items-center gap-1.5 px-3 py-2 text-xs rounded border border-port-accent/40 bg-port-accent/10 text-port-accent hover:bg-port-accent/20 disabled:opacity-40"
            title={`Fill blank fields on ${entry.name} via one LLM call. Populated fields are preserved.`}>
            {expanding ? <Loader2 size={14} className="animate-spin" /> : <WandSparkles size={14} />}
            AI: expand character
          </button>
        ) : null}
      </div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_240px] items-start">
        <div className="min-w-0 rounded-lg border border-port-border bg-port-card p-3 space-y-3 lg:col-start-1 lg:row-start-1">
          {renderFields([SECTIONS.find(section => section.key === 'visualIdentity').fields[0]])}
          {primaryActions}
        </div>
        <aside className="min-w-0 space-y-3 lg:col-start-2 lg:row-start-1 lg:row-span-2" aria-label={`${entry.name} identity`}>
          <div className={`rounded-lg border border-port-accent/30 bg-port-accent/5 p-3 lg:p-4 grid gap-3 ${portrait ? 'grid-cols-[80px_minmax(0,1fr)] lg:grid-cols-1' : 'grid-cols-1'}`}>
            {portrait ? <div className="flex justify-center">{portrait}</div> : null}
            <div className="space-y-3">
              <div className="lg:text-center">
                {(disabled || saveHint) && <p className="text-xs text-gray-500">{disabled ? 'Read-only character' : saveHint}</p>}
              </div>
              {identityControls}
              {renderFields([...SECTIONS[0].fields.slice(0, 2)])}
              <DraftField field={{ ...HEIGHT_FIELD, placeholder: heightPlaceholder(entry.age) }} value={characterHeightStat(entry)}
                onCommit={(value) => patchField('stats', withHeightStat(entry.stats, value))} disabled={disabled} idPrefix={entry.id} />
              {renderFields([SECTIONS[0].fields[2], SECTIONS[0].fields.find(field => field.name === 'role')])}
            </div>
          </div>
          {listSection('stats')}
        </aside>
        <div className="min-w-0 space-y-3 lg:col-start-1 lg:row-start-2">
          <TabPills tabs={SHEET_PAGES} activeTab={activePage} onChange={setActivePage}
            variant="pills" size="sm" mobileCompact ariaLabel={`${entry.name} sheet page`} />
          {SHEET_PAGES.map((page) => (
            <div key={page.id} role="tabpanel" aria-label={page.label} hidden={activePage !== page.id}>
              {activePage === page.id || visited[page.id] ? (
                <div className="space-y-3">
                  {page.id === 'attributes' ? <>
                    {proseSection('personality')}
                    <ArcFrameworkControls entry={entry} onPatch={onPatch} disabled={disabled} idPrefix={entry.id} />
                  </> : null}
                  {page.id === 'story' ? <>
                    {proseSection('history')}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                      {proseSection('framework')}
                      <div className="min-w-0 space-y-3">
                        <RelationshipsSection entry={entry} characters={characters} onPatch={onPatch} disabled={disabled} />
                        {listSection('secrets')}
                      </div>
                    </div>
                    <PsychologySection entry={entry} onPatch={onPatch} disabled={disabled} />
                    {storyExtra}
                    {(typeof entry.firstAppearance === 'string' && entry.firstAppearance || Array.isArray(entry.missingFromProse) && entry.missingFromProse.length > 0) && <BoxedSection icon={BookOpen} label="Story evidence">
                      {typeof entry.firstAppearance === 'string' && entry.firstAppearance && <p className="text-xs text-gray-400 whitespace-pre-wrap break-words">First appearance: {entry.firstAppearance}</p>}
                      {(Array.isArray(entry.missingFromProse) ? entry.missingFromProse.filter(item => typeof item === 'string') : []).map((item, index) => <p key={`${index}-${item}`} className="text-xs text-gray-400 whitespace-pre-wrap break-words">{item}</p>)}
                    </BoxedSection>}
                  </> : null}
                  {page.id === 'appearance' ? <>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                      <div className="min-w-0 space-y-3">
                        {proseSection('visualIdentity')}
                        <BoxedSection icon={Eye} label="Visual notes">{renderFields([SECTIONS[0].fields[5]])}</BoxedSection>
                        {listSection('colorPalette')}
                        {listSection('props')}
                      </div>
                      <div className="min-w-0 space-y-3">
                        {listSection('expressions')}
                        {listSection('handGestures')}
                        <IdentityPackSection entry={entry} onPatch={onPatch} disabled={disabled} />
                      </div>
                    </div>
                    {children}
                    {typeof entry.prompt === 'string' && entry.prompt && <BoxedSection icon={Images} label="Production prompt"><p className="text-xs text-gray-400 whitespace-pre-wrap break-words">{entry.prompt}</p></BoxedSection>}
                  </> : null}
                  {page.id === 'voice' ? <>
                    <BoxedSection icon={Mic} label="Speech & delivery">
                      {renderFields(SECTIONS[0].fields.slice(3, 5))}
                      <VoicePicker label="Voice (TTS)" value={entry.voiceId || null}
                        onChange={(value) => patchField('voiceId', value)} disabled={disabled}
                        placeholder="Project default voice" previewText={entry.name ? `Hi, I'm ${entry.name}. This is how I sound.` : undefined} />
                    </BoxedSection>
                    <VoiceCanonSection entry={entry} onPatch={onPatch} disabled={disabled} />
                    {contextLoading ? <p role="status" className="text-xs text-gray-400">Load the owning universe context to manage local voice profiles.</p>
                      : <VoiceProfileSection universeId={universeId} entry={entry} disabled={disabled || actionsDisabled} />}
                  </> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
