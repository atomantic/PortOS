# Peer record push authentication

Record pushes require a separate shared secret for each pair of instances. The
instance password remains optional. A peer's claimed instance ID, an announcement,
or its network address does not authorize record ingestion.

## Configure a pair

1. Upgrade both instances and sign in with an operator session on each machine.
   Peer configuration requires a session even on loopback, because a development
   proxy can relay remote traffic over a local socket. Open **Instances**.
2. On each matching peer card, select **Set sync secret** and enter the same
   randomly generated secret (32–256 characters). Use a different secret for each
   pair; a password manager can generate and transfer it.
3. Enable sync and the desired categories on **each** machine. Saving a secret
   admits inbound record pushes; it does not enable categories. Category and
   full-mirror changes on one machine no longer override the paired machine's
   local settings through an anonymous reciprocal callback.
4. Use **Sync now** to retry pending records. Missing or mismatched secrets return
   `PEER_SYNC_AUTH_REQUIRED`; disabled peers, non-inbound peers, sync-off peers,
   and disabled categories return `PEER_SYNC_NOT_ADMITTED` before any record,
   asset, tombstone cursor, or subscription write.

To revoke or rotate a pair, remove or replace its sync secret. Secrets stay in the
existing machine-local `instances.json` peer configuration, are stripped from
client/socket and announcement payloads, and never travel in record bodies. The
sender attaches `X-PortOS-Peer-Sync-Token` only to `/api/peer-sync/push`, alongside
the peer credential below. HTTP redirects
are refused for credentialed pushes. Use the existing private encrypted transport
(Tailscale or HTTPS) to protect these credentials in transit.

## Peer credentials are not operator authority

The instance password is operator authority: whoever holds it can sign in at
`/api/auth/login` and run host commands. A peer must not need it. Once a pair
secret is configured, every peer request (probe, sync, relay socket, media
provider) authenticates with `X-PortOS-Peer-Auth`, an HMAC-SHA256 of the pair
secret bound to the sender's `X-PortOS-Instance-Id`. The secret itself is not
sent, and each direction has a different token.

The receiver maps a verified token to `method: 'peer'`. It authenticates only
the federation surface listed below and the peer socket relay handshake. Every
other route returns `403 PEER_SCOPE_FORBIDDEN` (a plain `403` under `/data/`),
including `/api/commands/*`, even when the request also carries the password
as Basic. It cannot emit socket events and cannot be exchanged for a session,
because it is not the password. A disabled peer's token is refused.

### Peer API surface

`PEER_API_SURFACE` in `server/lib/apiAccessPolicy.js` is the contract; this
table mirrors it. `server/lib/apiAccessPolicy.test.js` scans every
`peerFetch` call site and fails when this version calls a peer path the list
does not admit.

| Methods | Path | Used by |
|---------|------|---------|
| GET | `/api/system/health/details`, `/api/apps`, `/api/instances/sync-status` | Peer probe |
| GET | `/api/apps/quality-federation` | App quality federation |
| GET | `/api/cos/agents` | Peer socket relay snapshot |
| POST | `/api/instances/peers/announce`, `/api/instances/peers/sync-categories` | Registration handshake |
| GET | `/api/brain/sync`, `/api/brain/reconcile/{checksum,snapshot,manifest}` | Brain sync and parity |
| GET | `/api/memory/sync`, `/api/catalog/sync`, `/api/sync/*` | Snapshot sync |
| GET | `/api/peer-sync/*` | Record, manifest, and archive pulls |
| POST | `/api/peer-sync/push` | Record push |
| any | `/api/federation/media/v1/*` | Federated media provider |
| GET | `/api/providers/fleet-host` | Fleet LLM host discovery |
| POST | `/api/providers/fleet-host/key` | Fleet LLM host key |
| any | `/api/eidoverse/travel/federation/*` | Eidoverse guest travel |
| GET | `/data/{images,image-refs,videos,music,audio,writers-room/works}/*` | Asset pulls |

GET includes HEAD. Paths with `.`/`..`/empty segments or encoded separators
are refused. The generic `GET /api/instances/peers/:id/query` proxy reaches only
these paths on a paired peer.

Removing an entry is a breaking change for older peers that still call it: they
receive `403 PEER_SCOPE_FORBIDDEN`, and the receiver logs one `⛔ Peer … refused
outside the federation surface` line per peer, method, and path. Adding a peer
call site means adding its entry in the same change.

Legacy HTTP Basic is the instance password itself, so it keeps operator reach
(`method: 'basic'`, still refused host control). Its holder can already sign in
at `/api/auth/login`, and the companion app uses it as a full session
(`docs/COMPANION_APP_API.md`). Pair each peer so it stops sending the password.

Rollout without breaking older installs:

- The sender sends the token and any stored Basic credential together until the
  receiver's `GET /api/system/health/details` reports
  `peerAuth.accepted: true` for the probe. It then stops sending Basic to that
  peer (`peerAuthAccepted` on the local peer record). A later 401/403 probe
  clears the flag, so Basic returns if the receiver loses its side of the pair.
- An unpaired peer, an older receiver, or one whose secret differs keeps
  receiving Basic, which is still accepted as `method: 'basic'` (also refused
  host control).
- A receiver logs one warning per process when a paired peer still signs in with
  the instance password.
- **Instances** shows a hint on each peer card with a stored password. After the
  peer confirms the token, remove the stored password there. No migration deletes
  stored credentials.

The handshake version is `peerAuth` in `server/lib/schemaVersions.js`.

## Existing installations and mixed versions

Existing peer records remain intact. No secret is synthesized or trusted from
network discovery. After upgrading, incoming record pushes pause until the pair
is configured, and existing pending subscriptions can retry afterward. Older
senders cannot authenticate to an upgraded receiver; upgrade and pair them. New
senders retain the record envelope's existing schema compatibility handling for
older receivers, which ignore the additional HTTP header. An older receiver
still needs to upgrade to enforce admission itself.

An explicit record pull uses the locally configured peer destination and verifies
that the response's source, kind, and record ID match that request. It still
requires local pairing, an enabled peer, sync consent, and category permission.
Discovery may list an unpaired peer; discovery alone cannot admit its record pushes.
Peer configuration changes require a verified operator session. If the instance
password is unset, set one and sign in to configure the pair; it may be disabled
after pairing. The peer-specific checks continue to apply while the global
password is unset. Existing host-issued operator session tokens also work.
