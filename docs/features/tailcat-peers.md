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
3. PortOS ensures `tailcat` is installed (PATH, else `go install
   github.com/tailscale/tailcat/cmd/tailcat@latest`), starts the forward, and
   calls the normal peer registration against `127.0.0.1:<localPort>` over HTTP.
4. Classic **Host / port** add remains unchanged (still rejects loopback).

Forwards are persisted in machine-local `data/tailcat-forwards.json` so PortOS
can restart them on boot. The full `tc…` string is a bearer capability — it is
**never** logged in full, never placed on the peer record returned to the UI or
to other peers, and must never appear in commits, PR bodies, docs, or tests.
Use placeholders such as `<tcADDR>` or `tcEXAMPLE…` only.

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
go install github.com/tailscale/tailcat/cmd/tailcat@latest
# or: brew install tailcat
# or: download a release from https://github.com/tailscale/tailcat/releases

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
