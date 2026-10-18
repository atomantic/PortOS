import { Link } from 'react-router';
import CollapsibleSection from '../ui/CollapsibleSection';
import { ingredientPath } from '../../lib/creativeLibraries';
import { humanizeIntegrityField } from '../../lib/characterIntegrity';
import { formatCount, formatDateTime } from '../../utils/formatters';

export const identityButtonClass = 'min-h-[44px] px-3 py-2 rounded border border-port-border text-sm text-port-accent disabled:opacity-50';
export const identityValueText = value => value == null ? 'Not set' : typeof value === 'string' ? value || 'Empty' : JSON.stringify(value, null, 2);

export function IdentityValues({ title, value }) {
  return <CollapsibleSection label={title} size="bar" className="min-w-0 rounded border border-port-border p-3">
    <dl className="space-y-3 text-xs">{Object.entries(value || {}).map(([key, entry]) => <div key={key}>
      <dt className="text-gray-500">{humanizeIntegrityField(key)}</dt>
      <dd className="whitespace-pre-wrap break-words">{/_at$|At$/.test(key) && typeof entry === 'string' && !Number.isNaN(Date.parse(entry)) ? formatDateTime(entry) : identityValueText(entry)}</dd>
    </div>)}</dl>
  </CollapsibleSection>;
}

function OriginalEvidence({ title, snapshot, id, owner }) {
  const original = snapshot?.ingredients?.find(item => item.id === id);
  return <section className="min-w-0 space-y-2" aria-label={title}>
    <h4 className="text-sm font-semibold">{title}: {original?.name || id}</h4>
    <p className="text-xs break-all">Owner: {owner} · Original ID: {id}</p>
    {original && <Link className="inline-flex min-h-[44px] items-center text-sm text-port-accent underline" to={ingredientPath(original)}>Open original ID</Link>}
    <IdentityValues title="Reviewed original content" value={original} />
    {['media', 'revisions', 'refs', 'sources', 'relations'].map(key => <CollapsibleSection key={key}
      label={`${humanizeIntegrityField(key)} (${formatCount(snapshot?.[key]?.length ?? 0)})`} size="bar" className="rounded border border-port-border p-3">
      <p className="text-xs text-gray-500 mb-2">Reviewed evidence retains original record IDs and attribution. Media references do not guarantee that the file is available on this instance.</p>
      <div className="space-y-2">{(snapshot?.[key] || []).map((entry, index) => <IdentityValues key={entry.id || index}
        title={entry.media_key || entry.revision_id || entry.ref_id || entry.id || `${humanizeIntegrityField(key)} ${formatCount(index + 1)}`} value={entry} />)}</div>
    </CollapsibleSection>)}
  </section>;
}

export default function CatalogIdentityEvidence({ plan }) {
  return <div className="space-y-3">
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <OriginalEvidence title="Retained source" snapshot={plan.source} id={plan.sourceId} owner={plan.sourceOwner} />
      <OriginalEvidence title="Canonical survivor" snapshot={plan.survivor} id={plan.survivorId} owner={plan.survivorOwner} />
    </div>
    <IdentityValues title="Proposed canonical content" value={plan.proposed} />
    {!!Object.keys(plan.fieldChoices || {}).length && <IdentityValues title="Explicit field choices" value={plan.fieldChoices} />}
  </div>;
}
