import { useRef, useState } from 'react';
import CharacterActions from './CharacterActions';
import VisionDescribeModal from '../universe/VisionDescribeModal';
import CorrectiveReferenceModal from '../universe/CorrectiveReferenceModal';
import { expandUniverseCharacter, refineUniverseCharacter } from '../../services/apiUniverseBuilder';
import useMounted from '../../hooks/useMounted';

// Canonical detail retains the existing universe-scoped creative workflows.
// Description proposals enter the local draft; persisted AI/correction actions
// require saved state and refresh through the existing catalog event contract.
export default function CharacterCanonActions({ universe, entry, disabled, applyDisabled = disabled, onPatch, onChanged, onPendingChange }) {
  const mounted = useMounted();
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null);
  const [error, setError] = useState(null);
  const run = action => {
    if (disabled || flight.current) return;
    flight.current = true; setBusy(true); setError(null); onPendingChange(true);
    action(universe.id, entry.id, { providerId: universe.llm?.provider, model: universe.llm?.model }, { silent: true }).then(result => {
      if (!mounted.current) return;
      if (result.locked) throw new Error('The character is locked. Refresh before trying again.');
      onChanged(result.universe);
    }).catch(error => { if (mounted.current) setError(error.message); }).finally(() => {
      flight.current = false;
      if (mounted.current) { setBusy(false); onPendingChange(false); }
    });
  };
  return <div className="rounded border border-port-border p-2 space-y-1">
    <p className="text-xs text-gray-400">Universe creative tools · save edits before using AI actions</p>
    <CharacterActions name={entry.name} disabled={disabled} busy={busy}
      onRefine={() => run(refineUniverseCharacter)} onExpand={() => run(expandUniverseCharacter)}
      onDescribe={() => { setModal('describe'); onPendingChange(true); }} onCorrect={() => { setModal('correct'); onPendingChange(true); }} />
    {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    {modal === 'describe' && <VisionDescribeModal open kind="character" entryName={entry.name} universeId={universe.id} entryId={entry.id}
      onApply={description => { if (!applyDisabled) onPatch({ physicalDescription: description }); }}
      onApplyFields={patch => { if (!applyDisabled) onPatch(patch); }} onClose={() => { setModal(null); onPendingChange(false); }} />}
    {modal === 'correct' && <CorrectiveReferenceModal open kind="character" entryName={entry.name} universeId={universe.id} entryId={entry.id}
      onApplied={result => onChanged(result.universe)} onClose={() => { setModal(null); onPendingChange(false); }} />}
  </div>;
}
