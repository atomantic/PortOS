import { ChevronsUpDown } from 'lucide-react';
import IssueRow from './IssueRow.jsx';

export default function UngroupedIssues({ issues, seasons, onIssuesUpdate }) {
  return (
    <section className="bg-port-card border border-port-border rounded-lg">
      <div className="flex items-center gap-2 p-3 border-b border-port-border">
        <ChevronsUpDown size={16} className="text-gray-500" />
        <h3 className="text-xs uppercase tracking-wider text-gray-500">
          Un-grouped issues / episodes ({issues.length})
        </h3>
      </div>
      <ul className="px-3 py-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6 gap-3">
        {issues.map((iss) => (
          <IssueRow
            key={iss.id}
            issue={iss}
            seasons={seasons}
            onIssuesUpdate={onIssuesUpdate}
          />
        ))}
      </ul>
    </section>
  );
}
