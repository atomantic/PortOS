# Federated peers via tailcat (no Tailscale account)

PortOS can federate with another install over
[tailcat](https://github.com/tailscale/tailcat) — Tailscale's userspace
WireGuard + DERP data plane **without** a Tailscale account, daemon, or
tailnet. Use this when a trusted peer that cannot join your tailnet needs remote API access to PortOS.

## Port standard

| Side | Port | Role |
|------|------|------|
| Home / remote PortOS | **5565** | Loopback remote ingress (`PORTS.TAILCAT_INGRESS`), started by managed serve |
| Operator / client PortOS | **15555** (preferred) | Local `tailcat forward` listener (`PORTS.TAILCAT_FORWARD` / `DEFAULT_TAILCAT_LOCAL_PORT`) |

Mapping: `tailcat forward <tcADDR> 15555:5565` binds `127.0.0.1:15555` to the
remote's `:5565`. If `15555` is already taken, PortOS walks upward to the next
free loopback port and registers the peer at that local port instead.

No `tailcat serve all`, no exit-node mode, and no Tailscale daemon are used.

## Remote authority and upgrades

Managed serve exposes the **remote** PortOS API on loopback `:5565`, with the same
HTTP/HTTPS mode and optional instance authentication as the main API. The listener
marks requests as remote before dispatch, so Agent Context MCP and its manifest
reject them even though Tailcat connects from localhost. Headers cannot claim local
authority. Local MCP clients on the main API or HTTP mirror continue to work.

A Tailcat capability still grants normal remote PortOS API access. Share it only
with trusted peers; this is not a restricted API for an untrusted sandbox.
Managed serve cannot be redirected to the main API, its HTTP mirror, or another
port. Manually serving `5555` or `5553` bypasses this protection.

Migration 370 moves existing managed serve configuration to `5565`, preserving the
key/address and enabled flag. **Both ends need the new port:** new forwards default
to `5565`, while saved forwards keep their old remote port because the other install
may not have upgraded. After the remote upgrades, use **Retry on :5565** on its
forward row. New peers have a **Remote Tailcat port** field; select `5555` only for
an older, explicitly trusted peer still serving its legacy API. Older clients must
upgrade or run a manual forward targeting `5565`; the new server never reopens a
raw `5555` tunnel for compatibility.

## Dial direction (who initiates)

Two polarities, one transport. You do **not** need both directions for v1.

| Choice | This node does | Other node does | When to use |
| --- | --- | --- | --- |
| **Dial them** | Paste their `tc…`, run `tailcat forward`, register peer at `127.0.0.1:<local>` | Runs `tailcat serve` (PortOS-managed or CLI) for `:5565` | This node can dial out freely (common for a sandbox / VPS). |
| **They dial us** | PortOS starts **serve** for `:5565`, you **Copy** our `tc…` | Pastes our address as **Dial them** on their Instances UI | This node is a poor dialer (client firewall / Little Snitch often blocks home `tailcat forward`) but a good *listener*; the other side is a better outbound initiator. |

Hypothesis (non-binding): reverse polarity helps when the current node is a better
outbound initiator than the peer that should dial it — use the product option;
do not hardcode any particular host.

### Fleet sketch (replace cloud Tailscale with per-node tailcat)

1. Every PortOS enables **Tailcat serve (this node)** (stable key `portos-api`).
2. Each peer that should reach another uses **Dial them** with that node's
   copied `<tcADDR>` (machine-local forward → `127.0.0.1:15555`).
3. No Tailscale account, daemon, `serve all`, or exit-node.
4. If dials fail with `context deadline exceeded` / `tunnel_dial` while the
   far side self-dials fine via DERP, flip polarity: serve on the blocked
   dialer, dial from the good initiator.

## Operator flow (Instances UI)

1. Open **Instances → Add Peer → Tailcat**.
2. Choose **Dial them** or **They dial us**.
3. **Dial them:** paste the peer's `tc…` address (received out of band). PortOS
   ensures `tailcat` is installed, starts the forward, and registers a peer at
   `127.0.0.1:<localPort>`. Select **Remote PortOS uses HTTPS** if needed.
4. **They dial us:** start serve (or use the **Tailcat serve** panel), **Copy**
   our address, and paste it into the *other* PortOS as Dial them.
5. Classic **Host / port** add remains unchanged (still rejects loopback).

### How `tailcat` gets installed

`ensureTailcatInstalled` first looks for a runnable binary — PATH, then
`$GOBIN`/`$GOPATH/bin`, then the Homebrew prefix, since a long-running server
does not necessarily have a package manager's bin directory on its inherited
PATH. A candidate only counts when `tailcat version` parses to
**≥ `MIN_TAILCAT_VERSION` (`0.6.0`)**. Older binaries are treated as unusable
(see [Minimum Tailcat version (PSK)](#minimum-tailcat-version-psk) below): PortOS
tries to install/upgrade rather than proceeding into a TCP timeout.

When no usable binary is found it runs the package managers the operator already
has, in order, and stops at the first that produces a **≥0.6.0** binary. After
every installer it re-checks the version before returning success.

| Order | Command | Available when |
| --- | --- | --- |
| 1 | `brew install tailcat` then `brew upgrade tailcat` (with `HOMEBREW_NO_AUTO_UPDATE=1`) | `brew` on PATH |
| 2 | `go install github.com/tailscale/tailcat/cmd/tailcat@latest` | `go` on PATH |

Homebrew is tried first for two reasons. **Tailcat publishes release binaries
for Linux and Windows only**, so on macOS `brew` is the only prebuilt route and
the releases page is a dead end. And `go install` needs to reach the Go module
proxy through Go's own dialer, which a local network filter can break in a way
that surfaces only as `dial tcp …:443: connect: bad file descriptor` — Homebrew
downloads over plain HTTPS and is unaffected.

Hypothesis (non-binding): Homebrew often leaves an older bottle (e.g. **0.5.0**)
when the index is stale or `install` is a no-op for an already-present formula —
that is why PortOS follows `install` with `upgrade`, then falls through to
`go install @latest`, and **refuses to report success** if the binary is still
below 0.6.0 (`TAILCAT_VERSION_TOO_OLD` with upgrade instructions).

If every strategy fails, the error names each command and the first line of what
it said (or the leftover version), followed by platform-appropriate manual
guidance (`brew upgrade tailcat` on macOS, the releases page / `go install`
elsewhere). Dial-them, They-dial-us / managed serve, and Instances UI surfaces
all share this gate via `ensureTailcatInstalled` — failures become API errors
and `lastError` on forwards/serve, not a later silent timeout.

### Minimum Tailcat version (PSK)

PortOS requires **Tailcat ≥ 0.6.0** for managed install/detect.

| Symptom | Cause |
| --- | --- |
| DERP discovery ping works (`--key=new` pong) but TCP `forward` / PortOS health probes time out (`context deadline exceeded`) | Client on **≤0.5.x** talking to a serve that defaults **`--psk` true** (documented since v0.6.0 `serve --help`; set `--psk=false` only for compatibility with clients v0.5.0 and earlier) |

**Do not** “fix” this by auto-setting `--psk=false` on serve. Upgrade the
client (Homebrew / `go install …@latest`) so both sides share modern PSK
defaults. Confirmed in the wild: a home host on Homebrew **v0.5.0** against a
sandbox serve on **v0.6.0** showed exactly the ping-ok / TCP-timeout split;
upgrading the home client to 0.6.0 restored bidirectional HTTP health
immediately — not a firewall or identity collision.

HTTP is the default; HTTPS runs through the same loopback tunnel. Remote
announcements cannot replace the managed local host or forwarding port.

Forwards are persisted in machine-local `data/tailcat-forwards.json` so PortOS
can restart them on boot **and retry one that failed to start**. Graceful
shutdown stops forwards while retaining their restart metadata.

**Serve** is persisted separately in machine-local `data/tailcat-serve.json`
(enabled flag, status, local port, key name, last error, and the listen
address). PortOS runs `tailcat serve --full-address --json --key=portos-api 5565`
(not `serve all`, not exit-node), restores serve on boot when enabled, and stops
the child on shutdown. The serve status API returns the full `tc…` address so
the Instances UI can offer **Copy** — that is *this node's* capability to share
out of band. Forward listings still return only the redacted form of a *peer's*
pasted address. Logs always redact. Never place a serve or forward capability on
a peer record, never federate these files, and never commit real `tc…` values —
placeholders such as `<tcADDR>` or `tcEXAMPLE…` only.

| Serve surface | What it does |
| --- | --- |
| `GET /api/instances/peers/tailcat/serve` | Status: live/enabled/ports/key, copyable `tcAddress` when known, redacted preview, last error. |
| `POST …/serve` | Ensure serve is running for `PORTS.TAILCAT_INGRESS` (5565). |
| `POST …/serve/retry` | Restart from the saved config. |
| `DELETE …/serve` | Stop serve and disable restore-on-boot. |

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

Linked forwards (`peerId` set) render on the **federated peer card** — mapping,
live/running/no-route/failed, `tunnelError`, Retry, and Forget — so the card is
the primary source of truth. The standalone **Tailcat forwards** panel only
lists **orphans / pre-peer failures** (no peer yet, or peer gone), still with
Retry and Forget. A boot-time restore failure lands there when it never
registered a peer, so the one case nobody is watching still surfaces somewhere
actionable.

Each peer card also exposes a **Health check** control that forces
`POST /api/instances/peers/:id/probe` and shows the last probe result
(`lastProbe`: class, message, HTTP status, latency, timestamp) plus
`nextProbeAt`. Probe classification distinguishes:

| Class | Meaning |
| --- | --- |
| `local_refused` | Loopback connection refused — the forward is not listening |
| `tunnel_dial` | Listener up but tunnel cannot dial (uses `tunnelError` when present) |
| `probe_http` / `probe_timeout` / `auth_required` | Tunnel carried bytes (or timed out) but `/api/system/health/details` failed |

`GET /api/instances` attaches `tailcatForward` onto `transport: 'tailcat'` peers
(redacted listing fields only). Server logs include the structured class, e.g.
`[local_refused] …`.

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
the `tailcat` binary outbound in the filter, then Retry the forward. If outbound
allow-listing is impractical on this host, switch to **They dial us**: serve
here and have the sandbox (or other good initiator) Dial them toward this node.

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
tailcat serve --full-address --key=new 5565
```

## Privacy

- Do not paste real `tc…` addresses into tickets, chat logs synced to peers, or
  screenshots that leave the machine.
- Server logs print a redacted form (`tcAB…wxyz`) only.
- Removing a peer stops its managed forward.

## Grok Bot / agent sandbox setup (copy/paste)

Use this when an **trusted agent peer** should run PortOS and hand the
operator a tailcat address so the home install can federate in.

### On the sandbox (serve)

```bash
# Install tailcat (pick one)
brew install tailcat
# or: go install github.com/tailscale/tailcat/cmd/tailcat@latest
# or (Linux/Windows only): a release from https://github.com/tailscale/tailcat/releases

# First start managed serve in Instances to bring up the remote ingress.
# Manual Tailcat processes must target that ingress, never the main :5555 API:
tailcat serve --key=new 5565
# stderr prints: 🐈 Server listening with new address: <tcADDR>
```

Share `<tcADDR>` with the operator **out of band** (private chat, 1Password,
operator-only channel). Do not commit it, put it in the repo, or log it to a
synced surface.

Optional named key (stable address across restarts — still a secret):

```bash
tailcat genkey --key=portos-sandbox
tailcat serve --key=portos-sandbox 5565
```

### On the operator PortOS (forward + peer)

In **Instances → Add Peer → Tailcat address**, paste `<tcADDR>`.

Or manually:

```bash
tailcat forward <tcADDR> 15555:5565
# then Add Peer → Host/port is not used for loopback; prefer the UI Tailcat path
# which registers 127.0.0.1:15555 for you.
```

### Checklist for agents

- [ ] PortOS up on sandbox `:5555`
- [ ] Prefer **Instances → Tailcat serve** (or CLI `tailcat serve --key=… 5565`) — not `serve all`, not exit-node
- [ ] Both sides on Tailcat **≥0.6.0** (`tailcat version`); upgrade if Dial-them / serve fails with `TAILCAT_VERSION_TOO_OLD` or ping-ok / TCP-timeout PSK mismatch
- [ ] Hand operator `<tcADDR>` out of band only (Copy from UI)
- [ ] Operator uses **Dial them** (local **15555 → 5565**), *or* if home dials time out, home uses **They dial us** and the sandbox Dials them
- [ ] Never write real `tc…` values into git, PR text, or federated logs

## Related

- [PORTS.md](../PORTS.md) — `TAILCAT_FORWARD` / `15555`
- [tailscale/tailcat](https://github.com/tailscale/tailcat) — CLI reference


## Code ownership

Shared CLI discovery, version-gated installation, and DERP cache priming live in
`server/services/tailcatRuntime.js`; pure capability validation and diagnostic
redaction live in `server/lib/tailcatAddress.js`. Both dial directions import
these owners directly. `tailcatPeer.js` retains compatibility re-exports and
owns forward storage, child processes, port allocation, tunnel verification,
peer registration, rollback, retry, and restore. `tailcatServe.js` owns serve
storage, keys, and lifecycle; `tailcatIngress.js` owns the isolated remote
ingress listener. Version parsing and the minimum supported version remain in
`server/lib/tailcatVersion.js`.
