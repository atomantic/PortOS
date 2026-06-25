/**
 * Pipeline — finding deep-link resolver (#1608).
 *
 * Findings (editorial-check comments) live per-series, so a link that carries
 * only a `commentId` — shared from elsewhere, pasted into a note, surfaced by an
 * agent — can't open the editor directly: it first has to discover which series
 * owns the comment. This route does exactly that. It resolves the owning series
 * server-side, then redirects (replace) to the canonical manuscript-editor deep
 * link the triage already uses (`findingManuscriptLink`), so all the existing
 * comment-focus plumbing is reused rather than duplicated.
 *
 * Reachable at /pipeline/findings/:commentId. It is a redirect resolver, not a
 * navigable page (the destination depends on the id), so it is intentionally NOT
 * registered in NAV_COMMANDS — the navigable surface is the Editorial Checks
 * triage page, which already carries the `findings` keyword.
 */
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import { locatePipelineFinding } from '../services/api';
import { findingManuscriptLink } from '../lib/editorialChecks';

export default function PipelineFindingRedirect() {
  const { commentId } = useParams();
  // `located`: undefined while resolving, then the lookup result — `{ seriesId,
  // comment }` when a series owns the id, or `null` when none does / it failed.
  // The api wrapper resolves null (never rejects), so absent + failed collapse
  // into the same "not found" fallback below.
  const [located, setLocated] = useState(undefined);

  useEffect(() => {
    let active = true;
    setLocated(undefined);
    locatePipelineFinding(commentId).then((res) => { if (active) setLocated(res); });
    return () => { active = false; };
  }, [commentId]);

  if (located === undefined) {
    return (
      <div className="flex items-center justify-center py-16 text-sm">
        <BrailleSpinner text="Resolving finding…" />
      </div>
    );
  }

  if (located?.seriesId) {
    return <Navigate to={findingManuscriptLink(located.seriesId, located.comment)} replace />;
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <AlertTriangle className="h-8 w-8 text-port-warning" />
      <h1 className="text-lg font-semibold">Finding not found</h1>
      <p className="max-w-md text-sm text-gray-400">
        No series review contains finding <code className="text-gray-300">{commentId}</code>.
        It may have been dismissed and cleared, or the link is stale.
      </p>
      <Link to="/pipeline/editorial-checks" className="text-sm text-port-accent hover:underline">
        Go to Editorial Checks
      </Link>
    </div>
  );
}
