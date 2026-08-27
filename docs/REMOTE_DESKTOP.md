# PortDeck remote desktop

PortDeck can view and control a PortOS machine through a VNC server running on that same machine. PortOS brokers the RFB connection through the instance's existing HTTP(S) endpoint, so the iOS app does not need direct access to a separate VNC address.

## Security model

- Remote desktop sessions require PortOS instance authentication to be enabled. PortDeck uses the instance password already stored in its Keychain to request a short-lived, single-purpose viewer URL.
- The broker connects only to `127.0.0.1`. A request cannot choose another VNC host or turn PortOS into a general TCP proxy.
- The VNC password is entered in the viewer, is passed to the local VNC server through the RFB connection, and is not stored by PortDeck or PortOS.
- The viewer token expires after five minutes if unused. Once activated, it supports reconnects until a fixed eight-hour deadline and allows only one connection at a time.
- Prefer a Tailscale HTTPS endpoint. Tailscale still encrypts traffic when PortOS uses HTTP, but HTTPS also protects the browser-to-PortOS hop at the application layer.

VNC grants control of the currently logged-in desktop. Use a unique VNC password that is different from both the macOS login password and the PortOS instance password. Apply Tailscale ACLs and the host firewall as appropriate; enabling a platform VNC server may make its own port available on additional interfaces independently of the PortOS loopback broker.

## One-time host setup

Run this on each PortOS machine:

```bash
npm run setup:remote-desktop
```

On macOS, the helper opens **System Settings → General → Sharing**. Enable **Remote Management**, open its Info panel, and enable **VNC viewers may control screen with password**. Modern macOS requires this user-approved System Settings action for full control; PortOS does not install a privileged launch daemon or try to bypass it.

On Linux or Windows, install a VNC server and bind it to loopback port 5900. To use another local port, set `PORTOS_VNC_PORT` for the PortOS server process and restart PortOS.

Re-run the setup command to verify that the VNC server is reachable on loopback. In PortDeck, open the instance, choose **Remote Desktop**, and enter the separate VNC password.
