// Route entry point kept intentionally thin. The feature component owns the
// editor composition; stateful concerns live in dedicated Universe hooks.
import PageHeader from '../components/PageHeader';
import UniverseBuilderPage from '../components/universeBuilder/UniverseBuilderPage';

export default function UniverseBuilder({ create = false }) {
  return <UniverseBuilderPage pageHeader={<PageHeader title={create ? "New Universe" : "Universe Builder"} />} />;
}
export {
  CategoryEditor,
  OtherTab,
  TrunkView,
  UniverseSelector,
} from '../components/universeBuilder/UniverseBuilderPage';
