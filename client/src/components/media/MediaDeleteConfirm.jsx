import InlineConfirmRow from '../ui/InlineConfirmRow';
import MediaUsageList from './MediaUsageList';

// The inline delete confirmation shared by the history card and the preview
// lightbox, so both ask the same question and take the same in-use path. A
// file other records use lists them and offers "Delete anyway", which calls
// `onDelete(item, { force: true })`.
export default function MediaDeleteConfirm({ item, usages, onDelete, onCancel, onNavigate }) {
  const runDelete = (...options) => { onCancel(); onDelete(item, ...options); };
  if (Array.isArray(usages) && usages.length > 0) {
    return (
      <div role="group" aria-label="Delete a file in use" className="w-full space-y-1 text-[11px]">
        <p className="text-port-warning">Used in {usages.length} {usages.length === 1 ? 'place' : 'places'}. Swap it out there first:</p>
        <MediaUsageList usages={usages} onNavigate={onNavigate} />
        <InlineConfirmRow
          question="Or delete it anyway; those places lose it."
          confirmText="Delete anyway"
          confirmTitle="Delete even though records use it, moving files to Trash on the PortOS host"
          onConfirm={() => runDelete({ force: true })}
          onCancel={onCancel}
          stacked
        />
      </div>
    );
  }
  return (
    <InlineConfirmRow
      question={`Delete this ${item.kind === 'video' ? 'video' : 'image'}?`}
      confirmText="Delete"
      confirmTitle="Move files to Trash or Recycle Bin on the PortOS host"
      onConfirm={() => runDelete()}
      onCancel={onCancel}
    />
  );
}
