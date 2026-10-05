import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Compass } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import LoadFailedState from '../../ui/LoadFailedState';
import GsdProjectCard from './GsdProjectCard';

export default function GsdTab() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    const projectsData = await api.getGsdProjects().catch(() => null);
    setFailed(projectsData === null);
    if (projectsData) setProjects(projectsData.projects || projectsData || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
    toast.success('GSD data refreshed');
  };

  if (loading) {
    return <p className="text-sm text-gray-500">Loading Get Stuff Done projects...</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Compass size={18} className="text-port-accent" />
          <h2 className="text-lg font-semibold text-white">Get Stuff Done projects</h2>
          <span className="text-xs text-gray-500">({projects.length})</span>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-port-card border border-port-border hover:border-port-accent/50 text-gray-400 hover:text-white rounded transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Info */}
      <p className="text-xs text-gray-500 leading-relaxed">
        This tab monitors apps with <code className="text-port-accent">.planning/</code> directories created by the GSD workflow.
        Use <code className="text-port-accent">/gsd:*</code> commands in Claude Code to plan and track work, then view status and create tasks from concerns here.
      </p>

      {/* Project Cards */}
      {failed && projects.length === 0 ? (
        <LoadFailedState title="Could not load Get Stuff Done projects." hint="Retry." onRetry={fetchData} />
      ) : projects.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Compass size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No Get Stuff Done projects found</p>
          <p className="text-xs mt-1">Apps with a <code className="text-port-accent">.planning/</code> directory will appear here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(project => (
            <GsdProjectCard
              key={project.appId}
              project={project}
              onRefresh={fetchData}
            />
          ))}
        </div>
      )}
    </div>
  );
}
