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

Then open the laptop's Tailscale URL, for example:

```text
http://100.124.147.99:5174
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
