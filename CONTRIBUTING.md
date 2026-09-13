# Contributing to PortOS

Contributions are welcome. PortOS moves fast, and issues are often resolved and
closed quickly. Please coordinate before starting so your work does not duplicate
something already underway.

## Claim an issue before starting

1. Find an open issue. New contributors should ideally start with one labeled
   **`help wanted`** or **`good first issue`**.
2. Check its labels, assignees, and recent comments. **An issue labeled
   `in-progress` or assigned to someone is not up for grabs.** Choose another
   issue unless the maintainer explicitly invites you to collaborate.
3. Comment on the issue saying you would like to claim it, with a brief outline
   of your intended approach. For example: “I'd like to claim this issue. I plan
   to address it by …”
4. Wait for the maintainer to confirm the claim and assign you before starting
   implementation. A claim comment alone does not reserve the issue.

Anyone is welcome to file an issue and ask to work on it. Search existing issues
and PRs first, then describe the bug or proposed improvement and the scope you
would like to take on. You do not need to limit yourself to labeled starter issues.

If you can no longer work on a claimed issue, leave a comment so the maintainer
can make it available again.

## Submit a pull request

- Work on a feature branch in your fork and open your PR against **`main`**.
- Keep the change focused on the agreed issue. Link the issue in the PR and
  explain what changed, why, and how you verified it. Include screenshots for
  visible UI changes where useful.
- Follow the [development setup and code conventions](docs/CONTRIBUTING.md) and
  the applicable [repository instructions](AGENTS.md). Use descriptive
  conventional commit messages.
- Run the checks relevant to your change and report the results and any testing
  limitations. Add regression coverage when it meaningfully protects changed
  behavior. DB-backed tests must use the isolated test database, never your real
  PortOS database; see the development guide for commands.
- Respond to review feedback and keep the PR current as needed. Required CI
  checks must pass before merge.

## How PRs are accepted

The maintainer reviews contributions for fit with PortOS, correctness, scope,
and validation. Small, focused bug fixes, documentation corrections, and
quality-of-life improvements are the easiest starting points. Discuss larger
features in an issue before investing significant time.

PortOS is a personal, opinionated project that prioritizes its author's needs.
Claiming an issue or passing CI does not guarantee acceptance: the maintainer
may request changes, rework a proposal, or decline a PR that does not fit the
project. Coordinating on the issue first helps establish expectations early.
