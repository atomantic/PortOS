/**
 * SyncView — generic deep-linkable route wrapper for SyncDetailDrawer.
 *
 * Used by the universe + pipeline-series sync routes:
 *   /universes/:universeId/sync       → kind='universe', param='universeId'
 *   /pipeline/series/:seriesId/sync   → kind='series', param='seriesId'
 * (The /media/collections/:id/sync route uses MediaCollectionSyncView.)
 *
 * Props:
 *   kind      — record kind passed straight to SyncDetailDrawer
 *   param     — the URL param name containing the record id (e.g. 'universeId')
 *   backPath  — absolute path to navigate to when the drawer is closed
 */

import { useParams, useNavigate } from 'react-router-dom';
import SyncDetailDrawer from '../components/sync/SyncDetailDrawer';

export default function SyncView({ kind, param, backPath }) {
  const params = useParams();
  const navigate = useNavigate();

  // react-router already URL-decodes useParams values; don't decode again
  // (double-decode throws on malformed `%` or mangles ids containing `%25`).
  const recordId = params[param] ?? '';

  return (
    <SyncDetailDrawer
      kind={kind}
      recordId={recordId}
      onClose={() => navigate(backPath)}
    />
  );
}
