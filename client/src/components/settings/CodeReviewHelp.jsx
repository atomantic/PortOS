// The once-per-page explanation for Code Reviewers. Tier cards used to repeat
// this beside every fallback, and the page opened with the same paragraphs
// again. Consequences that belong next to a control stay on the page; this
// drawer is the reference for how the chain behaves.

function Section({ title, children }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <div className="space-y-2 text-sm text-gray-400 leading-relaxed">{children}</div>
    </section>
  );
}

export default function CodeReviewHelp() {
  return (
    <div className="space-y-5">
      <Section title="Which tier runs">
        <p>Primary is tried first. The first tier whose reviewers are all available runs. One paused member skips that whole tier.</p>
        <p>If every tier has a paused member, Primary still runs and those reviewers report unavailable. Status on the tier is a preview of this draft. It changes when you save.</p>
        <p>Clearing every tier turns AI review off. Forge reviewers in the section below the tiers stay in place.</p>
      </Section>
      <Section title="Order inside a tier">
        <p>Tool-free reviewers run before standalone CLI and Copilot reviewers. A move that would put a CLI reviewer ahead of a tool-free one is put back into that order.</p>
        <p>Model, effort, optional, and max-round pins belong to the reviewer, not the tier. The same reviewer in two tiers shares one pin.</p>
      </Section>
      <Section title="Moving tiers and reviewers">
        <p>Drag a handle with a pointer or touch. From the keyboard, press Space on a handle, move with the arrow keys, then Space to drop. Escape cancels.</p>
        <p>Earlier and Later move a whole tier. Move to tier moves one reviewer without dragging.</p>
      </Section>
      <Section title="Providers and legacy backends">
        <p>Add a configured provider, then set its model and effort on the row. The account and transport stay attached to that provider. Choose Custom… on the model menu to type an id that is not in the catalog.</p>
        <p>Standalone / legacy backend is the direct CLI, local runtime, and Copilot list. Those identities do not pick a provider account.</p>
      </Section>
      <Section title="Row controls">
        <p>Optional (~opt) still runs the reviewer, but an inconclusive result does not block the merge. A hard failure still does.</p>
        <p>Max caps review, fix, and re-review rounds. Blank uses the reviewer’s built-in cap. 0 means loop until clean.</p>
        <p>Stop mode, under the tiers, decides whether every reviewer must finish or the loop can stop earlier. It applies when two or more reviewers are configured.</p>
      </Section>
      <Section title="Forge reviewers">
        <p>GitHub and GitLab usernames gate the merge and are not members of a tier. Separate names with commas or newlines. Enter adds the list. An invalid name or a full roster leaves the draft so you can correct it.</p>
      </Section>
      <Section title="Follow-up">
        <p>Follow-up is a second check after a run ships. It compares the accumulated diff with the task objective: what is missing, what was never requested, and whether the work was verified. It is not the code-quality review.</p>
        <p>It runs on a local model, either the one you pick or whichever local reviewer the chain already uses. Leaving it on does nothing until a local model is available.</p>
        <p>A rethink verdict means the run built the wrong thing and the run needs attention. Fix-first is advisory. Act on which verdicts chooses whether follow-up actions also fire for that advisory result.</p>
        <p>File an issue writes the finding to the tracker the project uses (GitHub, GitLab, or JIRA). A key in the issue body reuses the existing issue for that finding, including after it was closed. A tracker PortOS cannot read refuses the filing instead of risking a duplicate.</p>
        <p>Queue an agent adds a CoS task that claims the issue, or works the finding directly when no issue was filed. The agent checks the finding first. When the objective was already delivered, it reports the context the reviewer missed instead of shipping a change. Repeated findings share one queued task.</p>
      </Section>
    </div>
  );
}
