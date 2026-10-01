import { useState } from 'react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { preflightCodeAnimationProject } from '../../services/apiCodeAnimation';

export default function ProductionPreflight({ project, disabled }) {
  const [result, setResult] = useState(null);
  const [check, checking] = useAsyncAction(async () => {
    setResult(null);
    setResult(await preflightCodeAnimationProject(project.id, { silent: true }));
  });
  return <div className="space-y-2">
    <button type="button" disabled={disabled || checking} onClick={check} className="rounded border border-port-border px-3 py-2 text-sm disabled:opacity-50">{checking ? 'Checking settings…' : 'Check saved authoring settings'}</button>
    {!disabled && result && <div role="status" className="space-y-2 text-sm">
      <p>{result.problems.length ? 'Settings need attention' : 'Settings are compatible with the configured route'}</p>
      {result.resolved && <p className="break-words text-gray-400">{result.resolved.harness} · {result.resolved.mode} · {result.resolved.model || 'Unknown model'} · Effort: {result.resolved.effort || 'Unspecified'}</p>}
      {result.problems.map(problem => <p key={problem} className="text-port-warning">{problem}</p>)}
      {result.notes.map(note => <p key={note} className="text-gray-400">{note}</p>)}
      <p className="text-gray-400">No provider was called. Actual execution settings remain unverified.</p>
    </div>}
  </div>;
}
