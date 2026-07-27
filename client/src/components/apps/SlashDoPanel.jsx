import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { NON_PM2_TYPES } from './constants';
import SlashDoRunDrawer from './SlashDoRunDrawer';
import * as api from '../../services/api';

const SLASHDO_COMMANDS = [
  { id: 'push', label: '/do:push', description: 'Commit and push all work', classes: 'bg-port-success/20 text-port-success hover:bg-port-success/30 border-port-success/30' },
  { id: 'review', label: '/do:review', description: 'Deep code review', classes: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30' },
  { id: 'replan', label: '/do:replan', description: 'Audit and prune PLAN.md, removing completed items', classes: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30' },
  // `configurable` routes the click to the pre-flight settings drawer instead of
  // queuing straight away.
  { id: 'next', label: '/do:next', description: "Claim a work item (per this app's Work Tracker) and ship a PR — opens run settings", classes: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border-blue-500/30', configurable: true },
  { id: 'release', label: '/do:release', description: 'Create a release PR', classes: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/30' },
  { id: 'better', label: '/do:better', description: 'DevSecOps audit', classes: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30', hideForSwift: true },
  { id: 'better-swift', label: '/do:better-swift', description: 'SwiftUI DevSecOps audit', classes: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30', swiftOnly: true }
];

export default function SlashDoPanel({ appId, appName, appType }) {
  const [loading, setLoading] = useState(null);
  // A `configurable` command opens a pre-flight drawer instead of firing
  // immediately: the run's provider / model / effort / reviewer / simplify
  // settings, plus (for `/do:next`) which work item to claim. Holds the whole
  // command entry so the drawer is titled and queued for the one that was
  // clicked. Every other command still queues on one click.
  const [drawerCommand, setDrawerCommand] = useState(null);
  const navigate = useNavigate();
  const isSwiftApp = NON_PM2_TYPES.has(appType);

  const commands = SLASHDO_COMMANDS.filter(cmd => {
    if (cmd.swiftOnly && !isSwiftApp) return false;
    if (cmd.hideForSwift && isSwiftApp) return false;
    return true;
  });

  const goToQueue = (label) => {
    toast.success(`Queued ${label} agent task`);
    navigate('/cos/agents');
  };

  const handleRun = async (command) => {
    if (command.configurable) {
      setDrawerCommand(command);
      return;
    }
    setLoading(command.id);
    const result = await api.createSlashdoTask(command.id, appId, {}, { silent: true }).catch(err => {
      toast.error(err.message || `Failed to queue ${command.label}`);
      return null;
    });
    setLoading(null);
    if (result) goToQueue(command.label);
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
      {/* Mounted only while open — the drawer fetches providers on mount, and
          unmounting is what resets the form between runs. */}
      {drawerCommand && (
        <SlashDoRunDrawer
          open
          command={drawerCommand.id}
          label={drawerCommand.label}
          appId={appId}
          appName={appName}
          onClose={() => setDrawerCommand(null)}
          onQueued={() => {
            const { label } = drawerCommand;
            setDrawerCommand(null);
            goToQueue(label);
          }}
        />
      )}
    </div>
  );
}
