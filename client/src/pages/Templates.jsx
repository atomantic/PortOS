import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useState, useCallback, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Layers, Code, Server, Globe, Smartphone, MonitorSmartphone } from 'lucide-react';
import { getTemplates, createFromTemplate } from '../services/apiScaffold.js';
import FolderPicker from '../components/FolderPicker';
import { FormField } from '../components/ui/FormField';
import PageSkeleton from '../components/ui/PageSkeleton';
import useListResource from '../hooks/useListResource.js';
import ListLoadError from '../components/ui/ListLoadError';

const ICONS = {
  layers: Layers,
  code: Code,
  server: Server,
  globe: Globe,
  smartphone: Smartphone,
  'monitor-smartphone': MonitorSmartphone
};

function TemplatesContent() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('template');
  const [appName, setAppName] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const fetchTemplates = useCallback(async () => {
    const serverTemplates = await getTemplates({ silent: true });
    return Array.isArray(serverTemplates) ? serverTemplates : [];
  }, []);
  const templatesResource = useListResource(fetchTemplates);
  const { items: templates, state: templatesState, error: templatesError, retry: retryTemplates } = templatesResource;

  // The URL owns selection so reload and Browser Back keep the creation form in step.
  // An unknown id (stale link) is only judged once the list is ready, then cleared.
  const selectedTemplate = templatesState === 'ready' && selectedId
    ? templates.find(t => t.id === selectedId) || null
    : null;
  const unknownSelection = templatesState === 'ready' && selectedId && !selectedTemplate;
  useEffect(() => {
    if (unknownSelection) setSearchParams({}, { replace: true });
  }, [unknownSelection, setSearchParams]);

  // Form fields are not in the URL, so any selection change (including Browser Back
  // to another ?template=) must drop them or Create would scaffold A with B's inputs.
  useEffect(() => {
    setAppName('');
    setTargetPath('');
    setError(null);
  }, [selectedId]);

  const handleSelectTemplate = (template) => {
    setSearchParams({ template: template.id });
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!appName || !targetPath || !selectedTemplate) return;

    setCreating(true);
    setError(null);

    const result = await createFromTemplate({
      templateId: selectedTemplate.id,
      name: appName,
      targetPath
    }, { silent: true }).catch(err => ({ error: err.message }));

    setCreating(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    navigate('/apps');
  };

  if (templatesState === 'loading') {
    return (
      <PageSkeleton
        label="Loading app templates"
        headerRowClass="flex flex-col sm:flex-row sm:items-center justify-between gap-2"
        titleWidthClass="w-56"
        showSubtitle
        subtitleOnMobile
        layout="grid"
        cards={6}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-6">
        <p className="text-gray-500 text-sm sm:text-base">Create new apps from pre-configured templates</p>
        <Link
          to="/apps/create"
          className="px-4 py-2 text-gray-400 hover:text-white text-sm sm:text-base self-start sm:self-auto"
        >
          ← Back to Import
        </Link>
      </div>

      {selectedTemplate ? (
        <div className="bg-port-card border border-port-border rounded-xl p-6 max-w-2xl">
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
            <FormField label="App Name *">
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="my-new-app"
                required
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>

            <div>
              <label htmlFor="template-target-directory" className="block text-sm text-gray-400 mb-1">Target Directory *</label>
              <div className="flex gap-2 items-stretch">
                <input
                  id="template-target-directory"
                  type="text"
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  placeholder="/path/to/parent/directory"
                  required
                  className="flex-1 min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm focus:border-port-accent focus:outline-hidden"
                />
                <FolderPicker value={targetPath} onChange={setTargetPath} />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                App will be created at: {targetPath ? `${targetPath}/${appName || 'app-name'}` : '...'}
              </p>
            </div>

            {error && (
              <div role="alert" className="p-3 bg-port-error/20 border border-port-error rounded-lg text-port-error text-sm">
                {error}
              </div>
            )}

            <div className="flex justify-between pt-4">
              <button
                type="button"
                onClick={() => setSearchParams({})}
                className="px-4 py-2 border border-port-border rounded-lg text-gray-400 hover:text-white hover:border-port-accent transition-colors"
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
        <>
          {templatesState === 'error' && (
            <ListLoadError className="mb-4" what="app templates" error={templatesError} onRetry={retryTemplates} />
          )}
          {templatesState === 'ready' && templates.length === 0 && (
            <p className="text-sm text-gray-500 mb-4">No app templates available.</p>
          )}
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
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
                      <h2 className="font-semibold text-white group-hover:text-port-accent transition-colors">
                        {template.name}
                      </h2>
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
        </div>
        </>
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

export default function Templates() {
  return (
    <PageLayout header={<PageHeader icon={Layers} title="App Templates" />}>
      <TemplatesContent />
    </PageLayout>
  );
}
