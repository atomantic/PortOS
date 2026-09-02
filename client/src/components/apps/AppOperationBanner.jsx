import { Check, X, AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import ActivityLog from './ActivityLog';

const LABELS = {
  update: { running: 'Updating', done: 'Updated', failed: 'Update failed for' },
  standardize: { running: 'Standardizing', done: 'Standardized', failed: 'Standardize failed for' }
};

/**
 * Page-level banner for an in-flight app update/standardize. It lives above the
 * app list rather than inside the expanded row so collapsing the row — or
 * returning to /apps mid-operation — still shows what is running (#3435).
 */
export default function AppOperationBanner({ appName, type, steps, error, completed, onDismiss, completedMessage }) {
  const labels = LABELS[type] || LABELS.update;
  const name = appName || 'app';
  const heading = error ? `${labels.failed} ${name}` : completed ? `${labels.done} ${name}` : `${labels.running} ${name}…`;
  const tone = error
    ? 'border-port-error/40 bg-port-error/10'
    : completed
      ? 'border-port-success/40 bg-port-success/10'
      : 'border-port-accent/40 bg-port-accent/10';

  return (
    <div
      className={`rounded-xl border p-3 backdrop-blur ${tone}`}
      role="status"
      aria-live="polite"
      aria-label="App operation status"
    >
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5">
          {error
            ? <AlertTriangle size={16} aria-hidden="true" className="text-port-error" />
            : completed
              ? <Check size={16} aria-hidden="true" className="text-port-success" />
              : <BrailleSpinner text="" className="text-port-accent" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-white">{heading}</div>
          <div className="text-xs text-gray-400">
            {error
              ? error
              : completed
                ? completedMessage || 'You can start another operation now.'
                : 'This keeps running if you collapse the row or leave the page.'}
          </div>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="shrink-0 p-1 rounded text-gray-400 hover:text-white focus:outline-hidden focus:ring-2 focus:ring-port-accent"
            aria-label={`Dismiss ${name} operation status`}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <ActivityLog steps={steps} error={null} completed={false} />
    </div>
  );
}
