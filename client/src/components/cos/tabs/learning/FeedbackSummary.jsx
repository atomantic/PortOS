import { MessageSquare } from 'lucide-react';

export default function FeedbackSummary({ feedback }) {
  if (!feedback?.total) return null;

  const satisfaction = feedback.satisfactionRate ?? 0;
  const satisfactionClass = satisfaction >= 80
    ? 'text-port-success'
    : satisfaction >= 60
      ? 'text-port-warning'
      : 'text-port-error';

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-port-accent" />
            <h4 className="text-sm font-medium text-white">User Feedback</h4>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Durable ratings across live and archived agent runs
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 sm:gap-6 text-center">
          <div>
            <div className={`text-lg font-bold ${satisfactionClass}`}>{satisfaction}%</div>
            <div className="text-[11px] text-gray-500">helpful</div>
          </div>
          <div>
            <div className="text-lg font-bold text-port-success">{feedback.positive}</div>
            <div className="text-[11px] text-gray-500">positive</div>
          </div>
          <div>
            <div className="text-lg font-bold text-gray-300">{feedback.neutral}</div>
            <div className="text-[11px] text-gray-500">neutral</div>
          </div>
          <div>
            <div className="text-lg font-bold text-port-error">{feedback.negative}</div>
            <div className="text-[11px] text-gray-500">negative</div>
          </div>
        </div>
      </div>
      <div className="text-xs text-gray-500 mt-3 pt-3 border-t border-port-border">
        {feedback.total} rated run{feedback.total === 1 ? '' : 's'} retained in the current archive window
      </div>
    </div>
  );
}
