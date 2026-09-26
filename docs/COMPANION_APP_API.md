# Companion-App API Contract

The stable HTTP contract a native companion client (working name **PortDeck**;
repo `atomantic/PortDeck`) consumes to discover, authenticate to, and drive one
or more PortOS instances across a Tailscale tailnet.

> **Scope.** This documents the **PortOS-side** contract only. The iOS app itself
> (Swift/SwiftUI, Keychain, iCloud store, UI) lives in its own repository per the
> Scope Boundary rule in `AGENTS.md` — its code, plan, and docs never land in this
> repo. Everything below already exists in PortOS today unless explicitly marked.

## Deployment shape the app targets

A single user commonly runs **several PortOS installs federated as sync peers**
over Tailscale. Each install:

- Serves its API on **`:5555`** at the tailnet host (MagicDNS name or Tailscale IP).
- Speaks **HTTP or HTTPS** depending on whether a TLS cert is provisioned
  (`npm run setup:cert`). When HTTPS is on, `:5555` is TLS-only and a loopback HTTP
  mirror runs on `127.0.0.1:5553` (not reachable over the tailnet). See
  [PORTS.md](./PORTS.md).
- Has an **optional single password** gate. When off, the tailnet-private trust
  model means the app needs no credential; when on, every `/api/*` request needs
  credentials (see [Authentication](#authentication)).

The app therefore treats each instance as `{ scheme, host, port: 5555, password? }`
and must handle both the auth-on/auth-off and HTTP/HTTPS cases per instance.

## 1. Discovery & identity (pre-auth)

`GET /api/system/health` — **public**, bypasses the auth gate even when the
password is on (`PUBLIC_API_PATHS` in `server/services/authGate.js`), and is the same
endpoint Tailscale reachability checks hit. Use it to confirm a tailnet host is a
PortOS instance and to label it on a connection screen **before** the app holds
any credential.

**Response:**