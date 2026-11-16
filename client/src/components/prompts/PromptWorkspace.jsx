// Places one Prompt Manager tab's catalogue (record list) and editor. Wide:
// catalogue column beside the editor. Narrow: with a record open, its editor
// leads (title, read state and actions at the top) and the catalogue opens in
// a Drawer from a "Choose another…" row; with nothing open, the catalogue is
// the whole view (#11142). Either way each control exists once, so
// Save/Preview are never duplicated.
import { List } from 'lucide-react';
import Drawer from '../Drawer';
import PageSkeleton from '../ui/PageSkeleton';

export default function PromptWorkspace({
  splitPane, loading, catalogue, editor, active, noun, title, chooserOpen, onChooserOpenChange,
}) {
  if (loading) return <PageSkeleton header="none" label="Loading prompts" cards={3} sidebar={false} />;
  const catalogueCard = <div className="bg-port-card border border-port-border rounded-xl p-4">{catalogue}</div>;
  if (splitPane) {
    return (
      <div className="grid grid-cols-3 gap-6">
        {catalogueCard}
        <div className="col-span-2 space-y-4">{editor}</div>
      </div>
    );
  }
  if (!active) return catalogueCard;
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => onChooserOpenChange(true)}
        aria-haspopup="dialog"
        className="w-full min-h-[44px] flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-port-card border border-port-border text-sm text-gray-300 hover:text-white"
      >
        <List size={16} /> Choose another {noun}…
      </button>
      {editor}
      <Drawer
        open={chooserOpen}
        onClose={() => onChooserOpenChange(false)}
        title={title}
        size="sm"
        closeLabel={`Close ${noun} list`}
      >
        {catalogue}
      </Drawer>
    </div>
  );
}
