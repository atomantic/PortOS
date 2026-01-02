import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Code, Server, Globe, Plus } from 'lucide-react';
import * as api from '../services/api';

const ICONS = {
  layers: Layers,
  code: Code,
  server: Server,
  globe: Globe
};

export default function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [createMode, setCreateMode] = useState(false);
  const [appName, setAppName] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    const serverTemplates = await api.getTemplates().catch(() => []);
    setTemplates(serverTemplates);
    setLoading(false);
  };

  const handleSelectTemplate = (template) => {
    setSelectedTemplate(template);
    setCreateMode(true);
    setAppName('');
    setTargetPath('');
    setError(null);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!appName || !targetPath || !selectedTemplate) return;

    setCreating(true);
    setError(null);

    const result = await api.createFromTemplate({
      templateId: selectedTemplate.id,
      name: appName,
      targetPath
    }).catch(err => ({ error: err.message }));

    setCreating(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    navigate('/apps');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading templates...</div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">App Templates</h1>
          <p className="text-gray-500">Create new apps from pre-configured templates</p>
        </div>
        <button
          onClick={() => navigate('/create')}
          className="px-4 py-2 text-gray-400 hover:text-white"
        >
          ← Back to Import
        </button>
      </div>

      {createMode && selectedTemplate ? (
        <div className="bg-port-card border border-port-border rounded-xl p-6">
          <div className="flex items-center gap-3 mb-6">
            {(() => {
              const Icon = ICONS[selectedTemplate.icon] || Layers;
              return <Icon size={24} className="text-port-accent" />;
            })()}
            <div>
              <h2 className="text-lg font-semibold text-white">{selectedTemplate.name}</h2>
              <p className="text-sm text-gray-400">{selectedTemplate.description}</p>
            </div>
          </div>

          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">App Name *</label>
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="my-new-app"
                required
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1">Target Directory *</label>
              <input
                type="text"
                value={targetPath}
                onChange={(e) => setTargetPath(e.target.value)}
                placeholder="/Users/you/projects"
                required
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-none font-mono"
              />
              <p className="text-xs text-gray-500 mt-1">
                App will be created at: {targetPath ? `${targetPath}/${appName || 'app-name'}` : '...'}
              </p>
            </div>

            {error && (
              <div className="p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
                {error}
              </div>
            )}

            <div className="flex justify-between pt-4">
              <button
                type="button"
                onClick={() => { setCreateMode(false); setSelectedTemplate(null); }}
                className="px-4 py-2 text-gray-400 hover:text-white"
              >
                ← Back
              </button>
              <button
                type="submit"
                disabled={!appName || !targetPath || creating}
                className="px-6 py-3 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create App'}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map(template => {
            const Icon = ICONS[template.icon] || Layers;
            return (
              <button
                key={template.id}
                onClick={() => handleSelectTemplate(template)}
                className="text-left p-6 bg-port-card border border-port-border rounded-xl hover:border-port-accent transition-colors group"
              >
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-port-accent/10 rounded-lg">
                    <Icon size={24} className="text-port-accent" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-white group-hover:text-port-accent transition-colors">
                        {template.name}
                      </h3>
                      {template.builtIn && (
                        <span className="text-xs px-2 py-0.5 bg-port-accent/20 text-port-accent rounded">
                          Built-in
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-400 mt-1">{template.description}</p>
                    {template.features && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {template.features.slice(0, 3).map((f, i) => (
                          <span key={i} className="text-xs px-2 py-0.5 bg-port-border rounded text-gray-400">
                            {f}
                          </span>
                        ))}
                        {template.features.length > 3 && (
                          <span className="text-xs px-2 py-0.5 text-gray-500">
                            +{template.features.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}

          {/* Add Template Card */}
          <button
            onClick={() => navigate('/templates/new')}
            className="p-6 border-2 border-dashed border-port-border rounded-xl hover:border-port-accent/50 transition-colors flex items-center justify-center gap-3 text-gray-500 hover:text-gray-400"
          >
            <Plus size={20} />
            <span>Add Custom Template</span>
          </button>
        </div>
      )}

      {/* Info */}
      <div className="mt-8 p-4 bg-port-border/30 rounded-lg">
        <h4 className="text-sm font-medium text-white mb-2">About Templates</h4>
        <p className="text-sm text-gray-400">
          Templates are pre-configured project structures that include common patterns,
          dependencies, and configurations. The built-in PortOS Stack template mirrors
          this application's architecture.
        </p>
      </div>
    </div>
  );
}
