import AppQuality from '../AppQuality';

export default function QualityTab({ app }) {
  return (
    <div className="w-full min-w-0">
      <AppQuality app={app} detail />
    </div>
  );
}
