// Flush page header for the catalog ingredient editor: back link, the page's
// own <h1> (`heading`) and type badge, the caller's record controls
// (`children`), then the unsaved status, Save, Thread and an inline-confirmed
// Delete.

import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Loader2, Save, Trash2 } from 'lucide-react';
import AddToThreadButton from '../../threads/AddToThreadButton';
import { CATALOG_BADGE_BY_ID } from '../../../lib/catalogTypes';

export default function IngredientHeader({ heading, record, name, backPath, backLabel, isDirty, overlongVideoDescription, saving, saveDisabled, onSave, readOnly, onDelete, children }) {
  const [armedDelete, setArmedDelete] = useState(false);
  const badgeClass = CATALOG_BADGE_BY_ID[record.type] || 'bg-gray-500/20 text-gray-300 border-gray-500/40';
  const confirmDelete = () => {
    setArmedDelete(false);
    onDelete();
  };
  return (
    // Same flush header + sub-nav as PageHeader/RouteTabsHeader pages:
    // edge to edge under the app nav, only the content below scrolls.
    <header className="shrink-0 px-3 py-2 sm:px-4 sm:py-3 border-b border-port-border">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link to={backPath} aria-label={`Back to ${backLabel}`} title="Back"
            className="shrink-0 inline-flex items-center justify-center min-w-[40px] min-h-[40px] -ml-2 rounded-lg text-gray-400 hover:text-white">
            <ArrowLeft size={18} aria-hidden="true" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              {heading}
              <span className={`shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${badgeClass}`}>
                {record.type}
              </span>
            </div>
            <p className="hidden sm:block text-xs text-gray-500 font-mono truncate leading-tight" title={record.id}>{record.id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {children}
          {isDirty && <span className="text-xs text-port-warning" role="status">Unsaved changes</span>}
          {overlongVideoDescription && <span className="text-xs text-port-error" role="alert">Shorten the description for linked music videos before saving.</span>}
          <button type="button" onClick={onSave} disabled={saveDisabled}
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-lg bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white text-sm font-medium">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
          <AddToThreadButton
            refItem={{
              kind: 'catalog.ingredient',
              id: record.id,
              label: name || record.name || record.id
            }}
            buttonText="Thread"
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 rounded-lg text-sm border border-port-border text-gray-300 hover:text-white hover:border-port-accent/40 transition-colors"
          />
          {armedDelete ? (
            <span className="inline-flex items-center gap-1 text-sm">
              <span className="text-gray-400 px-1">Delete?</span>
              <button type="button" onClick={confirmDelete} disabled={readOnly}
                className="inline-flex items-center gap-1 min-h-[40px] px-3 py-2 rounded-lg bg-port-error/20 text-port-error hover:bg-port-error/30 font-medium">
                <Trash2 size={14} aria-hidden="true" /> Yes, delete
              </button>
              <button type="button" onClick={() => setArmedDelete(false)}
                className="min-h-[40px] px-3 py-2 rounded-lg text-gray-400 hover:text-white">
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setArmedDelete(true)} disabled={readOnly}
              className="inline-flex items-center justify-center gap-1.5 min-w-[40px] min-h-[40px] px-2.5 sm:px-3 py-2 rounded-lg text-sm border border-port-border text-gray-400 hover:text-port-error"
              aria-label="Delete ingredient" title="Delete">
              <Trash2 size={14} aria-hidden="true" /> <span className="hidden sm:inline">Delete</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
