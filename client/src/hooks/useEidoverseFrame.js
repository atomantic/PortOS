import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  EIDOVERSE_FRAME_VERSION,
  EIDOVERSE_LABEL_PREFERENCES,
  eidoverseNavigationTarget,
  isEidoverseFrameMessage,
} from '../lib/eidoverseFrame';
export default function useEidoverseFrame(hostUrl, objects = [], onTravel = null) {
  const frameRef = useRef(null);
  const travelRef = useRef(onTravel);
  travelRef.current = onTravel;
  const objectsRef = useRef(objects);
  objectsRef.current = objects;
  const sessionRef = useRef(null);
  const [loaded, setLoaded] = useState({ id: 0, url: null });
  const [connection, setConnection] = useState({ status: 'checking', capabilities: {} });
  const [labelVisibility, setLabelVisibility] = useState('off');
  const preferenceRef = useRef(labelVisibility);
  const navigate = useNavigate();

  const onFrameLoad = useCallback(() => {
    sessionRef.current = null;
    setConnection({ status: 'checking', capabilities: {} });
    setLoaded((current) => ({ id: current.id + 1, url: hostUrl }));
  }, [hostUrl]);

  useEffect(() => {
    if (!hostUrl || loaded.url !== hostUrl || !frameRef.current?.contentWindow) return undefined;
    const source = frameRef.current.contentWindow;
    const origin = new URL(hostUrl).origin;
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const session = { source, origin, nonce, capabilities: {} };
    sessionRef.current = session;
    const timer = setTimeout(() => {
      setConnection({ status: 'unsupported', capabilities: {} });
    }, 5000);
    const receive = (event) => {
      if (sessionRef.current !== session || frameRef.current?.contentWindow !== source
        || !isEidoverseFrameMessage(event, session)) return;
      const data = event.data;
      if (data.type === 'eidoverse:ready') {
        clearTimeout(timer);
        session.capabilities = Object.fromEntries(['objectLabels', 'portosNavigation', 'labelPreferences']
          .map((key) => [key, data.capabilities?.[key] === 1]));
        setConnection({ status: 'ready', capabilities: session.capabilities });
        if (session.capabilities.labelPreferences) source.postMessage({
          type: 'portos:label-preference', version: EIDOVERSE_FRAME_VERSION, nonce,
          labelVisibility: preferenceRef.current,
        }, origin);
      } else if (data.type === 'eidoverse:navigate' && session.capabilities.portosNavigation) {
        const target = eidoverseNavigationTarget(data, objectsRef.current);
        if (!target) return;
        const object = objectsRef.current.find((entry) => entry.id === data.entityId);
        if (object?.travelPeerId && travelRef.current) travelRef.current(object.travelPeerId);
        else navigate(target);
      }
    };
    window.addEventListener('message', receive);
    source.postMessage({
      type: 'portos:connect', version: EIDOVERSE_FRAME_VERSION, nonce,
      capabilities: { portosNavigation: 1, labelPreferences: 1 },
      labelVisibility: preferenceRef.current,
    }, origin);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [hostUrl, loaded, navigate]);

  const changeLabelVisibility = useCallback((value) => {
    if (!EIDOVERSE_LABEL_PREFERENCES.includes(value)) return;
    preferenceRef.current = value;
    setLabelVisibility(value);
    const session = sessionRef.current;
    if (session?.capabilities.labelPreferences) {
      session.source.postMessage({
        type: 'portos:label-preference', version: EIDOVERSE_FRAME_VERSION,
        nonce: session.nonce, labelVisibility: value,
      }, session.origin);
    }
  }, []);

  return { frameRef, onFrameLoad, connection, labelVisibility, changeLabelVisibility };
}
