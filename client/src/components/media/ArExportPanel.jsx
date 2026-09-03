import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Box, Loader2, QrCode, Smartphone } from 'lucide-react';
import { imageTo3dUsdzUrl, uploadImageTo3dUsdz } from '../../services/api';
import {
  AR_TRIANGLE_BUDGET,
  countSceneTriangles,
  exportSceneToUsdz,
  supportsArQuickLook,
} from '../../lib/usdzExport.js';
import { generateQrCodeSvg } from '../../lib/qrCode';
import useMounted from '../../hooks/useMounted';
import { formatBytes } from '../../utils/formatters';
import toast from '../ui/Toast';

/**
 * "Export for AR" on `/3d/:id` — the step that takes a generated mesh off the
 * screen and into the user's actual room (#5756).
 *
 * The conversion happens HERE, in the browser, because the viewer has already
 * parsed the GLB and decoded its textures; the server only stores the result. The
 * bytes are persisted rather than handed back as a blob URL: AR Quick Look does
 * not reliably open a blob, and a blob does not survive a reload — so a record
 * exported once is re-served on every later visit instead of re-exported.
 *
 * The affordance is deliberately NOT the same on every device. Only Safari on
 * iOS/iPadOS implements the `<a rel="ar">` handoff, so that is the only place a
 * "View in AR" label is honest; everywhere else this is a plain `.usdz` download
 * plus a QR code, which is the bridge from "I generated this at my desk" to "it is
 * now on my floor".
 */
export default function ArExportPanel({ record, scene, onRecordChange }) {
  const mountedRef = useMounted();
  const [busy, setBusy] = useState(false);

  // Resolved once per mount rather than per render: it is a static browser
  // capability, and re-probing it on every keystroke elsewhere on the page is
  // pointless DOM work.
  const canQuickLook = useMemo(() => supportsArQuickLook(), []);
  const usdzUrl = imageTo3dUsdzUrl(record.id);
  // AR Quick Look needs a real URL and the QR code needs an absolute one — the
  // install's own origin as this browser reached it, which is already the
  // Tailscale HTTPS host when the page was opened that way.
  const absoluteUsdzUrl = typeof window === 'undefined'
    ? usdzUrl
    : new URL(usdzUrl, window.location.origin).toString();

  const exported = Boolean(record.usdzPath);
  const canExport = record.status === 'ready' && Boolean(record.assetPath);

  const handleExport = useCallback(async () => {
    if (busy || !scene) return;
    setBusy(true);
    // Yield a frame so the spinner actually paints: `parseAsync` is async but its
    // work is CPU-bound and long enough on a textured mesh to freeze a button that
    // never got a chance to re-render.
    await new Promise((resolve) => { requestAnimationFrame(() => resolve()); });

    const triangles = countSceneTriangles(scene);
    if (triangles > AR_TRIANGLE_BUDGET) {
      // Say so rather than shipping a file that opens to a blank room. Not a
      // refusal — the export still runs — but the count and the remedy are named,
      // because the only real fix is a lighter render, not a lighter export.
      toast(
        `This mesh is ${triangles.toLocaleString()} triangles — above the `
        + `${AR_TRIANGLE_BUDGET.toLocaleString()} that opens comfortably in AR. `
        + 'Re-render at a lower Quality tier for a lighter AR file.',
        { icon: '⚠️' },
      );
    }

    const bytes = await exportSceneToUsdz(scene).catch((err) => {
      toast.error(err?.message || 'Could not convert this model to USDZ.');
      return null;
    });
    if (!bytes) {
      if (mountedRef.current) setBusy(false);
      return;
    }

    const next = await uploadImageTo3dUsdz(record.id, bytes, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not save the AR export.');
      return null;
    });
    if (!mountedRef.current) return;
    setBusy(false);
    if (next) {
      onRecordChange(next);
      toast.success(`AR export ready (${formatBytes(bytes.byteLength)}).`);
    }
  }, [busy, scene, record.id, onRecordChange, mountedRef]);

  if (!canExport) return null;

  return (
    <section className="mt-4 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-port-accent" />
          <h2 className="text-sm font-semibold text-white">Augmented reality</h2>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={busy || !scene}
          title={scene ? undefined : 'Waiting for the model to finish loading'}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Box className="h-3.5 w-3.5" />}
          {busy ? 'Exporting…' : exported ? 'Re-export for AR (.usdz)' : 'Export for AR (.usdz)'}
        </button>
      </div>

      {!exported && (
        <p className="mt-2 text-xs text-gray-500">
          Converts the mesh you are looking at to USDZ so it can be placed at real scale in
          your room — no app install, no upload to anyone else.
        </p>
      )}

      {exported && canQuickLook && (
        <div className="mt-2 flex items-center gap-3">
          {/* AR Quick Look engages off an `<a rel="ar">` whose ONLY child is an
              `<img>` — Safari treats that image as the poster it badges and taps
              through. A text node inside the anchor breaks the handoff, so the
              label is a sibling and the anchor carries its own accessible name. */}
          <a
            rel="ar"
            href={usdzUrl}
            aria-label="View in AR"
            className="inline-block min-h-[44px] min-w-[44px] rounded-md bg-port-accent p-2.5 text-white hover:bg-blue-600"
          >
            <img src="/ar-quick-look.svg" alt="View in AR" width="24" height="24" className="h-6 w-6" />
          </a>
          <div className="text-xs text-gray-400">
            <p className="font-medium text-white">View in AR</p>
            <p>Opens in your room at real scale.</p>
          </div>
        </div>
      )}

      {exported && !canQuickLook && (
        <div className="mt-2 space-y-3">
          <div className="flex items-start gap-1.5 text-xs text-gray-400">
            <Smartphone className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              AR placement needs Safari on an iPhone or iPad. Scan this from your phone to
              open the model in your room, or download the file below.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="rounded-xl border border-port-border bg-white p-2 shadow"
              role="img"
              aria-label="QR code linking to the AR model"
              dangerouslySetInnerHTML={{ __html: generateQrCodeSvg(absoluteUsdzUrl, { size: 140 }) }}
            />
            <a
              href={usdzUrl}
              className="inline-flex items-center gap-1.5 text-xs text-gray-400 underline decoration-dotted hover:text-gray-200"
            >
              <QrCode className="h-3.5 w-3.5" />
              Download AR model (.usdz)
            </a>
          </div>
        </div>
      )}

      {exported && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Re-rendering this model clears its AR export — the file would no longer match the mesh.</span>
        </p>
      )}
    </section>
  );
}
