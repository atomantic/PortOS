import AppIcon from './AppIcon';

export default function AppContextPicker({
  apps = [],
  value = '',
  onChange,
  label = 'App context',
  placeholder = 'PortOS (default)',
  ariaLabel,
  includeDefaultOption = true,
  className = '',
  selectClassName = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm min-h-[44px]',
  showRepoPath = true,
  repoLabel = 'Repository'
}) {
  const selectedApp = apps.find(app => app.id === value);

  const content = (
    <div className="space-y-2">
      <select
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className={selectClassName}
        aria-label={ariaLabel || label || placeholder}
      >
        {includeDefaultOption && <option value="">{placeholder}</option>}
        {apps.map(app => (
          <option key={app.id} value={app.id}>{app.name}</option>
        ))}
      </select>

      {showRepoPath && (
        <div className="rounded-lg border border-port-border bg-port-bg/50 px-3 py-2 text-xs text-gray-400">
          {selectedApp ? (
            <div className="flex items-start gap-2">
              <AppIcon
                icon={selectedApp.icon || 'package'}
                appId={selectedApp.id}
                hasAppIcon={!!selectedApp.appIconPath}
                size={14}
                className="mt-0.5 shrink-0 text-gray-400"
              />
              <div className="min-w-0">
                <div className="font-medium text-gray-200">{selectedApp.name}</div>
                <div className="truncate text-gray-500" title={selectedApp.repoPath || ''}>
                  {repoLabel}: {selectedApp.repoPath || 'No repo path'}
                </div>
              </div>
            </div>
          ) : (
            <div>{repoLabel}: using default PortOS context</div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={className}>
      {label ? (
        <label className="block text-xs text-gray-400">
          {label}
          <div className="mt-1">{content}</div>
        </label>
      ) : content}
    </div>
  );
}
