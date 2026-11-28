import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelCodexLogin, codexLogout, getCodexAccount, getCodexModels, startCodexLogin, updateProvider } from '../../services/apiProviders.js';
import { isCodexSubscriptionProvider, mergeModelLists } from '../../utils/providers';
import { isHttpsUrl } from '../../utils/urlNormalize';
import { copyToClipboard } from '../../lib/clipboard';
import { useSocketResource } from '../../hooks/useSocketResource';
import useMounted from '../../hooks/useMounted.js';
import toast from '../ui/Toast';

const ACCOUNT_EVENTS = ['codex-account:changed'];

export default function useCodexAccount({ providers, setProviders, providerListRevision, enabled }) {
  const accountRevision = useRef(0);
  const observationMounted = useMounted();
  // `undefined` = this page has not asked the account endpoint yet; `null` =
  // the endpoint did not give a verdict. The distinction keeps a failed fetch
  // from posing as either signed out or ready.
  const [codexAccount, setCodexAccount] = useState(undefined);
  const [codexModels, setCodexModels] = useState(null);
  const [codexAccountLoading, setCodexAccountLoading] = useState(false);
  const [codexLoginLoading, setCodexLoginLoading] = useState(false);
  const hasCodexSubscriptionProvider = providers.some(isCodexSubscriptionProvider);

  const mergeCodexCatalog = useCallback((catalog) => {
    if (!Array.isArray(catalog)) return;
    const ids = catalog.map((model) => (typeof model === 'string' ? model : model?.id))
      .filter((id) => typeof id === 'string' && id.trim() !== '');
    setProviders((current) => current.map((provider) => (
      isCodexSubscriptionProvider(provider)
        ? { ...provider, models: mergeModelLists(provider.models, ids) }
        : provider
    )));
  }, [setProviders]);

  const loadCodexModels = useCallback(async (fresh = false) => {
    const result = await getCodexModels({ fresh, silent: true }).catch(() => null);
    if (!result || !Object.hasOwn(result, 'models')) return null;
    setCodexModels(result);
    // `null` is never fetched; an empty list is a real catalog. Only merge a
    // real array, preserving every current default/tier pin even if it is no
    // longer in the catalog so the form can show it as stale rather than clear
    // a saved choice behind the user's back.
    mergeCodexCatalog(result.models);
    return result;
  }, [mergeCodexCatalog]);

  const loadCodexAccount = useCallback(async (fresh = false) => {
    // Compatibility with a server that predates the account endpoint. The
    // normal client library always has this function; the guard makes a mixed
    // client/server upgrade leave the established provider controls intact.
    if (typeof getCodexAccount !== 'function') return undefined;
    const revision = ++accountRevision.current;
    setCodexAccountLoading(true);
    const result = await getCodexAccount({ fresh, silent: true }).catch(() => undefined);
    if (!observationMounted.current || revision !== accountRevision.current) return;
    setCodexAccountLoading(false);
    // A refused live check already toasts through request(); keep any verdict
    // the page previously loaded.
    if (!result) {
      setCodexAccount((current) => current ?? null);
      return;
    }
    const readiness = result.readiness && typeof result.readiness === 'object' ? result.readiness : null;
    setCodexAccount(readiness);
    if (readiness?.status === 'ready') loadCodexModels(fresh);
    return readiness;
  }, [loadCodexModels, observationMounted]);

  useEffect(() => {
    if (!hasCodexSubscriptionProvider) {
      setCodexAccount(undefined);
      setCodexModels(null);
    }
  }, [hasCodexSubscriptionProvider, loadCodexAccount]);

  useSocketResource(() => loadCodexAccount(), {
    namespace: 'codex-account', events: ACCOUNT_EVENTS,
    enabled: enabled && hasCodexSubscriptionProvider,
  });

  const handleEnableCodexSubscription = async (provider) => {
    const updated = await updateProvider(provider.id, { textTransportEnabled: true }, { silent: true }).catch(() => null);
    if (!updated) {
      toast.error('Could not save the ChatGPT subscription transport');
      return;
    }
    providerListRevision.current.mutation += 1;
    setProviders((current) => current.map((entry) => (
      entry.id === provider.id ? { ...entry, textTransportEnabled: true } : entry
    )));
    toast.success('ChatGPT subscription transport enabled');
  };

  const handleCodexSignIn = async (deviceCode) => {
    setCodexLoginLoading(true);
    const result = await startCodexLogin(deviceCode, { silent: true }).catch(() => null);
    setCodexLoginLoading(false);
    if (!result?.login) {
      toast.error('Could not start ChatGPT sign-in');
      return;
    }
    const login = {
      ...result.login,
      authUrl: isHttpsUrl(result.login.authUrl) ? result.login.authUrl : null,
      verificationUrl: isHttpsUrl(result.login.verificationUrl) ? result.login.verificationUrl : null,
    };
    accountRevision.current += 1;
    setCodexAccount((current) => ({
      ...(current && typeof current === 'object' ? current : {}),
      status: 'login-pending',
      login,
    }));
    if (login.authUrl) window.open(login.authUrl, '_blank', 'noopener,noreferrer');
  };

  const handleCancelCodexLogin = async (loginId) => {
    setCodexLoginLoading(true);
    const result = await cancelCodexLogin(loginId, { silent: true }).catch(() => null);
    setCodexLoginLoading(false);
    if (!result?.readiness) {
      toast.error('Could not cancel ChatGPT sign-in');
      return;
    }
    accountRevision.current += 1;
    setCodexAccount(result.readiness);
  };

  const handleCodexLogout = async () => {
    setCodexAccountLoading(true);
    const result = await codexLogout({ silent: true }).catch(() => null);
    setCodexAccountLoading(false);
    if (!result?.readiness) {
      toast.error('Could not log out of ChatGPT');
      return;
    }
    accountRevision.current += 1;
    setCodexAccount(result.readiness);
    toast.success('ChatGPT subscription signed out');
  };

  const handleCopyCodexDeviceCode = (code) => copyToClipboard(code, 'Device code copied');

  return {
    account: codexAccount, models: codexModels, loading: codexAccountLoading, loginLoading: codexLoginLoading,
    onCheck: () => loadCodexAccount(true), onRefreshModels: () => loadCodexModels(true),
    onSignIn: handleCodexSignIn, onCancel: handleCancelCodexLogin, onLogout: handleCodexLogout,
    onCopyCode: handleCopyCodexDeviceCode, onEnable: handleEnableCodexSubscription,
  };
}
