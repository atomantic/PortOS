import { useParams, Navigate } from 'react-router-dom';
import AppDetailView from '../components/apps/AppDetailView';

export default function AppDetail() {
  const { appId, tab } = useParams();

  if (!appId) {
    return <Navigate to="/apps" replace />;
  }

  if (!tab) {
    return <Navigate to={`/apps/${appId}/overview`} replace />;
  }

  return <AppDetailView />;
}
