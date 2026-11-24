import { Link } from 'react-router';
import { BLENDER_EXECUTION_PATH } from '../../lib/blenderModels.js';
import { buttonCls } from '../musicVideo/blender/blenderStyles.js';

/** Whether this machine can build Blender models: the server's reason and where to fix it, or (unless `quiet`) the ready line. */
export default function BlenderModelReadiness({ tool, quiet = false }) {
  if (!tool) return null;
  if (tool.ready) {
    return quiet ? null : <p className="text-xs text-port-text-muted">Blender{tool.version ? ` ${tool.version}` : ''} is ready in Trusted local mode.</p>;
  }
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs">
      <span className="min-w-0 flex-1 basis-40 break-words">Blender cannot build models yet{tool.reason ? `: ${tool.reason}` : '.'}</span>
      <Link to={BLENDER_EXECUTION_PATH} className={buttonCls}>Open Blender execution</Link>
    </div>
  );
}
