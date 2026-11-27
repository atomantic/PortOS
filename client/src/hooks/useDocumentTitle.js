// Keeps the browser title in sync with the active navigation page and instance.
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { getSelfInstance } from '../services/apiAppShell.js';
import { readShellBootstrap } from '../services/shellBootstrap.js';
import { getNavPageForPath } from '../../../server/lib/navManifest.js';

const INSTANCE_NAME_EVENT = 'portos:instance-name-updated';

export function setDocumentTitleInstanceName(name) {
  window.dispatchEvent(new CustomEvent(INSTANCE_NAME_EVENT, { detail: { name } }));
}

export default function useDocumentTitle(enabled = true) {
  const { pathname } = useLocation();
  const [instanceName, setInstanceName] = useState('');

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let nameUpdated = false;
    const onInstanceNameUpdated = (event) => {
      const name = event.detail?.name?.trim();
      if (name) {
        nameUpdated = true;
        setInstanceName(name);
      }
    };
    window.addEventListener(INSTANCE_NAME_EVENT, onInstanceNameUpdated);
    readShellBootstrap('selfInstance', () => getSelfInstance({ silent: true })).then((self) => {
      const name = self?.name?.trim();
      if (active && !nameUpdated && name) setInstanceName(name);
    }).catch(() => null);
    return () => {
      active = false;
      window.removeEventListener(INSTANCE_NAME_EVENT, onInstanceNameUpdated);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !instanceName) return;
    const page = getNavPageForPath(pathname)?.breadcrumb;
    document.title = `${page ? `${page} · ` : ''}PortOS: ${instanceName}`;
  }, [enabled, instanceName, pathname]);
}
