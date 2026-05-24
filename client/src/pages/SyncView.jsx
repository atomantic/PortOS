/**
 * SyncView — generic deep-linkable route wrapper for SyncDetailDrawer.
 *
 * Used by:
 *   /media/collections/:id/sync       → kind='mediaCollection', param='id'
 *   /universes/:universeId/sync       → kind='universe', param='universeId'
 *   /pipeline/series/:seriesId/sync   → kind='series', param='seriesId'
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

  const recordId = decodeURIComponent(params[param] ?? '');

  return (
    <SyncDetailDrawer
      kind={kind}
      recordId={recordId}
      onClose={() => navigate(backPath)}
    />
  );
}
