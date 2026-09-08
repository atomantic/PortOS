import { useCallback, useState } from 'react';
import toast from '../components/ui/Toast';
import useMounted from './useMounted';

/**
 * The propose → review → selectively-apply loop for character augmentation
 * (#6415 / #6417), shared by the Universe cast panel and the Writers Room
 * synced review's Cast pane.
 *
 * Both surfaces run the identical three-step dance over the same server
 * contract — one call proposes, the author ticks individual fields, a second
 * call takes back only what was ticked — and it is the *rules* in that dance,
 * not the layout, that must not drift between them:
 *
 *   - **Nothing is accepted until it is ticked.** A fresh proposal opens with
 *     an empty selection, so a bulk "apply" can never sweep in a rewrite the
 *     author didn't read.
 *   - **"No improvement offered" is a success, not an error.** A model that
 *     honestly declines to paraphrase must not read as a failed call.
 *   - **A locked character stops the flow at both ends**, because a lock can be
 *     set between the proposal and the apply.
 *
 * The caller supplies only the two request thunks (which host, which record)
 * and an `onApplied` for whatever its own view has to refresh.
 *
 * @param {object} args
 * @param {(characterId: string, fields: string[]) => Promise<object>} args.propose
 * @param {(characterId: string, body: { fields: Array<{field: string, value: string}>, fingerprint?: string }) => Promise<object>} args.apply
 * @param {(result: object, preview: object) => void} [args.onApplied] runs after a successful apply
 */
export default function useCharacterAugmentation({ propose, apply, onApplied }) {
  const mountedRef = useMounted();
  // `{ characterId, entryName, fingerprint, proposals: [] }` awaiting review.
  const [preview, setPreview] = useState(null);
  const [accepted, setAccepted] = useState(() => new Set());
  const [proposing, setProposing] = useState(false);
  const [applying, setApplying] = useState(false);

  const discard = useCallback(() => {
    setPreview(null);
    setAccepted(new Set());
  }, []);

  const toggleField = useCallback((field) => setAccepted((prev) => {
    const next = new Set(prev);
    if (next.has(field)) next.delete(field); else next.add(field);
    return next;
  }), []);

  const runPropose = useCallback(async (characterId, entryName, fields) => {
    if (proposing || !fields?.length) return;
    setProposing(true);
    const result = await propose(characterId, fields)
      .catch((err) => { toast.error(err.message || 'Augment failed'); return null; });
    if (mountedRef.current) setProposing(false);
    if (!result || !mountedRef.current) return;
    if (result.locked) {
      toast.error(`${result.entry?.name || entryName || 'Character'} is locked — unlock before augmenting`);
      return;
    }
    if (!result.proposals?.length) {
      toast.success('Nothing to sharpen — the model had no improvement to offer');
      return;
    }
    setPreview({
      characterId,
      entryName: result.entry?.name || entryName || 'Character',
      fingerprint: result.fingerprint,
      proposals: result.proposals,
    });
    // Opt-IN: nothing is accepted until the author ticks it.
    setAccepted(new Set());
  }, [propose, proposing, mountedRef]);

  const runApply = useCallback(async () => {
    if (applying || !preview) return;
    const fields = preview.proposals
      .filter((p) => accepted.has(p.field))
      .map((p) => ({ field: p.field, value: p.after }));
    if (fields.length === 0) return;
    setApplying(true);
    const result = await apply(preview.characterId, { fields, fingerprint: preview.fingerprint })
      .catch((err) => { toast.error(err.message || 'Apply failed'); return null; });
    if (mountedRef.current) setApplying(false);
    if (!result || !mountedRef.current) return;
    if (result.locked) {
      toast.error(`${preview.entryName} is locked — unlock before applying`);
      return;
    }
    const n = result.appliedFields?.length || 0;
    toast.success(`Applied ${n} field${n === 1 ? '' : 's'} to ${preview.entryName}`);
    onApplied?.(result, preview);
    setPreview(null);
    setAccepted(new Set());
  }, [apply, applying, preview, accepted, onApplied, mountedRef]);

  return { preview, accepted, proposing, applying, toggleField, discard, runPropose, runApply };
}
