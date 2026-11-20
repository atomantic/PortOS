import { useState, useEffect, useCallback } from 'react';
import { getGitInfo, getBranches, getRemoteBranches, getBranchComparison } from '../../../../services/apiGit.js';

// The Git tab's repository reads: status/info, local + remote branch lists and
// the dev→base comparison. Lives above the panels because `loading` swaps the
// whole panel area for a spinner, and every panel mutates these lists.
export default function useGitRepoData(repoPath) {
  const [gitInfo, setGitInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [branchComparison, setBranchComparison] = useState(null);
  const [branches, setBranches] = useState([]);
  // A failed branch read is kept apart from a repo that has no branches; a
  // refresh failure keeps the last good list on screen beside the error row.
  const [branchesError, setBranchesError] = useState(null);
  const [remoteBranchesError, setRemoteBranchesError] = useState(null);
  const [remoteBranches, setRemoteBranches] = useState([]);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [sourceRefreshKey, setSourceRefreshKey] = useState(0);

  const bumpSourceRefresh = useCallback(() => setSourceRefreshKey((key) => key + 1), []);

  const applyRemoteResult = useCallback((result) => {
    if (result?.error) {
      setRemoteBranchesError(result.error);
    } else if (result) {
      setRemoteBranchesError(null);
      setRemoteBranches(result.branches || []);
    }
  }, []);

  const loadGitData = useCallback(async (opts = {}) => {
    if (!repoPath) return;
    const { includeRemote = true } = opts;
    setLoading(true);
    if (includeRemote) setLoadingRemote(true);

    const promises = [
      getGitInfo(repoPath).catch(() => null),
      getBranches(repoPath, { silent: true }).catch((error) => ({ error }))
    ];
    if (includeRemote) {
      promises.push(getRemoteBranches(repoPath, { silent: true }).catch((error) => ({ error })));
    }

    const [info, branchesResult, remoteResult] = await Promise.all(promises);

    let comparison = null;
    if (info?.baseBranch && info?.devBranch) {
      comparison = await getBranchComparison(repoPath, info.baseBranch, info.devBranch).catch(() => null);
    }

    setGitInfo(info);
    if (branchesResult?.error) {
      setBranchesError(branchesResult.error);
    } else {
      setBranchesError(null);
      setBranches(branchesResult?.branches || []);
    }
    setBranchComparison(comparison);
    setLoading(false);

    if (includeRemote) {
      applyRemoteResult(remoteResult);
      setLoadingRemote(false);
    }
  }, [repoPath, applyRemoteResult]);

  // Local git mutations (push/sync/commit) change ahead/behind counts, so the
  // Repository sources card must re-fetch too.
  const loadGitInfo = useCallback(async () => {
    await loadGitData({ includeRemote: false });
    bumpSourceRefresh();
  }, [loadGitData, bumpSourceRefresh]);

  const loadRemoteBranches = useCallback(async (opts = {}) => {
    if (!repoPath) return;
    setLoadingRemote(true);
    const result = await getRemoteBranches(repoPath, { silent: true, ...opts }).catch((error) => ({ error }));
    applyRemoteResult(result);
    setLoadingRemote(false);
  }, [repoPath, applyRemoteResult]);

  useEffect(() => {
    loadGitData({ includeRemote: true });
  }, [loadGitData]);

  return {
    gitInfo,
    loading,
    branchComparison,
    branches,
    setBranches,
    branchesError,
    remoteBranches,
    setRemoteBranches,
    remoteBranchesError,
    loadingRemote,
    sourceRefreshKey,
    bumpSourceRefresh,
    loadGitData,
    loadGitInfo,
    loadRemoteBranches,
  };
}
