/**
 * AuthorPicker — pick an Author persona for a series.
 *
 * Replaces the free-text "author byline" input. Selecting an author calls
 * `onChange(authorId, authorName)` so the caller can store BOTH the FK
 * (`authorId`) and the denormalized byline string (`author`) on the series —
 * the byline is what cover/title prompts render, and keeping it on the series
 * means a federated peer renders correctly even without the (local-only) author
 * record. Selecting "— No author —" calls `onChange(null, '')`.
 *
 * Self-contained: fetches the author list on mount. A series carrying a legacy
 * byline string with no matching `authorId` keeps showing that byline as a hint
 * until the user picks a persona.
 */

import { Link } from 'react-router';
import { listAuthors } from '../../services/api';
import { withUnlistedOption } from '../../lib/withUnlistedOption';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';

const fetchAuthors = () => listAuthors({ silent: true });

export default function AuthorPicker({ id = 'series-author', value, byline, onChange, disabled = false }) {
  const { items: authors, state, error, retry } = useListResource(fetchAuthors);
  const loading = state === 'loading';

  const handleChange = (e) => {
    const authorId = e.target.value || null;
    const picked = authors.find((a) => a.id === authorId);
    onChange(authorId, picked ? picked.name : '');
  };

  // An authorId that isn't in the fetched list (deleted persona) shouldn't make
  // the select silently snap to "none" — surface it so the link isn't lost.
  const authorOptions = withUnlistedOption(
    authors,
    value,
    (authorId) => ({ id: authorId, name: byline || 'Linked author (unavailable)' }),
  );

  return (
    <div>
      <select
        id={id}
        value={value || ''}
        onChange={handleChange}
        disabled={disabled || loading}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white disabled:opacity-50"
      >
        <option value="">— No author —</option>
        {authorOptions.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      {state === 'error' && <ListLoadError what="author personas" error={error} onRetry={retry} className="mt-1" />}
      <p className="text-[11px] text-gray-500 mt-1">
        {state === 'ready' && authors.length === 0 ? (
          <>No author personas yet — <Link to="/authors" className="text-port-accent hover:underline">create one</Link>.</>
        ) : !value && byline ? (
          <>Unlinked byline: <span className="text-gray-400">{byline}</span> — pick a persona to link it.</>
        ) : (
          <>Manage personas in <Link to="/authors" className="text-port-accent hover:underline">Authors</Link>.</>
        )}
      </p>
    </div>
  );
}
