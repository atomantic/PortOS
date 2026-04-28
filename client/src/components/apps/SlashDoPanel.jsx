import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { NON_PM2_TYPES } from './constants';
import * as api from '../../services/api';

const SLASHDO_COMMANDS = [
  { id: 'push', label: '/do:push', description: 'Commit and push all work', classes: 'bg-port-success/20 text-port-success hover:bg-port-success/30 border-port-success/30' },
  { id: 'review', label: '/do:review', description: 'Deep code review', classes: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30' },
  { id: 'replan', label: '/do:replan', description: 'Audit and prune PLAN.md, archive done items to DONE.md', classes: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30' },
  { id: 'release', label: '/do:release', description: 'Create a release PR', classes: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/30' },
  { id: 'better', label: '/do:better', description: 'DevSecOps audit', classes: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30', hideForSwift: true },
  { id: 'better-swift', label: '/do:better-swift', description: 'SwiftUI DevSecOps audit', classes: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30', swiftOnly: true }
];

export default function SlashDoPanel({ appId, appType }) {
  const [loading, setLoading] = useState(null);
  const navigate = useNavigate();
  const isSwiftApp = NON_PM2_TYPES.has(appType);

  const commands = SLASHDO_COMMANDS.filter(cmd => {
    if (cmd.swiftOnly && !isSwiftApp) return false;
    if (cmd.hideForSwift && isSwiftApp) return false;
    return true;
  });

  const handleRun = async (command) => {
    setLoading(command.id);
    const result = await api.createSlashdoTask(command.id, appId).catch(err => {
      toast.error(err.message || `Failed to queue ${command.label}`);
      return null;
    });
    setLoading(null);
    if (result) {
      toast.success(`Queued ${command.label} agent task`);
      navigate('/cos/agents');
    }
  };

  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Agent Operations</div>
      <div className="flex flex-wrap gap-2">
        {commands.map(cmd => (
          <button
            key={cmd.id}
            onClick={() => handleRun(cmd)}
            disabled={!!loading}
            title={cmd.description}
            className={`px-3 py-1.5 ${cmd.classes} rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors border`}
          >
            {loading === cmd.id ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
            {cmd.label}
          </button>
        ))}
      </div>
    </div>
  );
}
