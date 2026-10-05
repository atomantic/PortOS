import { useEffect, useState } from 'react';
import { musicVideoReviewDrafts } from '../../../server/lib/musicVideoReviewDraft.js';

/** Resolve only the implicit review choice. Explicit drawer versions never fall back. */
export function useMusicVideoReviewDraft(project, { enabled = true } = {}) {
  const candidatesKey = JSON.stringify(enabled ? musicVideoReviewDrafts(project) : []);
  const [result, setResult] = useState(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const candidates = JSON.parse(candidatesKey);
    const resolve = async () => {
      let unavailableCount = 0;
      for (const draft of candidates) {
        try {
          const response = await fetch(draft.src, { method: 'HEAD', signal: controller.signal });
          if (!active) return;
          if (response.ok) {
            setResult({ key: candidatesKey, draft, unavailableCount });
            return;
          }
        } catch {
          if (!active) return;
        }
        unavailableCount += 1;
      }
      if (active) setResult({ key: candidatesKey, draft: null, unavailableCount });
    };
    resolve();
    return () => { active = false; controller.abort(); };
  }, [candidatesKey]);
  const checking = result?.key !== candidatesKey && candidatesKey !== '[]';
  return { draft: result?.key === candidatesKey ? result.draft : null,
    checking, unavailableCount: result?.key === candidatesKey ? result.unavailableCount : 0 };
}
