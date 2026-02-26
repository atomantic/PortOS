import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';

export default function EmptyState({ message, linkTo, linkLabel }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Info size={32} className="text-gray-600 mb-3" />
      <p className="text-gray-400 text-sm max-w-xs">{message}</p>
      {linkTo && linkLabel && (
        <Link
          to={linkTo}
          className="mt-4 px-4 py-2 rounded-lg text-sm font-medium bg-port-accent/10 text-port-accent hover:bg-port-accent/20 transition-colors"
        >
          {linkLabel}
        </Link>
      )}
    </div>
  );
}
