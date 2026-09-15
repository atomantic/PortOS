# Managed apps under a second GitHub account

One PortOS install commonly manages repositories belonging to more than one
GitHub identity — a personal account, a bot account, a client's organization.
CoS agents have to push, open pull requests, and author commits as whichever
account owns the repo they are working in, not as whoever owns the machine.

Two independent things make that work, and they fail in different ways.

## 1. The remote's host must resolve to GitHub

The usual way to key a checkout to a non-default SSH identity is a `Host` alias:

```sshconfig
# ~/.ssh/config
Host github-acme
  HostName github.com
  IdentityFile ~/.ssh/id_acme
```

```bash
git clone git@github-acme:acme/widget.git
```

Git and `ssh` resolve `github-acme` transparently, so the checkout works — but a
program reading the remote sees the literal string `github-acme`. PortOS now
resolves these aliases through `~/.ssh/config` wherever it parses a remote host
(`server/lib/sshHostAlias.js`), the same thing `gh` does before it picks an API
host. Without it, an aliased repo hits three separate failures at once:

- **CoS holds every change-request task.** The forge spawn gate probes the repo's
  host for reachability; an alias is not a resolvable API host, so it reports
  `unreachable` and holds the task — for an hour — before letting it fail.
  The symptom is `⏸️ Holding task … — github-acme is unreachable`.
- **The work tracker falls back to PLAN.md.** `auto` classifies a repo from its
  origin host, and an unrecognized host is not GitHub, so the app's issues are
  invisible to `claim-issue` and to the task data inputs.
- **Agents get no account-pinned token.** The `GH_TOKEN` overlay is gated on a
  real `github.com` host, so an aliased repo's agent falls back to `gh`'s mutable
  active user — the "must be a collaborator" failure.

Only literal `Host` → `HostName` pairs are honored. `Match` blocks, `Include`
directives, wildcard patterns, and `%h`-style `HostName` tokens are left alone:
each can make resolution depend on the user, the network, or another file, and a
repo's forge identity must not change with the network the machine is on. An
unresolved host passes through untouched.

## 2. The app must name the account to run as

Set **GitHub Account** on the app (Apps → edit → Workflow), or `forgeAccount` in
the app record. It takes a `gh` login you are already authenticated as:

```bash
gh auth login        # once per account; `gh auth status` should list them all
```

When set, PortOS pins **both halves** of that identity for every agent it
launches against the app's repo (and every worktree of it), and for PortOS-owned
`gh` probes against that repo (the claim-issue work detector and scheduled-task
issue preloads):

| | |
|---|---|
| `GH_TOKEN` | minted for that account, so `gh pr create`, `git push`, and issue-list probes act as it |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` | `<id>+<login>@users.noreply.github.com`, the address GitHub attributes back to the account |

Without the probe pin, those checks inherit the install's ambient `GH_TOKEN` or
active `gh` user, so a private repo under another logged-in account fails the
detector as a transient forge error and never dispatches an agent.

The credential and the authorship move together on purpose: authenticating as
another account while committing under the machine owner's name and email writes
the wrong person into someone else's repository history.

The identity arrives as environment variables on the agent process rather than as
`git config`, so PortOS never mutates a repository it does not own, and the
override lives exactly as long as the run.

### When it is left blank

The account is inferred by matching the repo owner against your logged-in `gh`
logins, which is what PortOS has always done, and **no commit identity is
overridden**. That inference is correct whenever the owner's login *is* the
account that should push — so most personal repos need no configuration at all.
Set the field when it is not: an organization repo, a bot account, or any repo
whose owner login differs from the account you push with.

A pinned account is never second-guessed. If `gh` has no token for it, the run
gets no pinned forge credential — `resolveForgeTokenEnv` overlays nothing, and
`buildSafeEnv` strips the ambient `GH_TOKEN` from agent shells — rather than
silently falling back to a different account's token. (PortOS's own
`resolveForgeForRepo` probes still inherit the ambient environment when no
token is minted; the no-fallback guarantee covers the credential handed to the
run, not every ambient lookup PortOS performs itself.)

## Related

- [SELF_UPDATE.md](./SELF_UPDATE.md) — PortOS's own fork-aware update path
- `server/services/forgeAuth.js` — account/token/identity resolution
- `server/lib/sshHostAlias.js` — the ssh-alias resolver and what it declines to interpret
