import { Link } from 'react-router';
import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';
import { filterNavByFeatures } from '../lib/navFeatures.js';
import { NAV_COMMANDS } from '../../../server/lib/navManifest.js';
import { NAV_DESTINATION_PRESENTATION } from '../lib/navPresentation.js';

export default function CreativeStudio({ studio }) {
  const studioPath = `/create/${studio}`;
  const { label: title } = NAV_COMMANDS.find(({ path }) => path === studioPath);
  const { icon } = NAV_DESTINATION_PRESENTATION[studioPath];
  const { isFeatureEnabled } = useInstanceFeatures();
  const destinations = filterNavByFeatures(NAV_COMMANDS.filter(({ parentPath }) => parentPath === studioPath), isFeatureEnabled);

  return (
    <PageLayout header={<PageHeader icon={icon} title={title} />}>
      <nav aria-label={title} className="grid gap-2 p-3 sm:grid-cols-2 lg:grid-cols-3">
        {destinations.map(({ path, label }) => {
          const { icon: Icon } = NAV_DESTINATION_PRESENTATION[path];
          return (
            <Link key={path} to={path}
              className="flex min-h-11 items-center gap-3 rounded-lg border border-port-border bg-port-card px-3 py-2 text-sm text-port-text hover:border-port-accent hover:text-port-accent">
              <Icon size={18} className="shrink-0" aria-hidden="true" />
              {label}
            </Link>
          );
        })}
      </nav>
    </PageLayout>
  );
}
