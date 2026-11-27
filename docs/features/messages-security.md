# Untrusted content in Messages and forge automation

PortOS screens complete input before model analysis, bounds that analysis to the configured tool-free provider, and checks fresh records and authority before any effect. Private message analysis stays on loopback. A classification result does not authorize disclosure, execution or a forge action.

## Configure an install

Review **Abuse Guard** in Settings, the selected analysis providers in CoS Schedule, and the source-specific settings for Messages or Stacker News. Install or repair the dedicated Prompt Guard classifier from its setup surface. Invalid configuration, unavailable required stages, and input the classifier cannot fully cover stop processing. Review the resulting notification or stage status before retrying.

The optional [Jev decision service](../JEV_SETUP.md) handles certain closed-set decisions after screening. Start in shadow mode to compare outcomes without letting it decide. In **prefer** mode it can abstain and fall through to text analysis. In **only** mode an abstention skips the item and records a reason. Stacker News uses it for escalation, while routine handling still needs the configured text and vision stages.

## Forge roles and actions

- **Issue Watcher** handles external activity. **Issue Reconcile** handles issue text from the repository owner or a verified write collaborator after screening accepted evidence and outside discussion.
- **PR Reviewer** handles outside PR intake in stages. Configure the exact providers under **CoS → Schedule → PR Reviewer**. The automated screening and analysis stages do not execute contributor code.
- **PR Watcher** tracks trusted maintenance, current heads and CI. PortOS verifies live write permission and current state before acting. Labels and comments alone grant no authority.
- Eligible GitHub PR notifications expose **Merge**, **Do:Review** and **Untrusted:Review**. Merge reads current checks and readiness, binds to the checked head and records success after GitHub confirms. The manual **Also run Untrusted:Review on the Run with provider** option overrides the eligibility stage for that run. The final review keeps its own configured provider.

Message triage produces recommendations. Replies remain drafts until the existing send authorization flow acts. Keep draft review and provider setup separate from permission to deliver a message.
