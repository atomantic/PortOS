# Federated peers via tailcat (no Tailscale account)

PortOS can federate with another install over
[tailcat](https://github.com/tailscale/tailcat) — Tailscale's userspace
WireGuard + DERP data plane **without** a Tailscale account, daemon, or
tailnet. Use this when an untrusted sandbox (or any machine that cannot join
your tailnet) needs to reach a home PortOS on `:5555`.

## Port standard

| Side | Port | Role |
|------|------|------|
| Home / remote PortOS | **5555** | Existing PortOS API (`PORTS.API`) |
| Operator / client PortOS | **15555** (preferred) | Local `tailcat forward` listener (`PORTS.TAILCAT_FORWARD` / `DEFAULT_TAILCAT_LOCAL_PORT`) |

Mapping: `tailcat forward <tcADDR> 15555:5555` binds `127.0.0.1:15555` to the
remote's `:5555`. If `15555` is already taken, PortOS walks upward to the next
free loopback port and registers the peer at that local port instead.

No `tailcat serve all`, no exit-node mode, and no Tailscale daemon are used.

## Operator flow (Instances UI)

1. Open **Instances → Add Peer → Tailcat address**.
2. Paste the peer's `tc…` address (received out of band).
3. PortOS ensures `tailcat` is installed, starts the forward, and calls the
   normal peer registration against `127.0.0.1:<localPort>`. Select **Remote
   PortOS uses HTTPS** if the remote install has enabled TLS.
4. Classic **Host / port** add remains unchanged (still rejects loopback).

### How `tailcat` gets installed

`ensureTailcatInstalled` first looks for a runnable binary — PATH, then
`$GOBIN`/`$GOPATH/bin`, then the Homebrew prefix, since a long-running server
does not necessarily have a package manager's bin directory on its inherited
PATH. When none is found it runs the package managers the operator already has,
in order, and stops at the first that produces a working binary:

| Order | Command | Available when |
| --- | --- | --- |
| 1 | `brew install tailcat` (with `HOMEBREW_NO_AUTO_UPDATE=1`) | `brew` on PATH |
| 2 | `go install github.com/tailscale/tailcat/cmd/tailcat@latest` | `go` on PATH |

Homebrew is tried first for two reasons. **Tailcat publishes release binaries
for Linux and Windows only**, so on macOS `brew` is the only prebuilt route and
the releases page is a dead end. And `go install` needs to reach the Go module
proxy through Go's own dialer, which a local network filter can break in a way
that surfaces only as `dial tcp …:443: connect: bad file descriptor` — Homebrew
downloads over plain HTTPS and is unaffected.

If every strategy fails, the error names each command and the first line of what
it said, followed by platform-appropriate manual guidance (`brew install
tailcat` on macOS, the releases page elsewhere).

HTTP is the default; HTTPS runs through the same loopback tunnel. Remote
announcements cannot replace the managed local host or forwarding port.

Forwards are persisted in machine-local `data/tailcat-forwards.json` so PortOS
can restart them on boot **and retry one that failed to start**. Graceful
shutdown stops forwards while retaining their restart metadata. The full `tc…`
string is a bearer capability — it is **never** logged in full, never placed on
the peer record returned to the UI or to other peers, never returned by an API
response, and must never appear in commits, PR bodies, docs, or tests. Use
placeholders such as `<tcADDR>` or `tcEXAMPLE…` only.

### The saved address is what makes a failed add recoverable

The row is written **before** the forward is attempted. That ordering is the
point: the `tc…` address arrives out of band and only ever existed in the Add
Peer field, so an add that died on the way up used to throw the capability away
and force the operator back to the remote for a fresh one before anyone could
even retry.

| Surface | What it does |
| --- | --- |
| `GET /api/instances/peers/tailcat/forwards` | Every saved forward: status (`pending`/`active`/`failed`), whether it is running, the local↔remote ports, the last **redacted** startup error, and `tunnelError`/`tunnelErrorAt` when a running forward cannot actually deliver. `tcAddress` is the redacted form; the credential is reported as `hasAuth` only. |
| `POST …/forwards/:id/retry` | Restarts from the stored capability, registering the peer if the original add never got that far, and repointing an existing peer when a retry has to bind a different local port. |
| `DELETE …/forwards/:id` | Stops the forward, deletes the stored capability, and removes its peer. |

The Instances page renders these as **Tailcat forwards**, with Retry and Forget
per row. A boot-time restore failure lands on the same row, so the one case
nobody is watching still surfaces somewhere actionable.

### Startup readiness has two independent signals

`startForwardProcess` spawns `tailcat forward --verbose …` and resolves when
*either* the CLI logs `forwarding 127.0.0.1:<local> -> remote localhost:<remote>`
*or* the local port stops accepting a bind (something is listening on it). It
confirms the tunnel listener, not the remote PortOS health.

`--verbose` and the bind probe are both there because of a real failure. tailcat
**≤0.5.0** — the version Homebrew installs — emits that `forwarding …` line
through its verbose-only logger, and PortOS spawned without `--verbose`: every
add against that build failed with `tailcat listener startup timed out` after 8s
while the listener was up and perfectly healthy (v0.6.0 promoted the line to an
unconditional print). So `--verbose` restores the line on released builds, and it
is also the only way per-connection `dial remote target …` failures are logged at
all. The bind probe then makes readiness independent of any log wording, so the
next CLI reword cannot regress this the same way.

On failure, tailcat's own diagnostics now reach the operator — capability-shaped
tokens scrubbed, last few lines only. An opaque "startup timed out" with the real
reason discarded is what made this take three passes to diagnose.

A failed metadata write rolls back the new peer.

### A bound listener is not a working tunnel

`tailcat forward` binds its loopback port **eagerly** and only brings the
WireGuard/DERP tunnel up when a connection arrives. So on a host where the relay
is unreachable, the forward still binds, still passes both readiness signals,
and still reports `active` / `running` — while every request through it is reset
once tailcat's dial deadline expires:

```
$ curl http://127.0.0.1:15555/api/system/health/details
curl: (56) Recv failure: Connection reset by peer      # after ~10s, every time
```

So the add does not stop at "the listener is up". Once the forward is bound,
PortOS sends one request through it (`/api/system/health` on the loopback port,
which is in the always-public set, so a password-gated remote still answers).
**Any** HTTP response counts — this probes the transport, not the API, so a 401
from a gating proxy or a 404 from an older remote is still proof that bytes
crossed. When nothing answers, the add fails with `TAILCAT_TUNNEL_UNREACHABLE`
and tailcat's own explanation, the child is killed, and no peer is registered —
the saved address keeps the forward retryable. Registering the peer anyway would
hand the operator a federation peer that looks added and can never answer.

The only place tailcat says why is its post-startup stderr
(`dial remote port 5555: context deadline exceeded`), which PortOS used to
drain and discard. It now **reads** that stream for the lifetime of the child:
a delivery failure is redacted, logged once per distinct reason, and reported on
the forward as `tunnelError` / `tunnelErrorAt`. The Instances row for such a
forward reads **no route** with the reason beneath it, instead of a green
`running` on a tunnel that cannot carry a byte.

The classifier is deliberately narrow — relay reconnects, backoff lines, and
netcheck chatter are normal on a healthy tunnel; a failed dial is not. The
values are in-memory only: they describe the child running right now, and a
per-connection failure repeating every few seconds would thrash the metadata
file. They also age out after five minutes: tailcat re-emits the line on every
failed request, so a forward that is still broken keeps refreshing it, while one
that started working again goes quiet — a latched "no route" would be the same
lie as a permanently green "running", pointing the other way.

**When an add reports the tunnel could not reach the remote, or a live forward
shows `no route`,** the tunnel — not PortOS — is what to look at. The
usual cause on macOS is a local network filter (Little Snitch and friends)
denying the `tailcat` binary itself: `tailcat forward --verbose` then logs a
relay connect that dies the instant it is established, while `curl` to the same
relay from the same machine succeeds.

```
netcheck: [v1] report: udp=false v4=false icmpv4=false v6=false derp=0
magicsock: derp.Recv(derp-301): ... connect to region 301 (nyc):
  read tcp4 <local>:<port>-><relay>:443: read: socket is not connected
dial remote port 5555: context deadline exceeded
```

UDP blocked *and* the relay refused leaves no path at all, so nothing ever
reaches the remote — which is also why the far side shows no activity. Allow
the `tailcat` binary outbound in the filter, then Retry the forward.

### The DERP map has to be reachable — by Go

tailcat resolves a `tc…` address's relay region by fetching its DERP map
(`https://tailcat.dev/derpmap.json`, override with `TAILCAT_DERPMAP_URL`) using
Go's own HTTP client. On a host where a local network filter permits Node and
curl but blocks Go's dialer, that fetch fails and **every** tailcat command dies
before it can serve or dial:

```
Expand: fetching DERPMap for region -1: Get "https://tailcat.dev/derpmap.json": context deadline exceeded
```

This is the same host condition that makes `go install` fail with
`connect: bad file descriptor` — and it is why Homebrew is tried first for the
install. PortOS reaches that identical URL fine, so before spawning tailcat it
pre-warms the cache the CLI already reads
(`<user cache dir>/tailcat/derpmap-<escaped URL>.json`, refreshed at most every
6h). Strictly best-effort: if the write or the fetch fails, tailcat just fetches
the map the way it normally would.

On the **serve** side there is no PortOS process to do that, so a sandbox on such
a host should hand out a `--full-address`, which embeds the relay info and needs
no map fetch on either end:

```bash
tailcat serve --full-address --key=new 5555
```

## Privacy

- Do not paste real `tc…` addresses into tickets, chat logs synced to peers, or
  screenshots that leave the machine.
- Server logs print a redacted form (`tcAB…wxyz`) only.
- Removing a peer stops its managed forward.

## Grok Bot / agent sandbox setup (copy/paste)

Use this when an **untrusted agent sandbox** should run PortOS and hand the
operator a tailcat address so the home install can federate in.

### On the sandbox (serve)

```bash
# Install tailcat (pick one)
brew install tailcat
# or: go install github.com/tailscale/tailcat/cmd/tailcat@latest
# or (Linux/Windows only): a release from https://github.com/tailscale/tailcat/releases

# PortOS already listening on :5555 in the sandbox, then:
tailcat serve --key=new 5555
# stderr prints: 🐈 Server listening with new address: <tcADDR>
```

Share `<tcADDR>` with the operator **out of band** (private chat, 1Password,
operator-only channel). Do not commit it, put it in the repo, or log it to a
synced surface.

Optional named key (stable address across restarts — still a secret):

```bash
tailcat genkey --key=portos-sandbox
tailcat serve --key=portos-sandbox 5555
```

### On the operator PortOS (forward + peer)

In **Instances → Add Peer → Tailcat address**, paste `<tcADDR>`.

Or manually:

```bash
tailcat forward <tcADDR> 15555:5555
# then Add Peer → Host/port is not used for loopback; prefer the UI Tailcat path
# which registers 127.0.0.1:15555 for you.
```

### Checklist for agents

- [ ] PortOS up on sandbox `:5555`
- [ ] `tailcat serve --key=… 5555` (not `serve all`, not exit-node)
- [ ] Hand operator `<tcADDR>` out of band only
- [ ] Operator uses UI Tailcat add (local **15555 → 5555**)
- [ ] Never write real `tc…` values into git, PR text, or federated logs

## Related

- [PORTS.md](../PORTS.md) — `TAILCAT_FORWARD` / `15555`
- [tailscale/tailcat](https://github.com/tailscale/tailcat) — CLI reference
