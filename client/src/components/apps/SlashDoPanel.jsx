import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Terminal, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { NON_PM2_TYPES } from './constants';
import SlashDoRunDrawer from './SlashDoRunDrawer';
import * as api from '../../services/api';

// Per-command button colors. Presentation, NOT catalog data — the commands
// themselves (labels, descriptions, Swift gating, which ones open the run
// drawer) come from the shared server catalog via `getSlashdoCommands` (#3108),
// so a workflow added there appears here without a client-side edit. A command
// with no entry falls back to the neutral accent styling.
const BUTTON_CLASSES = {
  push: 'bg-port-success/20 text-port-success hover:bg-port-success/30 border-port-success/30',
  review: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30',
  replan: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30',
  next: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border-blue-500/30',
  release: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/30',
  better: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30',
  'better-swift': 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30',
  'plan-task': 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30',
  depfree: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30',
  scan: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30',
};
const DEFAULT_BUTTON_CLASSES = 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30';

export default function SlashDoPanel({ appId, appName, appType }) {
  const [loading, setLoading] = useState(null);
  // `null` = catalog not fetched yet (or the fetch failed) vs `[]` = fetched and
  // legitimately empty — the panel renders nothing in either case, but only the
  // empty array means "the server really has no launchable workflows".
  const [catalog, setCatalog] = useState(null);
  // A `configurable` command opens a pre-flight drawer instead of firing
  // immediately: the run's provider / model / effort / reviewer / simplify
  // settings, plus (for `/do:next`) which work item to claim. Holds the whole
  // command entry so the drawer is titled and queued for the one that was
  // clicked. Every other command still queues on one click.
  const [drawerCommand, setDrawerCommand] = useState(null);
  const navigate = useNavigate();
  const isSwiftApp = NON_PM2_TYPES.has(appType);

  useEffect(() => {
    let active = true;
    api.getSlashdoCommands({ silent: true })
      .then(res => { if (active) setCatalog(Array.isArray(res?.commands) ? res.commands : []); })
      .catch(() => { if (active) setCatalog([]); });
    return () => { active = false; };
  }, []);

  const commands = (catalog || []).filter(cmd => {
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
    setLoading(command.command);
    const result = await api.createSlashdoTask(command.command, appId, {}, { silent: true }).catch(err => {
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
            key={cmd.command}
            onClick={() => handleRun(cmd)}
            disabled={!!loading}
            title={cmd.description}
            className={`px-3 py-1.5 ${BUTTON_CLASSES[cmd.command] || DEFAULT_BUTTON_CLASSES} rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors border`}
          >
            {loading === cmd.command ? <Loader2 size={14} className="animate-spin" /> : <Terminal size={14} />}
            {cmd.label}
          </button>
        ))}
      </div>
      {/* Mounted only while open — the drawer fetches providers on mount, and
          unmounting is what resets the form between runs. */}
      {drawerCommand && (
        <SlashDoRunDrawer
          open
          command={drawerCommand.command}
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
