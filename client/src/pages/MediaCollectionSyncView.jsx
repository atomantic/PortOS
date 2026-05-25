/**
 * MediaCollectionSyncView — route page for /media/collections/:id/sync.
 *
 * Deep-linkable: renders the SyncDetailDrawer overlaid on top of the
 * MediaGen layout. `onClose` navigates back to the collections list so the
 * user lands on /media/collections after dismissing the drawer.
 */

import { useParams, useNavigate } from 'react-router-dom';
import SyncDetailDrawer from '../components/sync/SyncDetailDrawer';

export default function MediaCollectionSyncView() {
  const { id } = useParams();
  const navigate = useNavigate();

  const handleClose = () => {
    navigate('/media/collections');
  };

  return (
    <SyncDetailDrawer
      kind="mediaCollection"
      // Default to '' (matching SyncView) so a route mounted without the param
      // never flows `undefined` into the per-kind fetcher calls.
      recordId={id ?? ''}
      onClose={handleClose}
    />
  );
}
