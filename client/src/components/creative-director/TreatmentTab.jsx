export default function TreatmentTab({ project }) {
  const t = project.treatment;
  if (!t) {
    return (
      <div className="text-port-text-muted text-sm max-w-2xl">
        No treatment yet. The agent will write one when you start the project.
        Once written, scenes appear here read-only — regenerating the
        treatment is a future enhancement.
      </div>
    );
  }
  return (
    <div className="space-y-4 max-w-4xl">
      <section className="bg-port-card border border-port-border rounded p-4 space-y-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-port-text-muted">Logline</div>
          <div className="text-sm">{t.logline}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-port-text-muted">Synopsis</div>
          <div className="text-sm whitespace-pre-wrap">{t.synopsis}</div>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">
          Scenes ({t.scenes.length})
        </h2>
        {t.scenes
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((s) => (
            <div key={s.sceneId} className="bg-port-card border border-port-border rounded p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium">
                  Scene {s.order + 1}: {s.intent}
                </div>
                <span className="text-xs text-port-text-muted">
                  {s.durationSeconds}s {s.useContinuationFromPrior ? '· continues' : s.sourceImageFile ? '· from image' : '· text-to-video'}
                </span>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-port-text-muted font-mono mt-2">{s.prompt}</pre>
              {s.negativePrompt && (
                <pre className="whitespace-pre-wrap text-xs text-port-error/70 font-mono mt-1">neg: {s.negativePrompt}</pre>
              )}
            </div>
          ))}
      </section>
    </div>
  );
}
