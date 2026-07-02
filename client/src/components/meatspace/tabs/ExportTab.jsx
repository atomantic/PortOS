import { useState, useEffect, useCallback } from 'react';
import { Printer, ClipboardCopy, FileText } from 'lucide-react';

import * as api from '../../../services/api';
import { copyToClipboard } from '../../../lib/clipboard';
import { buildClinicianReport, reportToMarkdown, formatRange, STATUS_LABELS } from '../../../lib/clinicianReport';
import { STATUS_COLORS } from '../constants';
import BrailleSpinner from '../../BrailleSpinner';
import { formatDateTime } from '../../../utils/formatters';

export default function ExportTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [blood, config] = await Promise.all([
      api.getBloodTests().catch(() => ({ tests: [] })),
      api.getMeatspaceConfig().catch(() => null),
    ]);
    setReport(buildClinicianReport({ tests: blood?.tests || [], config }));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCopy = async () => {
    await copyToClipboard(reportToMarkdown(report), 'Clinician summary copied as markdown');
  };

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <BrailleSpinner text="Building clinician summary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action bar — hidden when printing */}
      <div className="print:hidden flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText size={18} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Clinician Summary
          </h3>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-port-border text-gray-300 rounded-lg hover:border-gray-500 hover:text-white"
          >
            <ClipboardCopy size={14} />
            Copy markdown
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent text-white rounded-lg hover:bg-port-accent/80"
          >
            <Printer size={14} />
            Print / Save PDF
          </button>
        </div>
      </div>

      <p className="print:hidden text-xs text-gray-600">
        A one-page summary of your blood panels and lifestyle data to hand to a clinician.
        Use Print to save as PDF, or copy as markdown to paste into a message or note.
      </p>

      {/* Printable report */}
      <article className="bg-port-card border border-port-border rounded-xl p-6 space-y-8 print:bg-white print:text-black print:border-0 print:p-0">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-white print:text-black">
            Clinician Summary — Blood &amp; Lifestyle
          </h2>
          <p className="text-xs text-gray-500 print:text-gray-700">
            Generated {formatDateTime(report.generatedAt)}
          </p>
          <p className="text-xs text-gray-600 print:text-gray-700 italic">
            Self-tracked data exported from PortOS. Reference ranges are general adult ranges
            and not a diagnosis.
          </p>
        </header>

        {/* Lifestyle */}
        <section>
          <SectionTitle>Lifestyle</SectionTitle>
          <table className="w-full text-sm border-collapse">
            <tbody>
              {report.lifestyle.map(row => (
                <tr key={row.label} className="border-b border-port-border print:border-gray-300">
                  <th scope="row" className="text-left font-medium text-gray-400 print:text-gray-700 py-1.5 pr-4 align-top w-40">
                    {row.label}
                  </th>
                  <td className="py-1.5 pr-4 text-gray-200 print:text-black">{row.value}</td>
                  <td className="py-1.5 text-xs text-gray-500 print:text-gray-600">{row.note || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Blood panels */}
        <section className="space-y-6">
          <SectionTitle>Blood Panels</SectionTitle>
          {report.bloodTests.length === 0 ? (
            <p className="text-sm text-gray-500 print:text-gray-700">No blood test data on record.</p>
          ) : (
            report.bloodTests.map(test => (
              <div key={test.date} className="space-y-3 print:break-inside-avoid">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h4 className="text-base font-semibold text-gray-200 print:text-black">{test.date}</h4>
                  {test.outOfRange.length > 0 && (
                    <span className="text-xs text-port-error print:text-red-700">
                      {test.outOfRange.length} marker{test.outOfRange.length === 1 ? '' : 's'} out of range
                    </span>
                  )}
                </div>
                {test.categories.map(({ category, markers }) => (
                  <div key={category}>
                    <h5 className="text-xs font-medium text-gray-500 print:text-gray-700 uppercase mb-1">
                      {category}
                    </h5>
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="text-left text-xs text-gray-600 print:text-gray-700">
                          <th scope="col" className="py-1 pr-4 font-normal">Marker</th>
                          <th scope="col" className="py-1 pr-4 font-normal">Value</th>
                          <th scope="col" className="py-1 pr-4 font-normal">Reference</th>
                          <th scope="col" className="py-1 font-normal">Flag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {markers.map(m => (
                          <tr key={m.key} className="border-t border-port-border print:border-gray-300">
                            <td className="py-1 pr-4 text-gray-300 print:text-black">{m.label}</td>
                            <td className={`py-1 pr-4 font-mono ${m.outOfRange ? STATUS_COLORS[m.status] : 'text-gray-200'} print:text-black`}>
                              {m.value}{m.unit ? ` ${m.unit}` : ''}
                            </td>
                            <td className="py-1 pr-4 text-gray-500 print:text-gray-700 font-mono">
                              {formatRange(m.range) || '—'}
                            </td>
                            <td className={`py-1 ${m.outOfRange ? STATUS_COLORS[m.status] : 'text-gray-600'} print:text-black`}>
                              {m.outOfRange ? STATUS_LABELS[m.status] : ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))
          )}
        </section>
      </article>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <h3 className="text-sm font-medium text-gray-400 print:text-black uppercase tracking-wider mb-3 border-b border-port-border print:border-gray-400 pb-1">
      {children}
    </h3>
  );
}
