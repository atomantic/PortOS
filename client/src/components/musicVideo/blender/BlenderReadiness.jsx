import { useEffect, useRef, useState } from 'react';
import ProductionContainment from '../../codeAnimation/ProductionContainment';
import { buttonCls } from './blenderStyles.js';

const signature = (ready, mode) => `${ready ? 'ready' : 'blocked'}:${mode || ''}`;

/**
 * Whether Blender can render this film, and how to fix it in place: the
 * shared Blender setup (the operator's Blender path, execution mode and
 * check) is embedded here, and a change made in it re-reads the film's state.
 * A Blender film needs Trusted local execution: its scripts drive the GPU
 * and write renders into the project's workspace.
 */
export default function BlenderReadiness({ blender }) {
  const tool = blender.state.tool || {};
  const contained = !!tool.executionMode && tool.executionMode !== 'trusted-local';
  const toolSignature = signature(tool.ready, tool.executionMode);
  const reported = useRef(toolSignature);
  useEffect(() => { reported.current = toolSignature; }, [toolSignature]);
  const [openRequest, setOpenRequest] = useState(0);
  const starting = Object.keys(blender.pending).some((key) => key === 'sync' || key.startsWith('render:'));
  // The setup component reports its own reading; refresh only when it differs from the last one seen here.
  const onExecutionChange = (execution) => {
    if (!execution) return;
    const next = signature(execution.lanes?.blender?.ready === true, execution.executionMode);
    if (next === reported.current) return;
    reported.current = next;
    blender.refresh();
  };

  return (
    <section aria-label="Blender readiness" className="min-w-0 space-y-2">
      {contained ? (
        <div role="status" className="space-y-1.5 rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs">
          <p>
            Blender is set to contained execution, and a Blender film cannot render there: its scripts drive the GPU and write
            into this project&apos;s workspace. In Blender setup choose Trusted local, save, then Check Blender.
          </p>
          <button type="button" className={buttonCls} onClick={() => setOpenRequest((count) => count + 1)}>Open Blender setup</button>
        </div>
      ) : !tool.ready ? (
        <p role="status" className="rounded border border-port-warning/40 bg-port-warning/10 p-2 text-xs">
          Blender is not ready{tool.reason ? `: ${tool.reason}` : '.'} In Blender setup below select the installed Blender, choose
          Trusted local, save, then Check Blender. Renders stay off until the check passes.
        </p>
      ) : (
        <p className="text-xs text-port-text-muted">
          Blender{tool.version ? ` ${tool.version}` : ''} is ready in Trusted local mode.
        </p>
      )}
      <ProductionContainment inline rendererKind="blender" onExecutionChange={onExecutionChange} openRequest={openRequest} locked={starting} />
    </section>
  );
}
