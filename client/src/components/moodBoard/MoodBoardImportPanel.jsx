import { useState } from 'react';
import { AtSign, Download, Link2, RefreshCw, Unlink } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { formatCount, timeAgo } from '../../utils/formatters';
import {
  linkMoodBoardPinterest,
  unlinkMoodBoardPinterest,
  syncMoodBoardPinterest,
  importMoodBoardPinterest,
  importMoodBoardXPost,
} from '../../services/apiMoodBoard.js';

export default function MoodBoardImportPanel({ board, onBoardChange }) {
  const { id } = board;
  const mountedRef = useMounted();
  // Pinterest link/sync.
  const [pinUrl, setPinUrl] = useState(board.pinterest?.boardUrl || '');
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importingPinterest, setImportingPinterest] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  // X.com (Twitter) post import — one-shot, no persisted link.
  const [xPostUrl, setXPostUrl] = useState('');
  const [importingXPost, setImportingXPost] = useState(false);

  const handleLinkPinterest = async () => {
    if (!mountedRef.current) return;
    if (!pinUrl.trim()) { toast.error('Enter a Pinterest board URL'); return; }
    setLinking(true);
    const updated = await linkMoodBoardPinterest(id, pinUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setLinking(false);
    if (!updated) { toast.error('Could not link that Pinterest URL — is it a public board?'); return; }
    onBoardChange(updated);
    setPinUrl(updated.pinterest?.boardUrl || pinUrl.trim());
    toast.success('Pinterest board linked');
  };

  const handleUnlinkPinterest = async () => {
    if (!mountedRef.current) return;
    setConfirmingUnlink(false);
    const updated = await unlinkMoodBoardPinterest(id, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to unlink'); return; }
    onBoardChange(updated);
    setPinUrl('');
  };

  const handleSyncPinterest = async () => {
    if (!mountedRef.current) return;
    setSyncing(true);
    const result = await syncMoodBoardPinterest(id, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setSyncing(false);
    if (!result?.board) { toast.error('Pinterest sync failed — the feed may be private or rate-limited'); return; }
    onBoardChange(result.board);
    toast.success(result.added > 0
      ? `Added ${result.added} new pin${result.added === 1 ? '' : 's'}`
      : 'Up to date — no new pins');
  };

  const handleImportPinterest = async () => {
    if (!mountedRef.current || importingPinterest) return;
    if (!pinUrl.trim()) { toast.error('Enter a Pinterest Pin or board URL'); return; }
    setImportingPinterest(true);
    const result = await importMoodBoardPinterest(id, pinUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setImportingPinterest(false);
    if (!result?.board) {
      toast.error('Could not import that Pin or board — check the URL and sign in to Pinterest in the PortOS browser');
      return;
    }
    onBoardChange(result.board);
    toast.success(result.added > 0
      ? `Added ${formatCount(result.added)} of ${formatCount(result.found)} Pinterest pin${result.found === 1 ? '' : 's'}`
      : result.found > 0 ? 'No new Pinterest pins were added' : 'The Pinterest board has no pins');
  };

  const handleImportXPost = async () => {
    if (!mountedRef.current) return;
    if (!xPostUrl.trim()) { toast.error('Enter an x.com/twitter.com post URL'); return; }
    setImportingXPost(true);
    const result = await importMoodBoardXPost(id, xPostUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setImportingXPost(false);
    if (!result?.board) { toast.error('Could not import that post — check the URL or try again'); return; }
    onBoardChange(result.board);
    setXPostUrl('');
    toast.success(`Added ${result.added} item${result.added === 1 ? '' : 's'} from the post`);
  };

  const linkedFeedUrl = board.pinterest?.feedUrl || '';
  const linkedBoardUrl = board.pinterest?.boardUrl || '';
  const lastSyncedAt = board.pinterest?.lastSyncedAt || null;
  // "Sync now" reads the SAVED feed URL server-side, so disable it while the URL
  // input differs from what's persisted — otherwise a user edits the URL, doesn't
  // click Link, hits Sync, and the OLD board syncs.
  const pinDirty = pinUrl.trim() !== linkedBoardUrl;
  const isLinked = !!linkedFeedUrl;

  const renderPinUrlForm = (buttonText) => (
    <div>
      <label htmlFor="pinterest-url" className="block text-xs text-gray-400 mb-1">Pin or board URL</label>
      <div className="space-y-2">
        <input
          id="pinterest-url"
          type="url"
          autoCapitalize="none"
          autoCorrect="off"
          value={pinUrl}
          maxLength={2048}
          placeholder="https://www.pinterest.com/pin/1234567890/"
          onChange={(e) => setPinUrl(e.target.value)}
          className="block w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm focus:border-port-accent outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleImportPinterest}
            disabled={importingPinterest || linking || syncing || !pinUrl.trim()}
            className="min-h-[44px] flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            <Download className={`w-4 h-4 shrink-0 ${importingPinterest ? 'animate-pulse' : ''}`} aria-hidden="true" />
            {importingPinterest ? 'Importing…' : 'Import pins'}
          </button>
          <button
            type="button"
            onClick={handleLinkPinterest}
            disabled={linking || importingPinterest || !pinUrl.trim() || (isLinked && !pinDirty)}
            className="min-h-[44px] px-3 py-1.5 text-sm rounded bg-port-bg border border-port-border text-white hover:bg-port-border disabled:opacity-50 transition-colors"
          >
            {linking ? 'Linking…' : buttonText}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Pinterest link + sync */}
      <div className="bg-port-card border border-port-border rounded-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <Link2 className="w-4 h-4 text-port-accent" aria-hidden="true" />
          <h2 className="text-sm font-medium text-white">Import from Pinterest</h2>
        </div>
        {linkedFeedUrl ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <a
                href={linkedBoardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-port-accent hover:underline truncate max-w-full"
              >
                {linkedBoardUrl}
              </a>
              <span className="text-gray-500">
                {lastSyncedAt ? `Last synced ${timeAgo(lastSyncedAt)}` : 'Not synced yet'}
              </span>
            </div>
            <p className="text-[11px] text-gray-500">
              Pinterest’s feed exposes only the most-recent ~25 pins, so a sync pulls those — not the entire board.
            </p>
            <p className="text-[11px] text-gray-500">
              Use “Import pins” below to read the full board from your signed-in PortOS browser.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSyncPinterest}
                disabled={syncing || linking || importingPinterest || pinDirty}
                title={pinDirty ? 'Link the new URL before syncing' : undefined}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
              {confirmingUnlink ? (
                <InlineConfirmRow
                  question="Unlink this board?"
                  confirmText="Unlink"
                  onConfirm={handleUnlinkPinterest}
                  onCancel={() => setConfirmingUnlink(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingUnlink(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg text-gray-400 hover:text-white transition-colors"
                >
                  <Unlink className="w-4 h-4" aria-hidden="true" /> Unlink
                </button>
              )}
            </div>
            {renderPinUrlForm('Update board link')}
            <p className="text-[11px] text-gray-500">Import a single Pin or a full board. Importing a Pin keeps your linked board unchanged.</p>
          </div>
        ) : (
          <div>
            {renderPinUrlForm('Link board')}
            <p className="text-[11px] text-gray-500 mt-2">
              Paste a Pin, board or pin.it share link. “Import pins” saves the images from your signed-in PortOS browser. “Link board” connects a public board to sync its newest ~25 pins.
            </p>
          </div>
        )}
      </div>

      {/* X.com (Twitter) post import */}
      <div className="bg-port-card border border-port-border rounded-md p-4">
        <div className="flex items-center gap-2 mb-3">
          <AtSign className="w-4 h-4 text-port-accent" aria-hidden="true" />
          <h2 className="text-sm font-medium text-white">Import from an X post</h2>
        </div>
        <div>
          <label htmlFor="x-post-url" className="block text-xs text-gray-400 mb-1">Post URL</label>
          <div className="@container/post-import flex flex-wrap gap-2">
            <input
              id="x-post-url"
              type="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={xPostUrl}
              maxLength={2048}
              placeholder="https://x.com/user/status/1234567890"
              onChange={(e) => setXPostUrl(e.target.value)}
              className="w-full @sm/post-import:flex-1 min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm focus:border-port-accent outline-none"
            />
            <button
              type="button"
              onClick={handleImportXPost}
              disabled={importingXPost || !xPostUrl.trim()}
              className="min-h-[44px] px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
            >
              {importingXPost ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-gray-500 mt-2">
          Paste a public x.com/twitter.com post URL. Pulls every attached photo (or its video) into this board.
        </p>
      </div>
    </div>
  );
}
