import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';

export default function ToolsTab({ agentId, agent }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [rateLimits, setRateLimits] = useState(null);
  const [loading, setLoading] = useState(true);

  // Feed state
  const [feedPosts, setFeedPosts] = useState([]);
  const [feedSort, setFeedSort] = useState('hot');
  const [feedLoading, setFeedLoading] = useState(false);

  // Post composer state
  const [submolts, setSubmolts] = useState([]);
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

  // Drafts state
  const [drafts, setDrafts] = useState([]);
  const [activeDraftId, setActiveDraftId] = useState(null);

  const fetchInitial = useCallback(async () => {
    const accountsData = await api.getPlatformAccounts(agentId);
    setAccounts(accountsData.filter(a => a.status === 'active'));
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  // Load rate limits + submolts when account changes
  useEffect(() => {
    if (!selectedAccountId) {
      setRateLimits(null);
      return;
    }
    api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
    api.getAgentSubmolts(selectedAccountId).then(data => {
      const list = data.submolts || data || [];
      setSubmolts(Array.isArray(list) ? list : []);
    }).catch(() => {});
  }, [selectedAccountId]);

  const loadDrafts = useCallback(async () => {
    if (!agentId) return;
    const data = await api.getAgentDrafts(agentId);
    setDrafts(data);
  }, [agentId]);

  // Load drafts on mount
  useEffect(() => {
    loadDrafts();
  }, [loadDrafts]);

  const handleBrowseFeed = async () => {
    if (!selectedAccountId) return;
    setFeedLoading(true);
    const feed = await api.getAgentFeed(selectedAccountId, feedSort, 25);
    setFeedPosts(feed.posts || feed || []);
    setFeedLoading(false);
  };

  const handleFindRelevant = async () => {
    if (!agentId || !selectedAccountId) return;
    setFeedLoading(true);
    const posts = await api.getAgentRelevantPosts(agentId, selectedAccountId, 10);
    setFeedPosts(posts);
    setFeedLoading(false);
  };

  const handleViewPost = async (post) => {
    const details = await api.getAgentPost(selectedAccountId, post.id);
    setSelectedPost(details);
    setPostComments(details.comments || []);
    setCommentContent('');
    setReplyToId(null);
  };

  const handleUpvote = async (postId) => {
    await api.publishAgentComment(agentId, selectedAccountId, postId, '').catch(() => {});
    toast.success('Upvoted');
    if (selectedAccountId) {
      api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
    }
  };

  // Post generation (auto-saves as draft)
  const handleGeneratePost = async () => {
    if (!agentId || !selectedAccountId) return;
    setGenerating(true);
    const generated = await api.generateAgentPost(agentId, selectedAccountId, selectedSubmolt, agent?.aiConfig?.providerId, agent?.aiConfig?.model);
    setPostTitle(generated.title);
    setPostContent(generated.content);
    setGenerating(false);

    const draft = await api.createAgentDraft({
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
    const result = await api.publishAgentPost(agentId, selectedAccountId, selectedSubmolt, postTitle, postContent);

    if (activeDraftId) {
      if (result?.verificationFailed) {
        toast.error('Post verification failed — draft preserved for retry');
      } else {
        await api.updateAgentDraft(agentId, activeDraftId, {
          status: 'published',
          publishedPostId: result?.id || result?._id || result?.post_id || null,
          publishedAt: new Date().toISOString()
        }).catch(() => {});
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
    api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
  };

  // Comment generation (auto-saves as draft)
  const handleGenerateComment = async () => {
    if (!selectedPost) return;
    setGeneratingComment(true);
    const generated = await api.generateAgentComment(
      agentId, selectedAccountId, selectedPost.id, replyToId || undefined,
      agent?.aiConfig?.providerId, agent?.aiConfig?.model
    );
    setCommentContent(generated.content);
    setGeneratingComment(false);

    const draft = await api.createAgentDraft({
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
    const result = await api.publishAgentComment(
      agentId, selectedAccountId, selectedPost.id, commentContent, replyToId || undefined
    );

    if (activeDraftId) {
      if (result?.verificationFailed) {
        toast.error('Comment verification failed — draft preserved for retry');
      } else {
        await api.updateAgentDraft(agentId, activeDraftId, {
          status: 'published',
          publishedAt: new Date().toISOString()
        }).catch(() => {});
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
    api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
  };

  // Engage
  const handleEngage = async () => {
    if (!agentId || !selectedAccountId) return;
    setEngaging(true);
    setEngageResult(null);
    const result = await api.engageAgent(agentId, selectedAccountId, 1, 3);
    setEngageResult(result);
    setEngaging(false);
    toast.success(`Engaged: ${result.votes?.length || 0} votes, ${result.comments?.length || 0} comments`);
    api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
  };

  // Check Posts (Monitor)
  const handleCheckPosts = async () => {
    if (!agentId || !selectedAccountId) return;
    setChecking(true);
    setCheckResult(null);
    const result = await api.checkAgentPosts(agentId, selectedAccountId, 7, 2, 10).catch(() => null);
    setChecking(false);
    if (!result) return;
    setCheckResult(result);
    toast.success(`Checked ${result.postsChecked} posts: ${result.engagement?.upvoted?.length || 0} upvotes, ${result.engagement?.replied?.length || 0} replies`);
    api.getAgentRateLimits(selectedAccountId).then(setRateLimits).catch(() => {});
  };

  const handleLoadDraft = (draft) => {
    setActiveDraftId(draft.id);
    if (draft.type === 'post') {
      setPostTitle(draft.title || '');
      setPostContent(draft.content || '');
      if (draft.submolt) setSelectedSubmolt(draft.submolt);
      if (draft.accountId) setSelectedAccountId(draft.accountId);
      setSelectedPost(null);
      setCommentContent('');
    } else {
      setCommentContent(draft.content || '');
      setReplyToId(draft.parentId || null);
      if (draft.postId && draft.accountId) {
        setSelectedAccountId(draft.accountId);
        api.getAgentPost(draft.accountId, draft.postId).then(details => {
          setSelectedPost(details);
          setPostComments(details.comments || []);
        }).catch(() => {});
      }
    }
    toast.success(`Loaded ${draft.type} draft`);
  };

  const handleDeleteDraft = async (draftId) => {
    await api.deleteAgentDraft(agentId, draftId);
    if (activeDraftId === draftId) setActiveDraftId(null);
    loadDrafts();
    toast.success('Draft deleted');
  };

  if (loading) {
    return <div className="p-4 text-gray-400">Loading tools...</div>;
  }

  const ready = !!selectedAccountId;

  return (
    <div className="p-4">
      {/* Header: Account Selection + Rate Limits */}
      <div className="flex flex-wrap items-end gap-4 mb-6 p-4 bg-port-card border border-port-border rounded-lg">
        <div>
          <label className="block text-sm text-gray-400 mb-1">Account</label>
          <select
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className="px-3 py-2 bg-port-bg border border-port-border rounded text-white min-w-[200px]"
          >
            <option value="">Select account...</option>
            {accounts.map(account => (
              <option key={account.id} value={account.id}>
                {account.credentials.username}
              </option>
            ))}
          </select>
        </div>
        {rateLimits && (
          <div className="flex gap-3 ml-auto">
            {Object.entries(rateLimits).map(([action, rl]) => {
              const pct = rl.remaining / rl.maxPerDay;
              const colorClass = pct === 0
                ? 'bg-port-error/20 text-port-error'
                : pct < 0.25
                  ? 'bg-port-warning/20 text-port-warning'
                  : 'bg-port-success/20 text-port-success';
              return (
                <div key={action} className={`text-xs px-2 py-1 rounded ${colorClass}`} title={`${rl.remaining} of ${rl.maxPerDay} ${action}s remaining today`}>
                  {action}: {rl.remaining} left
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!ready && (
        <div className="text-center py-12 text-gray-400">
          <p className="text-lg mb-2">Select an account to get started</p>
          <p className="text-sm">Use the dropdown above to choose an active Moltbook account</p>
        </div>
      )}

      {ready && (<>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column: Feed + Engage */}
          <div className="space-y-4">
            {/* Feed Browser */}
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-white">Feed Browser</h3>
                <div className="flex gap-2">
                  <select
                    value={feedSort}
                    onChange={(e) => setFeedSort(e.target.value)}
                    className="px-2 py-1 text-sm bg-port-bg border border-port-border rounded text-white"
                  >
                    <option value="hot">Hot</option>
                    <option value="new">New</option>
                    <option value="top">Top</option>
                    <option value="rising">Rising</option>
                  </select>
                  <button
                    onClick={handleBrowseFeed}
                    disabled={feedLoading}
                    className="px-3 py-1 text-sm bg-port-accent/20 text-port-accent rounded hover:bg-port-accent/30 disabled:opacity-50"
                  >
                    {feedLoading ? 'Loading...' : 'Browse Feed'}
                  </button>
                  <button
                    onClick={handleFindRelevant}
                    disabled={feedLoading}
                    className="px-3 py-1 text-sm bg-purple-500/20 text-purple-400 rounded hover:bg-purple-500/30 disabled:opacity-50"
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
                          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
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
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-white">Autonomous Engage</h3>
                  <p className="text-xs text-gray-500">Find relevant posts, vote, and AI-generate comments</p>
                </div>
                <button
                  onClick={handleEngage}
                  disabled={engaging}
                  className="px-4 py-2 bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50"
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
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-white">Check Posts</h3>
                  <p className="text-xs text-gray-500">Check engagement on published posts, upvote comments, and reply</p>
                </div>
                <button
                  onClick={handleCheckPosts}
                  disabled={checking}
                  className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50"
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

              <div className="flex gap-2 mb-3">
                <select
                  value={selectedSubmolt}
                  onChange={(e) => setSelectedSubmolt(e.target.value)}
                  className="px-3 py-2 bg-port-bg border border-port-border rounded text-white flex-1"
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
                  className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50 whitespace-nowrap"
                >
                  {generating ? 'Generating...' : 'Generate Post'}
                </button>
              </div>

              <input
                type="text"
                value={postTitle}
                onChange={(e) => setPostTitle(e.target.value)}
                placeholder="Post title..."
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-2"
              />
              <textarea
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
                      disabled={publishing}
                      className="px-4 py-1 text-sm bg-port-success text-white rounded hover:bg-port-success/80 disabled:opacity-50"
                    >
                      {publishing ? 'Publishing...' : 'Publish'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Drafts */}
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
                          <div className="flex-1 min-w-0 cursor-pointer" onClick={() => !isPublished && handleLoadDraft(draft)}>
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
                              {isPublished ? `Published ${new Date(draft.publishedAt || draft.updatedAt).toLocaleString()}` : new Date(draft.createdAt).toLocaleString()}
                            </p>
                          </div>
                          <button
                            onClick={() => handleDeleteDraft(draft.id)}
                            className="text-gray-600 hover:text-port-error ml-2 shrink-0 text-sm"
                            title="Delete draft"
                          >
                            x
                          </button>
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
