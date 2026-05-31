# Athena Mobile

Mobile companion scaffold for Athena. The app is designed as a PWA that can later talk to a laptop-side Athena mobile gateway over Tailscale.

This repository does not modify `context-workspace`. It reads the current Athena API shapes and keeps mobile access behind configurable clients.

## Run

```bash
npm install
npm run dev
```

Default local URL:

```text
http://127.0.0.1:5174
```

For a phone on the same Tailscale network, run:

```bash
npm run dev:tailscale
```

This binds the dev server to the laptop's Tailscale IP only (the `100.64.0.0/10`
address), so the app — and the loopback Athena control proxy behind it — stays
off any other LAN/Wi-Fi interface the laptop is joined to. It fails fast if
Tailscale is not up. Then open the laptop's Tailscale URL, for example:

```text
http://100.124.147.99:5174
```

To bind a different address, set `ATHENA_HOST` — an explicit IP, or `0.0.0.0` to
deliberately expose every interface:

```bash
ATHENA_HOST=0.0.0.0 npm run dev
```

## Configuration

Copy `.env.example` to `.env.local`.

```bash
VITE_ATHENA_MODE=live
VITE_ATHENA_BACKEND_URL=
VITE_ATHENA_CONTROL_URL=
VITE_ATHENA_PROJECT_DIR=
VITE_ATHENA_TOKEN=
```

Modes:

- `demo`: explicit local fixture mode for UI development.
- `live`: call the configured Athena backend and Electron control URLs.

Set `VITE_ATHENA_PROJECT_DIR` to the local Athena workspace path used for session history and new terminal launches before the app has discovered active workspaces.

In live mode, blank URLs use the same-origin Vite proxy. The proxy reads Athena's existing discovery files:

```text
~/.context-workspace/backend.json
~/.context-workspace/electron-control.json
```

This lets a phone reach the mobile app over Tailscale while the app server talks to Athena's localhost-only backend/control services.

## First release package

The first release is a private PWA hosted on the laptop and opened from the
phone over Tailscale. Build the static app, then run the production server:

```bash
npm run build
npm start
```

The production server listens on `127.0.0.1:4174` by default. It serves `dist/`
and mounts the same local endpoints used in development:

- `/athena-backend` proxies to Athena backend discovery from `~/.context-workspace/backend.json`.
- `/athena-control` proxies to Electron control discovery from `~/.context-workspace/electron-control.json`.
- `/athena-push` handles Web Push enrollment and notifications.

Expose it privately with Tailscale HTTPS:

```bash
tailscale serve --bg https / http://127.0.0.1:4174
```

Then open the Tailscale HTTPS URL on the phone and add Athena Mobile to the home
screen. HTTPS is required for Web Push.

Useful production overrides:

```bash
PORT=4174 npm start
ATHENA_HOST=tailscale npm start
ATHENA_BACKEND_TARGET=http://127.0.0.1:8000 npm start
ATHENA_CONTROL_TARGET=http://127.0.0.1:9000 npm start
```
