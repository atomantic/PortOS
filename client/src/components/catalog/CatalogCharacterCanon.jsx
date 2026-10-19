import CollapsibleSection from '../ui/CollapsibleSection';
import {
  CHARACTER_FRAMEWORK_EDITOR_FIELDS,
  CHARACTER_PSYCHOLOGY_EDITOR_FIELDS,
  CHARACTER_PSYCHOLOGY_NOTE_FIELD,
  CHARACTER_SLIDER_AXES,
  PSYCHOLOGY_DRIVE_AXES,
} from '../../lib/characterFramework';
import { humanizeIntegrityField } from '../../lib/characterIntegrity';
import { formatCount } from '../../utils/formatters';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === 'string' ? value.trim()
  : typeof value === 'number' && Number.isFinite(value) ? formatCount(value) : '';
const strings = (value) => list(value).filter((item) => typeof item === 'string' && item.trim()).join('\n');
const fields = (value, descriptors) => descriptors.map(({ name, label }) => [label, text(object(value)[name])]);

// These are authored canon fields, not a dump of the payload's control fields
// or provider metadata. Shared editor descriptors keep narrative labels aligned
// with the Universe and Writers Room surfaces that own their structured editors.
export default function CatalogCharacterCanon({ payload }) {
  const canon = object(payload);
  const psychology = object(canon.psychology);
  const voice = object(canon.voiceCanon);
  const groups = [
    ['Character framework', [
      ...fields(canon, CHARACTER_FRAMEWORK_EDITOR_FIELDS),
      ['Arc type', text(canon.arcType)],
      ['Secrets', strings(canon.secrets)],
      ...CHARACTER_SLIDER_AXES.map((axis) => [humanizeIntegrityField(axis), text(object(canon.sliders)[axis])]),
    ]],
    ['Psychology', [
      ['Assessment', text(psychology.assessment)],
      ...fields(psychology, [...CHARACTER_PSYCHOLOGY_EDITOR_FIELDS, CHARACTER_PSYCHOLOGY_NOTE_FIELD]),
      ...PSYCHOLOGY_DRIVE_AXES.flatMap((axis) => {
        const drive = object(object(psychology.drives)[axis]);
        return ['desire', 'fear'].map((key) => [humanizeIntegrityField(`${axis}.${key}`), text(drive[key])]);
      }),
    ]],
    ['Props', list(canon.props).flatMap((item) => {
      const prop = object(item);
      const name = text(prop.name);
      if (!name) return [];
      const details = fields(prop, [
        { name: 'purpose', label: 'Purpose' },
        { name: 'materials', label: 'Materials' },
        { name: 'notes', label: 'Notes' },
      ]).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
      return [[name, details || 'No further description.']];
    })],
    ...[['expressions', 'Expressions'], ['handGestures', 'Hand gestures']].map(([key, label]) => [
      label, list(canon[key]).flatMap((item) => {
        const row = object(item);
        return text(row.name) ? [[text(row.name), text(row.description) || 'No further description.']] : [];
      }),
    ]),
    ['Character relationships', list(canon.relationshipLinks).flatMap((item) => {
      const row = object(item);
      const target = text(row.targetCharacterId);
      if (!target) return [];
      const opposition = object(row.opposition);
      return [[target, [text(row.type), text(row.description),
        ...fields(opposition, [
          { name: 'axis', label: 'Opposition' },
          { name: 'thisRole', label: 'This character' },
          { name: 'targetRole', label: 'Other character' },
          { name: 'note', label: 'Note' },
        ]).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
      ].filter(Boolean).join('\n') || 'Linked character']];
    })],
    ['Voice direction', [
      ['Description', text(voice.description)],
      ['Default delivery', text(voice.defaultDelivery)],
      ['Emotional range', strings(voice.emotionalRange)],
      ['Avoid', strings(voice.avoid)],
      ['Source policy', text(voice.sourcePolicy)],
      ['Review status', typeof voice.approved === 'boolean' ? (voice.approved ? 'Approved' : 'Candidate') : ''],
      ...list(voice.pronunciations).flatMap((item) => {
        const row = object(item);
        return text(row.term) && text(row.pronunciation) ? [[text(row.term), text(row.pronunciation)]] : [];
      }),
    ]],
    ['Story evidence', [
      ['First appearance', text(canon.firstAppearance)],
      ['Missing from prose', strings(canon.missingFromProse)],
    ]],
    ['Production', [['Generation prompt', text(canon.prompt)]]],
  ].map(([label, rows]) => [label, rows.filter(([, value]) => value)])
    .filter(([, rows]) => rows.length > 0);

  if (groups.length === 0) return null;
  return (
    <section aria-label="Additional character canon" className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-white">Additional character canon</h2>
      <p className="text-xs text-gray-500">Stored story and production details. Read-only here.</p>
      {groups.map(([label, rows]) => (
        <CollapsibleSection key={label} label={label} size="bar" defaultOpen bodyClassName="pb-3">
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {rows.map(([name, value], index) => (
              <div key={`${name}-${index}`} className="min-w-0">
                <dt className="text-xs font-medium text-gray-400 break-words">{name}</dt>
                <dd className="text-sm text-gray-300 whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </CollapsibleSection>
      ))}
    </section>
  );
}
