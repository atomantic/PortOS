import { useCallback } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, FileText, RefreshCw, ShieldAlert, ShieldCheck, Skull } from 'lucide-react';
import * as api from '../services/api';
import MarkdownOutput from '../components/cos/MarkdownOutput';
import PageSkeleton from '../components/ui/PageSkeleton';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

const VERDICT_STYLES = {
  CLEAN: { Icon: ShieldCheck, className: 'bg-port-success/15 text-port-success border-port-success/30' },
  CAUTION: { Icon: ShieldAlert, className: 'bg-port-warning/15 text-port-warning border-port-warning/30' },
  DANGEROUS: { Icon: Skull, className: 'bg-port-error/15 text-port-error border-port-error/30' }
};

// `/brain*` is a full-width Layout route (bare `overflow-hidden` <main>), so this
// page must own its own vertical scroll or long reports get clipped below the fold.
function Shell({ children }) {
  return (
    <div className="h-full overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">{children}</div>
    </div>
  );
}

export default function BrainScanReport() {
  const { id } = useParams();
  const fetchReport = useCallback(async () => {
    const [link, report] = await Promise.all([
      api.getBrainLink(id, { silent: true }),
      api.getBrainScanReport(id, { silent: true })
    ]);
    return { link, report };
  }, [id]);
  const { data, loading, refetch } = useAutoRefetch(fetchReport, 30_000);

  if (loading) {
    return (
      <Shell>
        <PageSkeleton
          label="Loading scan report"
          headerRowClass="flex flex-wrap items-start justify-between gap-3"
          titleWidthClass="w-64"
          cards={1}
          sidebar={false}
        />
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <div className="py-12 text-center">
          <p className="text-sm text-gray-400">This scan report is unavailable.</p>
          <Link to="/brain/links" className="mt-3 inline-block text-sm text-port-accent hover:underline">Back to links</Link>
        </div>
      </Shell>
    );
  }

  const verdict = data.link.malwareScan?.verdict;
  const verdictStyle = VERDICT_STYLES[verdict];
  const VerdictIcon = verdictStyle?.Icon;

  return (
    <Shell>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/brain/links" className="mb-2 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-white">
            <ArrowLeft size={14} /> Brain Links
          </Link>
          <div className="flex items-center gap-2">
            <FileText className="text-port-accent" size={24} />
            <h1 className="truncate text-xl font-semibold text-white">{data.link.title}</h1>
          </div>
          <p className="mt-1 break-all text-xs text-gray-500">{data.link.url}</p>
        </div>
        <div className="flex items-center gap-2">
          {verdictStyle && (
            <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-semibold ${verdictStyle.className}`}>
              <VerdictIcon size={14} /> {verdict}
            </span>
          )}
          <button
            type="button"
            onClick={refetch}
            className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-400 hover:text-white"
            title="Refresh scan report"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </header>

      <article className="rounded-lg border border-port-border bg-port-card p-4 sm:p-6">
        <MarkdownOutput content={data.report} />
      </article>
    </Shell>
  );
}
