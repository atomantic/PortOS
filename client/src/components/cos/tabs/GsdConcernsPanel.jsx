import { useState } from 'react';
import { Bug, Shield, Zap, Package, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

const SEVERITY_CONFIG = {
  CRITICAL: { color: 'text-port-error border-port-error/30 bg-port-error/10', icon: Shield, label: 'Critical' },
  HIGH: { color: 'text-port-warning border-port-warning/30 bg-port-warning/10', icon: Bug, label: 'High' },
  MEDIUM: { color: 'text-port-accent border-port-accent/30 bg-port-accent/10', icon: Zap, label: 'Medium' },
  LOW: { color: 'text-gray-400 border-gray-500/30 bg-gray-500/10', icon: Package, label: 'Low' }
};

export default function GsdConcernsPanel({ appId, concerns, onTaskCreated }) {
  const [expanded, setExpanded] = useState({});
  const [creating, setCreating] = useState(null);

  if (!concerns?.sections?.length) {
    return <p className="text-sm text-gray-500 italic">No concerns found</p>;
  }

  const toggleSection = (title) => {
    setExpanded(prev => ({ ...prev, [title]: !prev[title] }));
  };

  const handleCreateTask = async (concernId) => {
    setCreating(concernId);
    const result = await api.createGsdConcernTasks(appId, { concernIds: [concernId] }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setCreating(null);
    if (result) {
      toast.success('Task created from concern');
      onTaskCreated?.();
    }
  };

  const handleCreateAll = async () => {
    setCreating('all');
    const result = await api.createGsdConcernTasks(appId, { all: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setCreating(null);
    if (result) {
      toast.success(`Created ${result.created || 0} tasks from concerns`);
      onTaskCreated?.();
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Concerns</h4>
        <button
          onClick={handleCreateAll}
          disabled={creating === 'all'}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors disabled:opacity-50"
        >
          <Plus size={12} /> Create All Tasks
        </button>
      </div>
      <div className="space-y-2">
        {concerns.sections.map(section => {
          const config = SEVERITY_CONFIG[section.severity] || SEVERITY_CONFIG.LOW;
          const SeverityIcon = config.icon;
          const isExpanded = expanded[section.title];

          return (
            <div key={section.title} className={`border rounded-lg ${config.color.split(' ')[1]} ${config.color.split(' ')[2]}`}>
              <button
                onClick={() => toggleSection(section.title)}
                className="flex items-center justify-between w-full px-3 py-2 text-left"
              >
                <div className="flex items-center gap-2">
                  <SeverityIcon size={14} className={config.color.split(' ')[0]} />
                  <span className="text-sm font-medium text-gray-300">{section.title}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${config.color}`}>{config.label}</span>
                  <span className="text-xs text-gray-500">({section.items?.length || 0})</span>
                </div>
                {isExpanded ? <ChevronUp size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
              </button>
              {isExpanded && section.items?.length > 0 && (
                <div className="px-3 pb-2 space-y-1">
                  {section.items.map(item => (
                    <div key={item.id} className="flex items-center justify-between gap-2 py-1 border-t border-port-border/50">
                      <span className="text-xs text-gray-400 flex-1">{item.text}</span>
                      <button
                        onClick={() => handleCreateTask(item.id)}
                        disabled={creating === item.id}
                        className="shrink-0 px-1.5 py-0.5 text-[10px] bg-port-accent/10 hover:bg-port-accent/20 text-port-accent rounded transition-colors disabled:opacity-50"
                      >
                        {creating === item.id ? '...' : '+ Task'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
