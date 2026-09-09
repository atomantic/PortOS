import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { useParams, useSearchParams } from 'react-router';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import useBeeperRealtime from '../../hooks/useBeeperRealtime';
import useMounted from '../../hooks/useMounted';
import { getBeeperStatus } from '../../services/api';
import BeeperChatSurface from './beeper/BeeperChatSurface';
import BeeperSettingsPanel from './beeper/BeeperSettingsPanel';

/**
 * Comms → Messages → Beeper. The page shell for the chat surface (#35).
 *
 * It owns exactly two things the surface and the settings panel must share:
 *
 *  1. **The page-level realtime subscription.** `useBeeperRealtime` pairs its
 *     own `beeper:subscribe`/`beeper:unsubscribe` per mount, and several
 *     subscribers may be live at once — `useBeeperOutbox`, reached through
 *     `BeeperChatSurface`, mounts its own instance to refetch the outbox on a
 *     `message.upserted` invalidation (`client/src/hooks/README.md` sanctions
 *     this). This is the ONE that owns the status card: its liveness snapshot
 *     plus an invalidation counter (and the frames behind it, for
 *     `BeeperChatSurface`'s own frame-scoped thread refetch) are handed down
 *     as props, so the settings drawer never needs a subscription of its own.
 *     Sweep state (`sweep`) and `tokenConfigured` ride the same status fetch
 *     (#80) — no second poller, and every invalidation frame the sweep itself
 *     fires as it goes (see `beeperSync.js`) refreshes it here too.
 *  2. **The settings drawer.** #30's status card is not removed by the chat
 *     surface landing — it moves behind a header action, deep-linked as
 *     `?settings=1` exactly like the iMessage ingestion drawer, so ⌘K and voice
 *     can open it and an actionable fault still has a home that is not a
 *     global banner.
 *
 * The open conversation is the route param on `/messages/beeper/:conversationId`
 * (Messages routes it as the shared `:chatKey` segment), never local state.
 */

// The OAuth 2.0 error codes Beeper's own consent screen can send back,
// mapped to a plain sentence rather than shown raw — the bare code read as
// implementation detail with no remedy. An unrecognized code still gets a
// generic sentence rather than disappearing, with the raw code kept as a
// trailing parenthetical either way so the exact server-reported reason is
// never lost, only never led with.
const OAUTH_ERROR_SENTENCES = {
  access_denied: 'Beeper connect was not approved',
  invalid_scope: 'Beeper could not grant the access PortOS asked for',
  server_error: 'Beeper reported a server error during connect',
};
const oauthErrorSentence = (code) => `${OAUTH_ERROR_SENTENCES[code] || 'Beeper connect failed'} (${code})`;

