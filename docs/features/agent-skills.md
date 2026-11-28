# Agent skills

Open **Settings → Agent Skills** to find, read and maintain skills available to PortOS agents. Skills use the [Agent Skills](https://agentskills.io) directory format. Put a `SKILL.md` with a short name and description in a directory under `data/skills/`. Keep lengthy references, templates, scripts and examples in the corresponding support subdirectories so agents can request them only when needed.

## Discovery and editing

- A managed app's repository skills participate when **Discover repo skills for agents** is enabled in its Workflow settings. The registry also reads local, shipped and explicitly configured external skills.
- Precedence is project, local, shipped, then external. A higher tier shadows a lower tier. If a name is ambiguous within a tier, use its full ID, such as `local:writing/notes`.
- Platform filters hide inapplicable skills. Project and external skills pass a deterministic scan of their instructions and supporting text. Quarantined entries show reasons in the registry and cannot be loaded.
- Edit local skills from the tab. Agent writes require the separate default-off **Allow mind to author procedural skills** grant and apply only to the local tier. **Lock** protects a local skill from agent edits. The operator can still edit it.

## Curator and history

**Pin** protects a skill from automated archiving and deletion. **Let curator manage** opts a local skill into age-based review. In the curator panel, inspect view and agent-use counts, set thresholds, and **Preview pass** before choosing **Run now** or enabling the scheduled Skill Curator job. The default thresholds mark managed idle skills stale after 14 days and archive after 30. Skills referenced by jobs, locked skills and pinned skills are skipped.

Use **Restore** to recover an archive if its local name and path are free. The **History** drawer shows local changes and can roll back an individual edit while available in the bounded history. If usage is unavailable, repair the usage record before trying protected writes.
