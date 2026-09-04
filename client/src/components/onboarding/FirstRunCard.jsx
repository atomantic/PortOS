import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  ArrowRight, Brain, Clapperboard, ListChecks, Monitor, Sparkles, X,
} from 'lucide-react';
import toast from '../ui/Toast';
import useEscapeKey from '../../hooks/useEscapeKey.js';
import {
  publishInstanceFeatures,
  useInstanceFeatures,
} from '../../hooks/useInstanceFeatures.js';
import {
  FIRST_RUN_HIDE_SETTING,
  FIRST_RUN_MISSIONS,
  FIRST_RUN_QUERY_PARAM,
  FIRST_RUN_SESSION_KEY,
  featuresToEnable,
  parseFirstRunQueryParam,
  shouldShowFirstRunCard,
} from '../../lib/firstRunMissions.js';
import { safeReadSession, safeWriteSession } from '../../lib/safeStorage.js';
import * as api from '../../services/api';

const MISSION_ICONS = { Brain, Clapperboard, ListChecks, Monitor };

const dismissSession = () => safeWriteSession(FIRST_RUN_SESSION_KEY, '1');

export default function FirstRunCard() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { features } = useInstanceFeatures();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [hideSetting, setHideSetting] = useState(false);
  const [sessionDismissed, setSessionDismissed] = useState(
    () => safeReadSession(FIRST_RUN_SESSION_KEY) === '1',
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.getSettings({ silent: true })
      .then((settings) => {
        if (!active) return;
        setHideSetting(settings?.[FIRST_RUN_HIDE_SETTING] === true);
        setSettingsLoaded(true);
      })
      .catch(() => {
        if (!active) return;
        setHideSetting(false);
        setSettingsLoaded(true);
      });
    return () => { active = false; };
  }, []);

  const queryForce = parseFirstRunQueryParam(searchParams.get(FIRST_RUN_QUERY_PARAM));
  const visible = shouldShowFirstRunCard({
    pathname,
    queryForce,
    settingsLoaded,
    hideSetting,
    sessionDismissed,
  });

  const hideForSession = useCallback(() => {
    dismissSession();
    setSessionDismissed(true);
  }, []);

  useEscapeKey(visible && !busy, hideForSession);

  const pickMission = (mission) => {
    if (busy || !mission) return;
    setBusy(true);
    const ids = featuresToEnable(mission, features);
    ids.reduce(
      (chain, id) => chain.then(() => api.updateInstanceFeature(id, true, { silent: true })),
      Promise.resolve(null),
    )
      .then((result) => {
        if (result?.features) publishInstanceFeatures(result.features);
      })
      .catch((err) => {
        toast.error(err.message || 'Could not enable those features');
      })
      .finally(() => {
        hideForSession();
        navigate(mission.to);
      });
  };

  const hideForever = () => {
    if (busy) return;
    setBusy(true);
    api.updateSettings({ [FIRST_RUN_HIDE_SETTING]: true }, { silent: true })
      .then(() => {
        setHideSetting(true);
        hideForSession();
      })
      .catch((err) => {
        toast.error(err.message || 'Could not save that preference');
      })
      .finally(() => setBusy(false));
  };

  if (!visible) return null;

  return (
    <section
      aria-labelledby="first-run-heading"
      className="bg-port-card border border-port-accent/40 rounded-xl p-4 sm:p-5"
    >
      <div className="flex items-start gap-2 sm:gap-3">
        <Sparkles size={18} className="text-port-accent shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 id="first-run-heading" className="text-base font-semibold text-white">
            Where do you want to start?
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            Pick a mission to turn on that slice of PortOS and jump in. Exploring
            on your own, or pressing escape, just hides this for the session.
          </p>
        </div>
        <button
          type="button"
          onClick={hideForSession}
          disabled={busy}
          aria-label="Dismiss for this session"
          title="Dismiss for this session"
          className="inline-flex items-center justify-center p-1 rounded text-gray-500 hover:text-white hover:bg-port-border/60 disabled:opacity-50 min-h-[44px] min-w-[44px]"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {FIRST_RUN_MISSIONS.map((mission) => {
          const Icon = MISSION_ICONS[mission.icon] || Sparkles;
          return (
            <button
              key={mission.id}
              type="button"
              onClick={() => pickMission(mission)}
              disabled={busy}
              className="flex items-start gap-2 text-left p-3 rounded-lg border border-port-border hover:border-port-accent transition-colors disabled:opacity-50 min-h-[40px]"
            >
              <Icon size={16} className="text-port-accent shrink-0 mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-white">{mission.label}</span>
                <span className="block text-xs text-gray-500 mt-0.5">{mission.description}</span>
              </span>
              <ArrowRight size={14} className="text-port-accent shrink-0 mt-0.5" />
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={hideForSession}
          disabled={busy}
          className="text-gray-400 hover:text-white disabled:opacity-50"
        >
          Explore on my own
        </button>
        <button
          type="button"
          onClick={hideForever}
          disabled={busy}
          className="text-gray-400 hover:text-white disabled:opacity-50"
        >
          Don&apos;t show this again
        </button>
      </div>
    </section>
  );
}
