import ReferenceReposPanel from '../ReferenceReposPanel';

/**
 * App-detail "References" tab — the single surface for managing the
 * app's reference repos. Reference repos are app-scoped only; there
 * is no global summary page.
 */
export default function ReferencesTab({ appId, appName }) {
  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <ReferenceReposPanel appId={appId} appName={appName} />
    </div>
  );
}
