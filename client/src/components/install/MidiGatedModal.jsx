/**
 * Gated-repo gate for MuScriptor (audio → MIDI) transcription. MuScriptor's
 * model weights live in a gated HuggingFace repo (MuScriptor/muscriptor-*), so
 * a first transcribe with no accepted license / token 403s. useMidiTranscription
 * opens this when the job streams a `gated_repo` error frame — the user accepts
 * the license and pastes a read token (reusing HfTokenBanner, the same
 * paste-and-save flow the gated image models use), then `onSaved` re-runs the
 * captured transcription.
 */

import { KeyRound } from 'lucide-react';
import Modal from '../ui/Modal';
import HfTokenBanner from '../imageGen/HfTokenBanner';

export default function MidiGatedModal({ open, repo, onSaved, onClose }) {
  const licenseUrl = repo ? `https://huggingface.co/${repo}` : 'https://huggingface.co';
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      align="top"
      zIndexClassName="z-[9999]"
      ariaLabelledBy="midi-gated-title"
      backdropClassName="bg-black/70 backdrop-blur-sm"
      panelClassName="bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden"
    >
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-port-border">
        <KeyRound size={18} className="text-port-warning" />
        <h2 id="midi-gated-title" className="text-sm font-semibold text-white">
          HuggingFace access required
        </h2>
      </div>
      <div className="px-5 py-4">
        <HfTokenBanner
          modelLabel={repo || 'MuScriptor'}
          licenseUrl={licenseUrl}
          onSaved={onSaved}
        />
      </div>
    </Modal>
  );
}
