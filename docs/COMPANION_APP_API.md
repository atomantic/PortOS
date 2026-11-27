# Companion-app API

Native companion clients connect to the user's own PortOS installs over
Tailscale. The server listens on port 5555 with HTTP or configured HTTPS.
The mirror on 5553 is loopback-only. See [port assignments](PORTS.md).

## Discover an instance

`GET /api/system/health` is available before login. Use `instanceId` as
the stable installation key (it can be null before setup), and
`name` or `hostname` as the display label. `scheme`, `version` and
`authRequired` describe the instance's API transport and auth status.
Store a separate connection and credential for each instance.

## Operator sessions vs. HTTP Basic

On a password-enabled install, ordinary reads accept HTTP Basic using an
empty username and the instance password. Store it in the device's secure
credential store. Writes and sensitive reads listed in
`server/lib/hostControlRoutes.js` require an operator session.
Peer-federation bootstrap and scoped peer routes have their own rules.
See the [API security model](API.md#security-model) and
[peer push authentication](PEER_PUSH_AUTH.md).

Send `POST /api/auth/login` with JSON `{ "password": "…" }`. The response
reports authentication and sets a session cookie in `Set-Cookie`. Retain
it in the client cookie store per instance and send it with protected
requests. The name is port-scoped and should come from the response.
`GET /api/auth/status` reports the password gate and
`GET /api/auth/whoami` checks the session. A passwordless install permits
remote ordinary reads but reserves host control for loopback.
Login there returns `400 AUTH_NOT_ENABLED`.

On `401 AUTH_REQUIRED`, obtain an accepted credential. On
`403 HOST_CONTROL_FORBIDDEN` or `PEER_SETTINGS_OPERATOR_REQUIRED`, check
that the request carries an operator session. Preserve normal browser
origin behavior for an embedded viewer. Native HTTP requests should
leave browser-origin headers unset.

## Instance management and remote desktop

Find the mounted self, peer and sync routes in the
[live API inventory](API.md). Read self and status with the baseline
credential. Use an operator session for rename, peer changes, probes and
sync actions.

Remote desktop also requires the instance password to be enabled.
`GET /api/remote-desktop/status` reports host readiness. With a session,
`POST /api/remote-desktop/sessions` returns `{ viewerPath, expiresAt }`.
Open the five-minute viewer path in an embedded browser. Enter the
separate VNC password inside the viewer. Its WebSocket targets the
server-configured loopback VNC port. See [remote desktop setup](REMOTE_DESKTOP.md).

## Quick actions and daily log

`GET /api/palette/manifest` describes navigation and permitted action
schemas. Use it to render native controls. Dispatch
`POST /api/palette/action/:id` with an optional `{ "args": {} }` and an
operator session. Results are `{ ok, result }`. Unknown action IDs
return 404. Use Brain capture for classified notes and daily log for
quick text.

`POST /api/brain/daily-log/:date/append` accepts `{ text, source }` and
returns `{ date, entry }`. The date is `today` or `YYYY-MM-DD`, and
`source` is `text`, `voice` or `edit` (unrecognized values normalize
to `text`). The palette's `daily_log_append` always tags `voice` and
returns the voice action result. Transcribe on-device or through the
supported Socket.IO path before posting text.

## POST progress

Read configuration, sessions and progress under `/api/meatspace/post` on
each instance directly. POST history is private to that installation
and excluded from federation. Record scored tests with
`POST /api/meatspace/post/sessions`. For practice, use
`POST /api/meatspace/post/training/runs` with a stable UUID and attempt IDs.
Retry the identical payload after a transport failure. The run and its
attempts commit together.

## MortalLoom recovery

MortalLoom uses a separate iCloud JSON import. Read status and use
**Settings → MortalLoom** to preview or download a verified recovery
copy. Restore against the displayed current revision or use MortalLoom's
Restore from File with the downloaded copy if iCloud reports a conflict.
PortOS pauses shared writes during uncertain iCloud state and keeps local
planning metadata and recovery copies outside shared data. Use the live
HTTP inventory for the import and recovery operation schemas.
