import { Suspense } from 'react';
import { useParams, Navigate } from 'react-router';
import PageSkeleton from '../components/ui/PageSkeleton';
import { lazyWithReload } from '../utils/lazyWithReload';

const AgentList = lazyWithReload(() => import('../components/agents/AgentList'));
const AgentDetail = lazyWithReload(() => import('../components/agents/AgentDetail'));

export default function Agents() {
  const { agentId, tab } = useParams();

  // No agentId → show agent list
  if (!agentId) {
    return (
      <Suspense fallback={<PageSkeleton header="bar" label="Loading agents" cards={3} sidebar={false} />}>
        <AgentList />
      </Suspense>
    );
  }

  // agentId without tab → redirect to overview
  if (!tab) {
    return <Navigate to={`/agents/${agentId}/overview`} replace />;
  }

  // agentId + tab → show agent detail
  return (
    <Suspense fallback={<PageSkeleton header="bar" label="Loading agent" cards={3} sidebar={false} />}>
      <AgentDetail />
    </Suspense>
  );
}
