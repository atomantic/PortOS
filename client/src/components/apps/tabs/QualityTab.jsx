import AppQuality from '../AppQuality';

export default function QualityTab({ app }) {
  return (
    <div className="max-w-5xl">
      <AppQuality app={app} detail />
    </div>
  );
}
