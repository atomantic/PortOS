import { Link, useLocation, useNavigate } from 'react-router';
import { Compass, ArrowLeft, LayoutDashboard } from 'lucide-react';
import { modKey } from '../utils/platform';

// Catch-all for unknown routes. This used to be a bare `<Navigate to="/" />`,
// which silently deposited the user on the Dashboard after the page-loader
// spinner — indistinguishable from "your page is loading" followed by the app
// losing the navigation (issue #3793). Name the route that didn't match and
// offer real ways forward instead of bouncing.
export default function NotFound() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const attempted = `${pathname}${search}${hash}`;

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto">
      <div className="bg-port-card border border-port-border rounded-xl p-6 md:p-8 text-center">
        <Compass className="w-8 h-8 mx-auto mb-3 text-gray-600" />
        <h1 className="text-lg font-semibold text-gray-100">That page doesn&apos;t exist</h1>
        <p className="mt-2 text-sm text-gray-400">
          Nothing in PortOS is mounted at{' '}
          <code className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-300 break-all">{attempted}</code>.
          It may have been renamed, or the link may be mistyped.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-3 py-1.5 text-sm bg-port-card border border-port-border text-gray-200 rounded hover:bg-port-border inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-4 h-4" /> Go back
          </button>
          <Link
            to="/"
            className="px-3 py-1.5 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80 inline-flex items-center gap-1.5"
          >
            <LayoutDashboard className="w-4 h-4" /> Dashboard
          </Link>
        </div>
        <p className="mt-4 text-xs text-gray-500">
          Press <kbd className="px-1 py-0.5 rounded bg-port-bg border border-port-border">{modKey}+K</kbd> to search every page by name.
        </p>
      </div>
    </div>
  );
}
