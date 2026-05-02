import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Film, Trash2, Clock } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';

const formatDuration = (sec) => {
  if (!sec || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function VideoTimeline() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const refresh = async () => {
    const [list, hist] = await Promise.all([
      api.listTimelineProjects().catch(() => []),
      api.listVideoHistory().catch(() => []),
    ]);
    setProjects(list);
    setHistory(hist);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    const created = await api.createTimelineProject(trimmed).catch((err) => {
      toast.error(`Failed to create: ${err.message}`);
      return null;
    });
    setCreating(false);
    if (created) {
      setName('');
      navigate(`/media/timeline/${created.id}`);
    }
  };

  const handleDelete = async (project) => {
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    await api.deleteTimelineProject(project.id).catch((err) => {
      toast.error(`Failed to delete: ${err.message}`);
      refresh();
    });
  };

  const projectStats = useMemo(() => {
    const historyMap = new Map(history.map((h) => [h.id, h]));
    const stats = new Map();
    for (const project of projects) {
      let totalSec = 0;
      let firstThumb = null;
      for (const ref of project.clips || []) {
        const clip = historyMap.get(ref.clipId);
        if (!clip) continue;
        totalSec += Math.max(0, ref.outSec - ref.inSec);
        if (!firstThumb && clip.thumbnail) firstThumb = `/data/video-thumbnails/${clip.thumbnail}`;
      }
      stats.set(project.id, { totalSec, firstThumb });
    }
    return stats;
  }, [projects, history]);

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="flex gap-2 items-center">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name…"
          className="flex-1 max-w-sm px-3 py-2 bg-port-card border border-port-border rounded-md text-white text-sm placeholder-gray-500 focus:outline-none focus:border-port-accent"
          disabled={creating}
        />
        <button
          type="submit"
          disabled={!name.trim() || creating}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md transition-colors"
        >
          <Plus size={16} /> New project
        </button>
      </form>

      {loading && (
        <div className="text-gray-500 text-sm">Loading…</div>
      )}

      {!loading && projects.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <Film className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No timeline projects yet. Create one above to start compositing clips.</p>
        </div>
      )}

      {!loading && projects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((project) => {
            const { totalSec, firstThumb } = projectStats.get(project.id) || { totalSec: 0, firstThumb: null };
            return (
              <div key={project.id} className="bg-port-card border border-port-border rounded-xl overflow-hidden hover:border-port-accent/50 transition-colors">
                <button
                  type="button"
                  onClick={() => navigate(`/media/timeline/${project.id}`)}
                  className="block w-full aspect-video bg-port-bg relative"
                >
                  {firstThumb ? (
                    <img src={firstThumb} alt={project.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-600">
                      <Film className="w-10 h-10" />
                    </div>
                  )}
                </button>
                <div className="p-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/media/timeline/${project.id}`)}
                      className="flex-1 text-left text-sm font-medium text-white hover:text-port-accent transition-colors truncate"
                    >
                      {project.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(project)}
                      className="p-1 text-gray-500 hover:text-port-error transition-colors"
                      title="Delete project"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span className="flex items-center gap-1"><Film className="w-3 h-3" />{(project.clips || []).length} clips</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(totalSec)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
