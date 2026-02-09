import { useParams, Navigate } from 'react-router-dom';
import AgentList from '../components/agents/AgentList';
import AgentDetail from '../components/agents/AgentDetail';

export default function Agents() {
  const { agentId, tab } = useParams();

  // No agentId → show agent list
  if (!agentId) {
    return <AgentList />;
  }

  // agentId without tab → redirect to overview
  if (!tab) {
    return <Navigate to={`/agents/${agentId}/overview`} replace />;
  }

  // agentId + tab → show agent detail
  return <AgentDetail />;
}
