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
- **Account probes target the wrong host.** Account discovery and token lookup
  must use the resolved GitHub host, including Enterprise hosts. A token stored
  for the alias or another host cannot satisfy the app's account pin.

Only literal `Host` → `HostName` pairs are honored. `Match` blocks, `Include`
directives, wildcard patterns, and `%h`-style `HostName` tokens are left alone:
each can make resolution depend on the user, the network, or another file, and a
repo's forge identity must not change with the network the machine is on. An
unresolved host passes through untouched.

## 2. The app must name the account to run as

Set **GitHub Account** on the app (Apps → edit → Workflow), or `forgeAccount` in
the app record. It takes a `gh` login you are already authenticated as:

```bash
gh auth login --hostname github.com  # use the app's Enterprise hostname when applicable
gh auth status --hostname github.com
```

When set, PortOS resolves that account on the repository's host for every agent it
launches against the app's repo (and every worktree of it), and for PortOS-owned
`gh` probes against that repo (the claim-issue work detector and scheduled-task
issue preloads):

| | |
|---|---|
| `GH_HOST` | the normalized repository host; `ssh.github.com` maps to `github.com` |
| `GH_TOKEN` | the selected account's token on `github.com` and Enterprise Cloud hosts under `*.ghe.com` |
| `GH_ENTERPRISE_TOKEN` | the selected account's token on GitHub Enterprise Server hosts |
| `GIT_AUTHOR_*` / `GIT_COMMITTER_*` | Public GitHub uses `<id>+<login>@users.noreply.github.com`; Enterprise uses the authenticated user's API-returned email, when available |

Account probes clear all four ambient GitHub token variables before reading the
host's keyring. The execution environment carries only the selected host's token
family. An Enterprise account whose API exposes no email keeps the existing Git
identity; PortOS does not invent a public GitHub noreply address for it. Git's SSH
transport still uses the SSH identity configured for the remote.

Without the probe pin, those checks inherit the install's ambient `GH_TOKEN` or
active `gh` user, so a private repo under another logged-in account fails the
detector as a transient forge error and never dispatches an agent.

When the account exposes a usable commit identity, PortOS applies it alongside
the credential so commits are attributed to the selected account.

The identity arrives as environment variables on the agent process rather than as
`git config`, so PortOS never mutates a repository it does not own, and the
override lives exactly as long as the run.

### When it is left blank

The account is inferred by matching the repo owner against your logged-in `gh`
accounts on that host. When no account/token can be resolved, unpinned repositories
retain their ambient authentication. Owner matching **does not override commit
identity**. That inference is correct whenever the owner's login *is* the
account that should push — so most personal repos need no configuration at all.
Set the field when it is not: an organization repo, a bot account, or any repo
whose owner login differs from the account you push with.

### When the selected account is unavailable

An explicit pin never falls back to another account or host. If `gh` cannot
return that account's token on the repository host, PortOS refuses the agent
launch or forge operation with `FORGE_ACCOUNT_UNAVAILABLE`. A missing repository
path or origin also refuses an explicit pin. A timed-out spawn lookup refuses
with `FORGE_AUTH_TIMEOUT` when a pin exists or the lookup has not yet established
whether one exists.

Check `gh auth status --hostname <host>` and sign in as the selected account on
that host. Scope refresh uses the same host and expected account; because
`gh auth refresh` refreshes only the active account, PortOS asks you to switch to
the selected account first when necessary.

## Related

- [SELF_UPDATE.md](./SELF_UPDATE.md) — PortOS's own fork-aware update path
- `server/services/forgeAuth.js` — account/token/identity resolution
- `server/lib/sshHostAlias.js` — the ssh-alias resolver and what it declines to interpret
