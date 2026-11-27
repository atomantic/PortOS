# Federated peers via Tailcat

Use [Tailcat](https://github.com/tailscale/tailcat) to connect PortOS installs you own when one cannot join your tailnet. It uses private WireGuard connections relayed via DERP. Exchange the server capability privately and verify peer identities out of band.

## Connect two installs

1. Open **Instances → Add Peer → Tailcat**. Select **They dial us** on the listener or **Tailcat serve → Start** to bring up its private ingress.
2. Copy the full `tc…` capability to the other install. There, choose **Dial them** and paste it. Select **Remote PortOS uses HTTPS** if the remote install uses it.
3. The dialer registers the peer on a local loopback port, usually 15555. The listener accepts PortOS traffic through its managed remote ingress on 5565. Keep the normal PortOS API and host controls private.
4. Verify the peer in Instances. If the dialer has restricted outbound connectivity, try the other dial direction.

PortOS checks for Tailcat 0.6.0 or newer. It can use Homebrew or Go to install or upgrade it. If automatic setup fails, verify `tailcat version` and the host's access to the package source. Use [peer administration](./peer-administration.md) for authentication and permission setup. Reachability does not grant host control.

## Require approved devices

Open **Tailcat serve → Device access**, add a label and each client's public `nodekey:` followed by 64 lowercase hex characters. Keep private keys on the client. Select **Enable device enforcement** explicitly after enrollment. In capability-only mode, anybody holding the full capability can reconnect, including a revoked device. Enforcement admits only approved keys. Revoking the last approved key suspends serving.

Changing the admitted set or enforcement restarts the listener and disconnects current sessions. If replacement fails, use Retry with the saved policy. Legacy capability-only listeners keep that state until explicitly changed.

## Recover a connection

- Check both the listener's serve status and end-to-end health. A bound local forward establishes only that the local process has a socket.
- If an add attempt stored the address but could not connect, use Retry in Instances. If the listener changed its capability, copy the current value and update the dialer.
- A timeout after the listener is ready points to dial direction, relay reachability or a saved address. A PortOS authentication error means the tunnel reached the remote API. A relay TLS error points to DERP connectivity or the host trust store.
- On installations using a custom DERP map, test reachability with the Tailcat process's Go networking environment as well as the browser or shell. Review the Instances diagnostics before replacing peer credentials.

Use `GET /api/instances/peers/tailcat/devices` to inspect the device list directly when the full Tailcat management snapshot is unnecessary.
