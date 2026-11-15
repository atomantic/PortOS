import { useState, useCallback } from 'react';
import { Link } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import MediaCard from '../media/MediaCard';
import FavoritesFilterChip from '../media/FavoritesFilterChip';
import BatchVerificationBar from '../media/BatchVerificationBar';
import { verifyImageNow } from '../../services/apiImageVerifier';
import toast from '../ui/Toast';

export default function ImageGenGallerySections({ gallery, cards }) {
  const {
    galleryError, refreshGallery, galleryTotal, favoritesOnly, visibleGallery,
    visibleGalleryItems, hiddenTotal, showHidden, setShowHidden, hiddenGalleryItems,
    hiddenError, hasMoreHidden, hiddenLoading, loadMoreHidden,
  } = gallery;
  const {
    setPreview, handleRemix, handleSendToImage, sendToVideo, handleSendTo3d,
    handleDelete, handleCancelPendingDelete, pendingPeerNames, handleToggleHidden, getCardProps, toggleGalleryStar,
  } = cards;

  const [verifyMode, setVerifyMode] = useState(false);
  const [selectedVerify, setSelectedVerify] = useState([]);
  const [verifyProfile, setVerifyProfile] = useState('strict_anatomy');
  const [verifyModel, setVerifyModel] = useState('auto');
  const [batchVerifying, setBatchVerifying] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  const recentItems = visibleGalleryItems.slice(0, 5);

  const toggleSelectVerify = useCallback((filename) => {
    setSelectedVerify((s) => s.includes(filename) ? s.filter((x) => x !== filename) : [...s, filename]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedVerify(recentItems.map((it) => it.filename).filter(Boolean));
  }, [recentItems]);

  const handleClearSelection = useCallback(() => {
    setSelectedVerify([]);
  }, []);

  const handleRunBatchVerify = useCallback(async (profileId, modelId = verifyModel) => {
    if (selectedVerify.length === 0) return;
    setBatchVerifying(true);
    setBatchProgress({ current: 0, total: selectedVerify.length });

    let passCount = 0;
    let failCount = 0;
    let errorCount = 0;

    for (let i = 0; i < selectedVerify.length; i++) {
      const filename = selectedVerify[i];
      setBatchProgress({ current: i + 1, total: selectedVerify.length });
      const targetItem = recentItems.find((it) => it.filename === filename);
      try {
        const res = await verifyImageNow({
          filename,
          profileId,
          prompt: targetItem?.prompt || '',
          reviewerModel: modelId !== 'auto' ? modelId : undefined,
        });
        if (res?.verdict === 'pass') passCount++;
        else if (res?.verdict === 'fail') failCount++;
      } catch (err) {
        errorCount++;
        console.error(`Verification error on ${filename}:`, err);
      }
    }

    setBatchVerifying(false);
    if (errorCount > 0) toast.warning(`Batch verification: ${passCount} passed, ${failCount} defect(s) flagged, ${errorCount} could not be verified.`);
    else toast.success(`Verified ${selectedVerify.length} images: ${passCount} passed, ${failCount} defect(s) flagged.`);
    setSelectedVerify([]);
    setVerifyMode(false);
    refreshGallery();
  }, [selectedVerify, verifyModel, recentItems, refreshGallery]);

  return (
    <>
      {galleryError && <button type="button" onClick={refreshGallery} className="text-port-accent min-h-[44px]">Gallery could not be loaded. Retry</button>}
      {(galleryTotal > 0 || favoritesOnly) && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(visibleGallery.length, 5)} of {galleryTotal})</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setVerifyMode((v) => !v);
                  setSelectedVerify([]);
                }}
                title="Select recent renders to verify anatomy and quality"
                className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
                  verifyMode
                    ? 'bg-port-accent text-white border-port-accent'
                    : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{verifyMode ? `Cancel Verify` : `Verify`}</span>
              </button>
              <FavoritesFilterChip active={favoritesOnly} onToggle={() => gallery.setFavoritesOnly((v) => !v)} />
              {galleryTotal > 5 && <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>}
            </div>
          </div>

          {verifyMode && (
            <BatchVerificationBar
              selectedCount={selectedVerify.length}
              totalImages={recentItems.length}
              onSelectAll={handleSelectAll}
              onClearSelection={handleClearSelection}
              onRunBatchVerify={handleRunBatchVerify}
              isVerifying={batchVerifying}
              progress={batchProgress}
              onCancel={() => { setVerifyMode(false); setSelectedVerify([]); }}
              selectedProfile={verifyProfile}
              onProfileChange={setVerifyProfile}
              selectedModel={verifyModel}
              onModelChange={setVerifyModel}
            />
          )}

          {visibleGallery.length === 0 ? (
            <div className="text-xs text-gray-500 py-3">{favoritesOnly ? 'No favorited images yet.' : 'No recent images.'}</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {recentItems.map((item) => {
                const isSelected = selectedVerify.includes(item.filename);
                const idx = selectedVerify.indexOf(item.filename);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={verifyMode ? undefined : setPreview}
                    onClick={verifyMode ? () => toggleSelectVerify(item.filename) : undefined}
                    selected={isSelected}
                    selectionLabel={isSelected ? String(idx + 1) : null}
                    hideActions={verifyMode}
                    onRemix={!verifyMode ? handleRemix : undefined}
                    onSendToImage={!verifyMode ? handleSendToImage : undefined}
                    onSendToVideo={!verifyMode ? sendToVideo : undefined}
                    onSendTo3d={!verifyMode ? handleSendTo3d : undefined}
                    onDelete={!verifyMode ? handleDelete : undefined}
                    onCancelPendingDelete={!verifyMode ? handleCancelPendingDelete : undefined}
                    pendingPeerName={item.pendingDelete?.peerId ? pendingPeerNames?.[item.pendingDelete.peerId] : null}
                    onToggleHidden={!verifyMode ? handleToggleHidden : undefined}
                    {...getCardProps(item.key)}
                    onToggleStar={!verifyMode ? toggleGalleryStar : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
      {hiddenTotal > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <button type="button" onClick={() => setShowHidden((s) => !s)} className="flex items-center justify-between w-full text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-white">
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({hiddenTotal})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {hiddenGalleryItems.map((item) => (
                <MediaCard key={item.key} item={item} onPreview={setPreview} onRemix={handleRemix} onSendToImage={handleSendToImage} onSendToVideo={sendToVideo} onSendTo3d={handleSendTo3d} onDelete={handleDelete} onCancelPendingDelete={handleCancelPendingDelete} pendingPeerName={item.pendingDelete?.peerId ? pendingPeerNames?.[item.pendingDelete.peerId] : null} onToggleHidden={handleToggleHidden} {...getCardProps(item.key)} onToggleStar={toggleGalleryStar} />
              ))}
            </div>
          )}
          {showHidden && hiddenError && <button type="button" onClick={refreshGallery} className="min-h-[44px] text-port-accent">Retry hidden images</button>}
          {showHidden && !hiddenError && (hasMoreHidden || hiddenLoading) && (
            <button type="button" disabled={hiddenLoading} onClick={loadMoreHidden} className="min-h-[44px] text-port-accent disabled:opacity-50">
              {hiddenLoading ? 'Loading…' : 'Show more hidden'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
