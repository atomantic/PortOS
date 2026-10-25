import { ImagePlus, ScanText, ImageUp, WandSparkles, Loader2, X } from 'lucide-react';

// Shared creative commands; the calling workspace owns the existing workflow.
export default function CharacterActions({ name, disabled = false, renderDisabled = disabled, busy = false, rendering = false,
  onRender, onRefine, onExpand, onDescribe, onCorrect, onRemove }) {
  const commands = [
    [onRender, `Render reference for ${name}`, ImagePlus, rendering, renderDisabled],
    [onRefine, `AI differentiate ${name}`, WandSparkles, busy],
    [onExpand, `AI expand ${name}`, WandSparkles, busy],
    [onDescribe, `Describe ${name} from images`, ScanText],
    [onCorrect, `Correct ${name} from a reference image`, ImageUp],
  ];
  return <div className="flex flex-wrap items-center gap-1">
    {commands.filter(([action]) => action).map(([action, label, Icon, pending, blocked = disabled]) => <button key={label} type="button" onClick={action}
      disabled={blocked || busy || rendering} title={label} aria-label={label}
      className="min-h-11 min-w-11 inline-flex items-center justify-center p-2 rounded text-gray-400 hover:text-port-accent disabled:opacity-30">
      {pending ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
    </button>)}
    {onRemove && <button type="button" onClick={onRemove} title="Remove from this universe; keep the catalog record and assets"
      aria-label={`Remove ${name} from universe`} className="min-h-11 min-w-11 inline-flex items-center justify-center p-2 rounded text-gray-400 hover:text-port-error"><X size={16} /></button>}
  </div>;
}
