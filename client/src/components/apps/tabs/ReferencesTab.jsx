import ReferenceReposPanel from '../ReferenceReposPanel';

/**
 * App-detail "References" tab — full CRUD over the app's reference repos.
 * The global summary at /reference-repos uses the same panel in `compact`
 * mode (read-and-check, no add/delete). Add/edit/remove always happens
 * here so the per-app context is unambiguous.
 */
export default function ReferencesTab({ appId, appName }) {
  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <ReferenceReposPanel appId={appId} appName={appName} />
    </div>
  );
}
