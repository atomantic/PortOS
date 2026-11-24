import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import toast from '../../ui/Toast';
import ConfirmButtonPair from '../../ui/ConfirmButtonPair';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';
import {
  getPlatformAccounts,
  getAgentRateLimits,
  getAgentSubmolts,
  getAgentDrafts,
  getAgentFeed,
  getAgentRelevantPosts,
  getAgentPost,
  generateAgentPost,
  createAgentDraft,
  publishAgentPost,
  updateAgentDraft,
  generateAgentComment,
  publishAgentComment,
  engageAgent,
  checkAgentPosts,
  deleteAgentDraft,
} from '../../../services/apiAccounts.js';
import BrailleSpinner from '../../BrailleSpinner';
import ListLoadError from '../../ui/ListLoadError';
import { useCooldownTick } from '../../../hooks/useCooldownTick';
import { formatCooldown, formatDateTime } from '../../../utils/formatters';
import { clickableProps, onActivateKeyDown } from '../../../lib/a11yKeyboard.js';

export default function ToolsTab({ agentId, agent }) {
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [accountName, setAccountName] = useState('');
  const [rateLimits, setRateLimits] = useState(null);
  const [loading, setLoading] = useState(true);

  // Feed state
  const [feedPosts, setFeedPosts] = useState([]);
  const [feedSort, setFeedSort] = useState('hot');
  const [feedLoading, setFeedLoading] = useState(false);

  // Post composer state
  const [submolts, setSubmolts] = useState([]);
  const [submoltsError, setSubmoltsError] = useState(null);
  const [submoltsAttempt, setSubmoltsAttempt] = useState(0);
  const [selectedSubmolt, setSelectedSubmolt] = useState('general');
  const [postTitle, setPostTitle] = useState('');
  const [postContent, setPostContent] = useState('');
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // Comment composer state
  const [selectedPost, setSelectedPost] = useState(null);
  const [postComments, setPostComments] = useState([]);
  const [commentContent, setCommentContent] = useState('');
  const [replyToId, setReplyToId] = useState(null);
  const [generatingComment, setGeneratingComment] = useState(false);
  const [publishingComment, setPublishingComment] = useState(false);

  // Engage state
  const [engaging, setEngaging] = useState(false);
  const [engageResult, setEngageResult] = useState(null);

  // Check Posts (Monitor) state
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  const [accountError, setAccountError] = useState(null);

  // Drafts state
  const [drafts, setDrafts] = useState([]);
  const [deletingDraftId, setDeletingDraftId] = useState(null);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();
  const [draftsError, setDraftsError] = useState(false);
  const [activeDraftId, setActiveDraftId] = useState(null);

  // Cooldown timer state
  const [cooldownEnds, setCooldownEnds] = useState({});

  // Auto-resolve the moltbook account for this agent. A failed read sets
  // accountError so it never falls through into the "no account" onboarding copy.
  const accountRequestRef = useRef(0);
  const viewPostRequestRef = useRef(null);
  const loadAccount = useCallback(async () => {
    const requestId = ++accountRequestRef.current;
    setLoading(true);
    setAccountError(null);
    setSelectedAccountId('');
    setAccountName('');
    const result = await getPlatformAccounts(agentId, 'moltbook', { silent: true })
      .then(data => ({ data }), error => ({ error }));
    if (requestId !== accountRequestRef.current) return;
    if (result.error) {
      console.warn('⚠️ Failed to resolve moltbook account: ' + result.error.message);
      setAccountError(result.error);
    } else {
      const active = result.data.filter(a => a.status === 'active');
      if (active.length > 0) {
        setSelectedAccountId(active[0].id);
        setAccountName(active[0].credentials?.username || '');
      }
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    loadAccount();
    return () => { accountRequestRef.current += 1; };
  }, [loadAccount]);

  // Load rate limits when account resolves
  useEffect(() => {
    if (!selectedAccountId) {
      setRateLimits(null);
      return undefined;
    }
    let live = true;
    getAgentRateLimits(selectedAccountId).then(data => { if (live) setRateLimits(data); }).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
    return () => { live = false; };
  }, [selectedAccountId]);

  // A failed submolt read stays visible with Retry rather than leaving only "general" in the picker.
  useEffect(() => {
    if (!selectedAccountId) return undefined;
    let live = true;
    // The error clears only on success, so a slow retry never reads as "only general".
    getAgentSubmolts(selectedAccountId, { silent: true }).then(data => {
      if (!live) return;
      setSubmoltsError(null);
      const list = data.submolts || data || [];
      setSubmolts(Array.isArray(list) ? list : []);
    }).catch(err => { if (live) setSubmoltsError(err); });
    return () => { live = false; };
  }, [selectedAccountId, submoltsAttempt]);

  // Calculate cooldown end timestamps from rate limit data
  useEffect(() => {
    if (!rateLimits) { setCooldownEnds({}); return; }
    const ends = {};
    const now = Date.now();
    for (const [action, rl] of Object.entries(rateLimits)) {
      if (rl.cooldownRemainingMs > 0) {
        ends[action] = now + rl.cooldownRemainingMs;
      }
    }
    setCooldownEnds(ends);
  }, [rateLimits]);

  useCooldownTick({
    cooldownEnds,
    onAllExpired: () => {
      if (selectedAccountId) {
        getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
      }
    },
  });

  const loadDrafts = useCallback(async () => {
    if (!agentId) return;
    setDraftsError(false);
    await getAgentDrafts(agentId, { silent: true })
      .then((data) => setDrafts(data))
      .catch(() => setDraftsError(true));
  }, [agentId]);

  // Load drafts on mount
  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const handleBrowseFeed = async () => {
    if (!selectedAccountId) return;
    setFeedLoading(true);
    try {
      const feed = await getAgentFeed({ accountId: selectedAccountId, sort: feedSort, limit: 25 });
      setFeedPosts(feed.posts || feed || []);
    } catch {
      // The request helper already shows the failure toast.
    } finally {
      setFeedLoading(false);
    }
  };

  const handleFindRelevant = async () => {
    if (!agentId || !selectedAccountId) return;
    setFeedLoading(true);
    try {
      const posts = await getAgentRelevantPosts({ agentId, accountId: selectedAccountId, maxResults: 10 });
      setFeedPosts(posts);
    } catch {
      // The request helper already shows the failure toast.
    } finally {
      setFeedLoading(false);
    }
  };

  // The platform read can take seconds; only the most recently requested post may land.
  const handleViewPost = async (post) => {
    const requestKey = `${selectedAccountId}:${post.id}`;
    viewPostRequestRef.current = requestKey;
    const details = await getAgentPost(selectedAccountId, post.id);
    if (viewPostRequestRef.current !== requestKey) return;
    setSelectedPost(details);
    setPostComments(details.comments || []);
    setCommentContent('');
    setReplyToId(null);
  };

  // Post generation (auto-saves as draft)
  const handleGeneratePost = async () => {
    if (!agentId || !selectedAccountId) return;
    setGenerating(true);
    const contentConfig = agent?.aiConfig?.content || agent?.aiConfig;
    // request() toasts a failure; release Generate rather than leave it spinning.
    const generated = await generateAgentPost({ agentId, accountId: selectedAccountId, submolt: selectedSubmolt, providerId: contentConfig?.providerId, model: contentConfig?.model }).catch(() => null);
    setGenerating(false);
    if (!generated) return;
    setPostTitle(generated.title);
    setPostContent(generated.content);

    const draft = await createAgentDraft({
      agentId,
      type: 'post',
      title: generated.title,
      content: generated.content,
      submolt: selectedSubmolt,
      accountId: selectedAccountId
    });
    setActiveDraftId(draft.id);
    loadDrafts();
    toast.success('Post generated and saved as draft');
  };

  const handlePublishPost = async () => {
    if (!postTitle || !postContent) return;
    setPublishing(true);
    const result = await publishAgentPost({ agentId, accountId: selectedAccountId, submolt: selectedSubmolt, title: postTitle, content: postContent }).catch(() => null);

    if (!result) {
      setPublishing(false);
      getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
      return;
    }

    if (activeDraftId) {
      if (result?.verificationFailed) {
        toast.error('Post verification failed — draft preserved for retry');
      } else {
        await updateAgentDraft({ agentId, draftId: activeDraftId, data: {
          status: 'published',
          publishedPostId: result?.id || result?._id || result?.post_id || null,
          publishedAt: new Date().toISOString()
        } }).catch(err => console.warn('⚠️ Failed to mark draft published: ' + err.message));
        setActiveDraftId(null);
        toast.success('Post published');
      }
      loadDrafts();
    } else {
      toast.success('Post published');
    }

    if (!result?.verificationFailed) {
      setPostTitle('');
      setPostContent('');
    }
    setPublishing(false);
    getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
  };

  // Comment generation (auto-saves as draft)
  const handleGenerateComment = async () => {
    if (!selectedPost) return;
    setGeneratingComment(true);
    const contentConfig = agent?.aiConfig?.content || agent?.aiConfig;
    const generated = await generateAgentComment({
      agentId, accountId: selectedAccountId, postId: selectedPost.id, parentId: replyToId || undefined,
      providerId: contentConfig?.providerId, model: contentConfig?.model
    }).catch(() => null);
    setGeneratingComment(false);
    if (!generated) return;
    setCommentContent(generated.content);

    const draft = await createAgentDraft({
      agentId,
      type: 'comment',
      content: generated.content,
      postId: selectedPost.id,
      parentId: replyToId || null,
      postTitle: selectedPost.title,
      accountId: selectedAccountId
    });
    setActiveDraftId(draft.id);
    loadDrafts();
    toast.success('Comment generated and saved as draft');
  };

  const handlePublishComment = async () => {
    if (!selectedPost || !commentContent) return;
    setPublishingComment(true);
    const result = await publishAgentComment({
      agentId, accountId: selectedAccountId, postId: selectedPost.id, content: commentContent, parentId: replyToId || undefined
    }).catch(() => null);

    if (!result) {
      setPublishingComment(false);
      getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
      return;
    }

    if (activeDraftId) {
      if (result?.verificationFailed) {
        toast.error('Comment verification failed — draft preserved for retry');
      } else {
        await updateAgentDraft({ agentId, draftId: activeDraftId, data: {
          status: 'published',
          publishedAt: new Date().toISOString()
        } }).catch(err => console.warn('⚠️ Failed to mark comment draft published: ' + err.message));
        setActiveDraftId(null);
        toast.success('Comment published');
      }
      loadDrafts();
    } else {
      toast.success('Comment published');
    }

    if (!result?.verificationFailed) {
      setCommentContent('');
      setReplyToId(null);
    }
    setPublishingComment(false);
    handleViewPost(selectedPost);
    getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
  };

  // Engage
  const handleEngage = async () => {
    if (!agentId || !selectedAccountId) return;
    setEngaging(true);
    setEngageResult(null);
    try {
      const result = await engageAgent({ agentId, accountId: selectedAccountId, maxComments: 1, maxVotes: 3 });
      setEngageResult(result);
      toast.success(`Engaged: ${result.votes?.length || 0} votes, ${result.comments?.length || 0} comments`);
      getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
    } catch {
      // The request helper already shows the failure toast.
    } finally {
      setEngaging(false);
    }
  };

  // Check Posts (Monitor)
  const handleCheckPosts = async () => {
    if (!agentId || !selectedAccountId) return;
    setChecking(true);
    setCheckResult(null);
    const result = await checkAgentPosts({ agentId, accountId: selectedAccountId, days: 7, maxReplies: 2, maxUpvotes: 10 }).catch(() => null);
    setChecking(false);
    if (!result) return;
    setCheckResult(result);
    toast.success(`Checked ${result.postsChecked} posts: ${result.engagement?.upvoted?.length || 0} upvotes, ${result.engagement?.replied?.length || 0} replies`);
    getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(err => console.warn('⚠️ Failed to refresh rate limits: ' + err.message));
  };

  const handleLoadDraft = (draft) => {
    setActiveDraftId(draft.id);
    if (draft.type === 'post') {
      setPostTitle(draft.title || '');
      setPostContent(draft.content || '');
      if (draft.submolt) setSelectedSubmolt(draft.submolt);
      setSelectedPost(null);
      setCommentContent('');
    } else {
      setCommentContent(draft.content || '');
      setReplyToId(draft.parentId || null);
      if (draft.postId) {
        const acctId = draft.accountId || selectedAccountId;
        getAgentPost(acctId, draft.postId).then(details => {
          setSelectedPost(details);
          setPostComments(details.comments || []);
        }).catch(err => console.warn('⚠️ Failed to load draft post details: ' + err.message));
      }
    }
    toast.success(`Loaded ${draft.type} draft`);
  };

  const handleDeleteDraft = (draftId) => {
    if (deletingDraftId) return;
    confirmDelete(async () => {
      setDeletingDraftId(draftId);
      try {
        await deleteAgentDraft(agentId, draftId);
        if (activeDraftId === draftId) setActiveDraftId(null);
        setDrafts((prev) => prev.filter((draft) => draft.id !== draftId));
        toast.success('Draft deleted');
      } catch {
        // request() already toasts; leave the draft in the list.
      } finally {
        setDeletingDraftId(null);
      }
    });
  };

  const getCooldownMs = (action) => {
    const end = cooldownEnds[action];
    return end ? Math.max(0, end - Date.now()) : 0;
  };

  if (loading) {
    return <div className="p-4"><BrailleSpinner text="Loading tools" /></div>;
  }

  if (accountError) {
    return <div className="p-4"><ListLoadError what="Moltbook account" error={accountError} onRetry={loadAccount} /></div>;
  }

  if (!selectedAccountId) {
    return (
      <div className="p-4 text-center py-12 text-gray-400">
        <p className="text-lg mb-2">No active Moltbook account</p>
        <p className="text-sm">Register a Moltbook account on the Overview tab to get started</p>
      </div>
    );
  }

  return (
    <div className="p-4">
      {/* Header: Account Name + Rate Limits */}
      <div className="flex flex-wrap items-center gap-4 mb-6 p-4 bg-port-card border border-port-border rounded-lg">
        <span className="text-sm text-gray-400">Account: <span className="text-white font-medium">{accountName}</span></span>
        {rateLimits && (
          <div className="flex flex-wrap gap-2 ml-auto min-w-0">
            {Object.entries(rateLimits).map(([action, rl]) => {
              const cooldownMs = getCooldownMs(action);
              const isCooling = cooldownMs > 0;
              const pct = rl.remaining / rl.maxPerDay;
              const colorClass = isCooling
                ? 'bg-port-warning/20 text-port-warning animate-pulse'
                : pct === 0
                  ? 'bg-port-error/20 text-port-error'
                  : pct < 0.25
                    ? 'bg-port-warning/20 text-port-warning'
                    : 'bg-port-success/20 text-port-success';
              return (
                <div key={action} className={`text-xs px-2 py-1 rounded ${colorClass}`} title={`${rl.remaining} of ${rl.maxPerDay} ${action}s remaining today${isCooling ? ` — cooldown: ${formatCooldown(cooldownMs)}` : ''}`}>
                  {isCooling ? `${action}: ${formatCooldown(cooldownMs)}` : `${action}: ${rl.remaining} left`}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(<>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column: Feed + Engage */}
          <div className="space-y-4">
            {/* Feed Browser */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h3 className="font-semibold text-white min-w-0">Feed Browser</h3>
                <div className="flex flex-wrap gap-2 min-w-0">
                  <select
                    aria-label="Sort feed"
                    value={feedSort}
                    onChange={(e) => setFeedSort(e.target.value)}
                    className="min-w-0 px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white"
                  >
                    <option value="hot">Hot</option>
                    <option value="new">New</option>
                    <option value="top">Top</option>
                    <option value="rising">Rising</option>
                  </select>
                  <button
                    onClick={handleBrowseFeed}
                    disabled={feedLoading}
                    className="pointer-coarse:min-h-11 px-3 py-1 text-sm bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
                  >
                    {feedLoading ? <BrailleSpinner text="Loading" /> : 'Browse Feed'}
                  </button>
                  <button
                    onClick={handleFindRelevant}
                    disabled={feedLoading}
                    className="pointer-coarse:min-h-11 px-3 py-1 text-sm bg-port-accent-2/20 text-port-accent-2 rounded hover:bg-port-accent-2/30 disabled:opacity-50"
                  >
                    Find Relevant
                  </button>
                </div>
              </div>

              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {feedPosts.length === 0 && !feedLoading && (
                  <p className="text-sm text-gray-500 text-center py-4">
                    Click "Browse Feed" or "Find Relevant" to load posts
                  </p>
                )}
                {feedPosts.map(post => (
                  <div
                    key={post.id}
                    className={`p-3 border rounded cursor-pointer transition-colors ${
                      selectedPost?.id === post.id
                        ? 'border-port-accent bg-port-accent/10'
                        : 'border-port-border hover:border-port-border/80 hover:bg-port-bg/50'
                    }`}
                    onClick={() => handleViewPost(post)}
                    {...clickableProps(() => handleViewPost(post))}
                    onKeyDown={onActivateKeyDown(() => handleViewPost(post))}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-white truncate">{post.title}</h4>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {post.submolt && <span className="text-port-accent">/{typeof post.submolt === 'object' ? post.submolt.name : post.submolt}</span>}
                          {post.author && <span> by {typeof post.author === 'object' ? post.author.name : post.author}</span>}
                          {post.commentCount !== undefined && <span> - {post.commentCount} comments</span>}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 ml-2 shrink-0">
                        {post.relevanceScore > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-port-accent-2/20 text-port-accent-2">
                            {post.relevanceScore}
                          </span>
                        )}
                        {post.score !== undefined && (
                          <span className="text-xs text-gray-500">{post.score}pts</span>
                        )}
                      </div>
                    </div>
                    {post.matchedTopics?.length > 0 && (
                      <div className="flex gap-1 mt-1">
                        {post.matchedTopics.map(topic => (
                          <span key={topic} className="text-[10px] px-1.5 py-0.5 rounded bg-port-accent/10 text-port-accent">
                            {topic}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Engage Now */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-white">Autonomous Engage</h3>
                  <p className="text-xs text-gray-500">Find relevant posts, vote, and AI-generate comments</p>
                </div>
                <button
                  onClick={handleEngage}
                  disabled={engaging}
                  className="shrink-0 pointer-coarse:min-h-11 px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50"
                >
                  {engaging ? 'Engaging...' : 'Engage Now'}
                </button>
              </div>

              {engageResult && (
                <div className="text-sm space-y-2">
                  <p className="text-gray-400">
                    Reviewed {engageResult.postsReviewed} posts
                  </p>
                  {engageResult.votes?.length > 0 && (
                    <div>
                      <p className="text-port-accent font-medium">Votes ({engageResult.votes.length})</p>
                      {engageResult.votes.map((v, i) => (
                        <p key={i} className="text-gray-500 text-xs pl-2">
                          Upvoted: {v.title}
                        </p>
                      ))}
                    </div>
                  )}
                  {engageResult.comments?.length > 0 && (
                    <div>
                      <p className="text-port-success font-medium">Comments ({engageResult.comments.length})</p>
                      {engageResult.comments.map((c, i) => (
                        <div key={i} className="text-xs pl-2 mt-1">
                          <p className="text-gray-400">On: {c.postTitle}</p>
                          <p className="text-gray-500 italic">{c.content?.substring(0, 100)}...</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Check Posts (Monitor) */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="min-w-0">
                  <h3 className="font-semibold text-white">Check Posts</h3>
                  <p className="text-xs text-gray-500">Check engagement on published posts, upvote comments, and reply</p>
                </div>
                <button
                  onClick={handleCheckPosts}
                  disabled={checking}
                  className="shrink-0 pointer-coarse:min-h-11 px-4 py-2 bg-port-accent-2 text-white rounded hover:bg-port-accent-2/80 disabled:opacity-50"
                >
                  {checking ? 'Checking...' : 'Check Posts'}
                </button>
              </div>

              {checking && (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <span className="animate-spin">⏳</span>
                  Scanning published posts for new engagement...
                </div>
              )}

              {checkResult && (
                <div className="text-sm space-y-2">
                  <div className="flex gap-4 text-gray-400">
                    <span>{checkResult.postsChecked} posts checked</span>
                    <span>{checkResult.engagement?.totalComments || 0} total comments</span>
                    <span className="text-port-accent">{checkResult.engagement?.newComments || 0} by others</span>
                  </div>

                  {checkResult.engagement?.upvoted?.length > 0 && (
                    <div>
                      <p className="text-port-accent font-medium">Upvoted ({checkResult.engagement.upvoted.length})</p>
                      {checkResult.engagement.upvoted.map((u, i) => (
                        <div key={i} className="text-xs pl-2 mt-1">
                          <p className="text-gray-400">{u.postTitle}</p>
                          <p className="text-gray-500 italic">{u.snippet}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {checkResult.engagement?.replied?.length > 0 && (
                    <div>
                      <p className="text-port-success font-medium">Replied ({checkResult.engagement.replied.length})</p>
                      {checkResult.engagement.replied.map((r, i) => (
                        <div key={i} className="text-xs pl-2 mt-1">
                          <p className="text-gray-400">{r.postTitle} - re: {r.snippet}</p>
                          <p className="text-gray-500 italic">{r.reply?.substring(0, 120)}...</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {(checkResult.engagement?.upvoted?.length === 0 && checkResult.engagement?.replied?.length === 0) && (
                    <p className="text-gray-500 text-xs">No new engagement actions taken</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Post Composer + Comment Composer */}
          <div className="space-y-4">
            {/* Post Composer */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <h3 className="font-semibold text-white mb-3">Post Composer</h3>

              <div className="flex flex-wrap gap-2 mb-3">
                <select
                  aria-label="Submolt"
                  value={selectedSubmolt}
                  onChange={(e) => setSelectedSubmolt(e.target.value)}
                  className="min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded text-white flex-1 basis-40"
                >
                  <option value="general">general</option>
                  {submolts.map(s => {
                    const name = s.name || s;
                    return name !== 'general' ? (
                      <option key={name} value={name}>{name}</option>
                    ) : null;
                  })}
                </select>
                <button
                  onClick={handleGeneratePost}
                  disabled={generating}
                  className="shrink-0 pointer-coarse:min-h-11 px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
                >
                  {generating ? 'Generating...' : 'Generate Post'}
                </button>
              </div>
              {submoltsError && (
                <ListLoadError what="submolts" error={submoltsError} onRetry={() => setSubmoltsAttempt(n => n + 1)} className="mb-3" />
              )}

              <input
                type="text"
                value={postTitle}
                onChange={(e) => setPostTitle(e.target.value)}
                placeholder="Post title..."
            aria-label="Post title"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-2"
              />
              <textarea
                aria-label="Post content"
                value={postContent}
                onChange={(e) => setPostContent(e.target.value)}
                placeholder="Post content (markdown)..."
                rows={6}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white resize-y mb-2"
              />

              <div className="flex gap-2">
                {postTitle && postContent && (
                  <>
                    <button
                      onClick={handleGeneratePost}
                      disabled={generating}
                      className="px-3 py-1 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
                    >
                      Regenerate
                    </button>
                    <button
                      onClick={handlePublishPost}
                      disabled={publishing || getCooldownMs('post') > 0}
                      className="px-4 py-1 text-sm bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50"
                      title={getCooldownMs('post') > 0 ? `Post cooldown: ${formatCooldown(getCooldownMs('post'))}` : ''}
                    >
                      {publishing ? 'Publishing...' : getCooldownMs('post') > 0 ? `Wait ${formatCooldown(getCooldownMs('post'))}` : 'Publish'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Drafts */}
            {draftsError && (
              <ListLoadError what="drafts" onRetry={loadDrafts} className="mb-4" />
            )}
            {drafts.length > 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h3 className="font-semibold text-white mb-3">
                  Drafts ({drafts.filter(d => d.status !== 'published').length})
                  {drafts.some(d => d.status === 'published') && (
                    <span className="text-xs text-gray-500 font-normal ml-2">
                      +{drafts.filter(d => d.status === 'published').length} published
                    </span>
                  )}
                </h3>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {drafts.map(draft => {
                    const isPublished = draft.status === 'published';
                    return (
                      <div
                        key={draft.id}
                        className={`p-3 border rounded transition-colors ${
                          isPublished
                            ? 'border-port-success/30 bg-port-success/5 opacity-60'
                            : activeDraftId === draft.id
                              ? 'border-port-accent bg-port-accent/10'
                              : 'border-port-border hover:border-port-border/80'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => !isPublished && handleLoadDraft(draft)}
                            {...clickableProps(() => handleLoadDraft(draft), { disabled: isPublished })}
                            onKeyDown={isPublished ? undefined : onActivateKeyDown(() => handleLoadDraft(draft))}
                          >
                            <div className="flex items-center gap-2">
                              <span className={`text-xs px-1.5 py-0.5 rounded ${isPublished ? 'bg-port-success/20 text-port-success' : 'bg-port-accent/20 text-port-accent'}`}>
                                {isPublished ? 'published' : draft.type}
                              </span>
                              {draft.submolt && (
                                <span className="text-xs text-gray-500">/{draft.submolt}</span>
                              )}
                            </div>
                            <p className="text-sm text-white mt-1 truncate">
                              {draft.title || draft.content?.substring(0, 80)}
                            </p>
                            {draft.postTitle && (
                              <p className="text-xs text-gray-500 mt-0.5">
                                re: {draft.postTitle}
                              </p>
                            )}
                            <p className="text-[10px] text-gray-600 mt-1">
                              {isPublished ? `Published ${formatDateTime(draft.publishedAt || draft.updatedAt)}` : formatDateTime(draft.createdAt)}
                            </p>
                          </div>
                          {isConfirming(draft.id) || deletingDraftId === draft.id ? (
                            <ConfirmButtonPair
                              prompt="Delete?"
                              busy={deletingDraftId === draft.id}
                              busyText="Deleting"
                              onConfirm={() => handleDeleteDraft(draft.id)}
                              onCancel={cancelDelete}
                              ariaLabel="Confirm draft deletion"
                              confirmAriaLabel="Confirm delete draft"
                              cancelAriaLabel="Cancel draft deletion"
                              className="ml-2 shrink-0"
                            />
                          ) : (
                            <button
                              type="button"
                              aria-label={`Delete draft ${draft.title || draft.content?.substring(0, 40) || ''}`.trim()}
                              onClick={() => requestDelete(draft.id)}
                              disabled={deletingDraftId != null}
                              className="inline-flex items-center justify-center text-gray-600 hover:text-port-error ml-2 shrink-0 pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:opacity-50"
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Comment Composer */}
            {selectedPost && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h3 className="font-semibold text-white mb-2">
                  Reply to: {selectedPost.title}
                </h3>
                <p className="text-xs text-gray-500 mb-3">
                  {selectedPost.author && `by ${typeof selectedPost.author === 'object' ? selectedPost.author.name : selectedPost.author} - `}
                  {postComments.length} comments
                </p>

                <div className="text-sm text-gray-400 bg-port-bg p-3 rounded mb-3 max-h-32 overflow-y-auto">
                  {selectedPost.content?.substring(0, 500)}
                  {selectedPost.content?.length > 500 && '...'}
                </div>

                {postComments.length > 0 && (
                  <div className="space-y-2 mb-3 max-h-48 overflow-y-auto">
                    {postComments.slice(0, 10).map(comment => (
                      <div
                        key={comment.id}
                        className={`text-xs p-2 rounded cursor-pointer transition-colors ${
                          replyToId === comment.id
                            ? 'bg-port-accent/20 border border-port-accent'
                            : 'bg-port-bg hover:bg-port-bg/80'
                        }`}
                        onClick={() => setReplyToId(replyToId === comment.id ? null : comment.id)}
                        {...clickableProps(() => setReplyToId(replyToId === comment.id ? null : comment.id))}
                        onKeyDown={onActivateKeyDown(() => setReplyToId(replyToId === comment.id ? null : comment.id))}
                      >
                        <span className="text-port-accent">{(typeof comment.author === 'object' ? comment.author?.name : comment.author) || 'anon'}</span>
                        <span className="text-gray-500">: {comment.content?.substring(0, 150)}</span>
                        {replyToId === comment.id && (
                          <span className="text-port-accent ml-1">(replying)</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {replyToId && (
                  <p className="text-xs text-port-accent mb-2">
                    Replying to comment - <button onClick={() => setReplyToId(null)} className="underline">cancel</button>
                  </p>
                )}

                <textarea
                  aria-label="Comment content"
                  value={commentContent}
                  onChange={(e) => setCommentContent(e.target.value)}
                  placeholder="Comment content (markdown)..."
                  rows={4}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white resize-y mb-2"
                />

                <div className="flex gap-2">
                  <button
                    onClick={handleGenerateComment}
                    disabled={generatingComment}
                    className="px-3 py-1 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
                  >
                    {generatingComment ? 'Generating...' : 'Generate Comment'}
                  </button>
                  {commentContent && (
                    <>
                      <button
                        onClick={handleGenerateComment}
                        disabled={generatingComment}
                        className="px-3 py-1 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
                      >
                        Regenerate
                      </button>
                      <button
                        onClick={handlePublishComment}
                        disabled={publishingComment}
                        className="px-3 py-1 text-sm bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50"
                      >
                        {publishingComment ? 'Publishing...' : 'Publish Comment'}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </>)}
    </div>
  );
}