export default function BeeperTab() {
  const { chatKey } = useParams();
  const [settingsParam, setSettingsParam] = useDrawerTab('settings', null, ['1']);
  // `invalidationSeq` is the "something changed, re-read the mirror" pulse —
  // still a bare counter, because the list/networks refetch it drives (design
  // decision: other chats' previews and unread counts always refresh) needs no
  // frame detail. `invalidationFramesRef` rides alongside it as a MAILBOX, not
  // React state: `BeeperChatSurface` needs each frame's own `chatID` to decide
  // whether the OPEN THREAD is in scope for a refetch (audit cluster 07,
  // findings PERF-6/BEEP-5) — a counter alone cannot tell "another chat
  // changed" from "this one did". It is a ref rather than state because the
  // surface drains it itself once it has scheduled a refetch for everything
  // currently in it, so relaying frames down costs no extra render and needs
  // no hand-back of "how many did you consume".
  const invalidationFramesRef = useRef([]);
  const [invalidationSeq, setInvalidationSeq] = useState(0);

  const mountedRef = useMounted();
  const onInvalidate = useCallback((frame) => {
    invalidationFramesRef.current.push(frame ?? null);
    setInvalidationSeq((seq) => seq + 1);
  }, []);
  const { realtime, seedRealtime } = useBeeperRealtime({ onInvalidate });

  // The outbound runaway breaker's read model (#36, decided on #8). The
  // composer disables Send off this — the SAME status the settings drawer's
  // `BeeperOutboxBreakerBanner` already reads — rather than a second banner on
  // the chat surface, which #12 decision 4 reserves for the settings card.
  const [breaker, setBreaker] = useState(null);

  // Sweep visibility (#80): running/idle, started/finished, accounts done of
  // the total, chats and messages mirrored so far — the list header's
  // "Syncing… N of M accounts" / "Last synced HH:MM" strip reads this, and
  // `tokenConfigured` is what the empty state branches on instead of
  // `networks.length` alone. Both ride the SAME status fetch as `realtime`
  // and `breaker` below, reusing the existing mount + invalidation-frame
  // triggers rather than adding a second poller — a sweep's own per-account
  // progress reaches here because `beeperSync.js` fires an invalidation frame
  // as it goes (see beeperSync.js's `emitSweepInvalidation`).
  const [sweep, setSweep] = useState(null);
  const [tokenConfigured, setTokenConfigured] = useState(false);

  // Seeded from the page, not from the settings drawer: `beeper:subscribe`
  // does not push the current transport state, and the drawer's own status
  // fetch only runs once it is opened — so without this the rail's dot would
  // stay blank on a healthy install until something changed. The breaker flag
  // rides the same fetch for the same reason: the composer needs it before the
  // user has ever opened the settings drawer.
  const seedStatus = useCallback(() => {
    getBeeperStatus({ silent: true })
      .then((status) => {
        if (!mountedRef.current) return;
        if (status?.realtime) seedRealtime(status.realtime);
        setBreaker(status?.outbox?.breaker || null);
        setSweep(status?.sweep || null);
        setTokenConfigured(status?.tokenConfigured === true);
      })
      .catch(() => {});
  }, [seedRealtime, mountedRef]);

  // Re-read on the invalidation counter, not only at mount. `seedStatus` is a
  // stable callback, so keying the effect on it alone made this a MOUNT-TIME
  // SNAPSHOT: a breaker that trips during the session (a send loop, three
  // refused sends in a row) never reached the composer, which stayed live
  // against a server that would refuse every send until a human cleared it —
  // and the only way to see the truth was a page reload. The counter is the
  // one "something moved" signal this page already owns.
  useEffect(() => { seedStatus(); }, [seedStatus, invalidationSeq]);

  // Beeper redirects the BROWSER back to this PAGE after consent (#31), not to
  // the settings drawer — so the outcome flag is read here, where something is
  // always mounted, rather than in the panel that only exists while the drawer
  // is open. The server callback already exchanged the code and vaulted the
  // token; all that arrives is the outcome. Report it once, then strip it so a
  // reload doesn't repeat the toast, and on a FAILURE open the settings drawer
  // in the same URL write, because that is where the connect card that fixes it
  // lives.
  const [searchParams, setSearchParams] = useSearchParams();
  const oauthConnected = searchParams.get('beeperConnected');
  const oauthError = searchParams.get('beeperOauthError');
  useEffect(() => {
    if (!oauthConnected && !oauthError) return;
    if (oauthError) toast.error(oauthErrorSentence(oauthError));
    else {
      toast.success('Beeper connected');
      seedStatus();
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('beeperConnected');
      next.delete('beeperOauthError');
      if (oauthError) next.set('settings', '1');
      return next;
    }, { replace: true });
  }, [oauthConnected, oauthError, setSearchParams, seedStatus]);

  return (
    <div className="h-full min-h-0">
      <BeeperChatSurface
        conversationId={chatKey || null}
        realtime={realtime}
        invalidationSeq={invalidationSeq}
        invalidationFrames={invalidationFramesRef}
        breaker={breaker}
        sweep={sweep}
        tokenConfigured={tokenConfigured}
        onOpenSettings={() => setSettingsParam('1')}
      />

      <Drawer
        open={settingsParam === '1'}
        onClose={() => setSettingsParam(null)}
        title="Beeper Settings"
        size="md"
      >
        <BeeperSettingsPanel realtime={realtime} onRealtimeSeed={seedRealtime} onBreakerCleared={seedStatus} />
      </Drawer>
    </div>
  );
}
