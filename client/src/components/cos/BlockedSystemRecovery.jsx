import { Link } from 'react-router';
import { formatDateTime } from '../../utils/formatters';

const messages = {
  creating: 'Preparing an automatic investigation.',
  queued: 'An automatic investigation is queued.',
  investigating: 'An agent is investigating the cause.',
  waiting: 'Automatic investigation is waiting for its retry window.',
  diagnosed: 'The investigation finished. Original work remains stopped under its existing limits.',
  'investigation-blocked': 'The investigation stopped within its configured limits. Original work is preserved.',
  'budget-exhausted': 'Automatic investigation reached its configured limit. Original work is preserved.',
};

export default function BlockedSystemRecovery({ recovery }) {
  return <div className="text-sm text-port-text-muted space-y-1" aria-label="Automatic investigation">
    <p>{messages[recovery.phase] || 'Automatic investigation status is unavailable.'}</p>
    {recovery.retryAt && <p>Next check: {formatDateTime(recovery.retryAt)}</p>}
    {recovery.taskId && <Link className="text-port-accent underline" to={`/cos/tasks?task=${encodeURIComponent(recovery.taskId)}`}>View automatic investigation</Link>}
  </div>;
}
