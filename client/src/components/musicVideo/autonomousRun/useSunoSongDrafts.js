import { isSunoSongUrl, sunoSongIdFromUrl } from '../../../../../server/lib/sunoSong.js';
import { canAdoptSunoSong } from '../../../../../server/lib/musicVideo/musicVideoAutonomous.js';
import useScopedDraft from './useScopedDraft.js';

const BARE_SUNO_SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A bare Suno song id or a Suno song page link; an id inside any other URL or text is not one.
const pastedSunoSongId = (text) => {
  const value = text.trim();
  if (BARE_SUNO_SONG_ID.test(value)) return value.toLowerCase();
  return isSunoSongUrl(value) ? sunoSongIdFromUrl(value) : null;
};

export default function useSunoSongDrafts(run, awaiting, sunoCount) {
  // New renders after a retake get a fresh pick and link; manual adoption is scoped to the song attempt.
  const renders = awaiting === 'song' && run?.stage === 'song' && !run.output?.trackId && sunoCount ? run.output.sunoSongIds : [];
  const canAdopt = run ? canAdoptSunoSong(run) : false;
  const scope = `${run?.id}:${canAdopt ? run.stages?.song?.startedAt || run.status : renders.join(',')}`;
  const defaultRender = renders[renders.length > 1 ? 1 : 0];
  const { value: picked, setValue: setPicked } = useScopedDraft(scope, defaultRender);
  const { value: linkText, setValue: setLinkText, clear: clearLink } = useScopedDraft(scope, '');
  const linkedId = pastedSunoSongId(linkText);
  const pickedRender = renders.length ? linkedId || (renders.includes(picked) ? picked : defaultRender) : null;
  const overrideRender = pickedRender && !(run.output?.songTakeApproved === false && pickedRender === renders[0]);
  return {
    renders, canAdopt, linkText, setLinkText, linkedId, pickedRender, overrideRender,
    invalidLink: linkText.trim() !== '' && !linkedId,
    pickRender: (id) => {
      setPicked(id);
      clearLink();
    },
  };
}
