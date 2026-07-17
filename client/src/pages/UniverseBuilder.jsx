// Route entry point kept intentionally thin. The feature component owns the
// editor composition; stateful concerns live in dedicated Universe hooks.
export { default } from '../components/universeBuilder/UniverseBuilderPage';
export {
  CategoryEditor,
  OtherTab,
  TrunkView,
  UniverseSelector,
} from '../components/universeBuilder/UniverseBuilderPage';
