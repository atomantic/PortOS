// One Prompt Manager catalogue (stages, variables, job skills, providers): it
// loads, fails and retries on its own. A failed read keeps the rows already on
// screen (flagged stale) and never reads as an empty list, so "unavailable"
// can't be mistaken for "no records" or "deleted".
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @param {() => Promise<object>} load  Silent read of the catalogue.
 * @param {(res: object) => *} select   Maps a successful response to the stored data.
 * @param {*} empty                     Data before the first successful read; a stable reference.
 * @param {number} reloadKey            Bumped by the page's Reload button to re-read.
 * @returns {{ data, failed: boolean, loaded: boolean, settled: boolean, reload: () => Promise<void> }}
 *   `loaded` = a read has succeeded; `settled` = a read has finished either way.
 */
export default function usePromptCatalogue(load, select, empty, reloadKey) {
  const [state, setState] = useState({ data: empty, failed: false, loaded: false, settled: false });
  const fnRef = useRef(null);
  fnRef.current = { load, select };
  // Only the newest read may land: a slow earlier refresh resolving after a
  // later one would otherwise put older rows back on screen.
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    const res = await fnRef.current.load().catch(() => null);
    if (seqRef.current !== seq) return;
    if (res && typeof res === 'object') {
      setState({ data: fnRef.current.select(res), failed: false, loaded: true, settled: true });
    } else {
      setState((prev) => ({ ...prev, failed: true, settled: true }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload, reloadKey]);

  return { ...state, reload };
}
