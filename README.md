# Athena Mobile

Mobile companion for Athena (`context-workspace`). It is a PWA, served from the
laptop and opened from the phone over Tailscale, that lets you:

- read a live agent's conversation (its native session transcript) and reply from a chat composer
- watch and type into Athena's live agent terminals (xterm.js over the control server's SSE stream)
- launch Codex, Claude, OpenCode, Athena Code, Grok, Hermes, or shell terminals in a workspace
- browse native session history, read transcripts, and resume a session in a new terminal
- get Web Push notifications when an agent is waiting on an answer, finishes a long turn, or crashes
- see how much of each Claude and Codex subscription window is used, per signed-in account
- switch to another computer running Athena on your tailnet and do all of the above there
- match desktop Athena's look, with the same 13 themes, or follow the laptop's theme

It talks to Athena only through Athena's existing HTTP APIs: the FastAPI backend
and the Electron control server, both localhost-only. It has no shared code with
`context-workspace`; `src/types.ts` mirrors the API shapes.

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

## Other machines

Desktop Athena can drive another computer's Athena over Tailscale (Settings →
System → Remote access, port 47821). The phone does the same through the
laptop: tap the machine name in the header to pick one. The laptop

- finds the other desktops with `tailscale status --json` and asks each one's
  Athena who it is (`GET /machine`), as desktop Athena's machine switcher does;
- forwards the phone's requests for the chosen machine to its control API
  (`/athena-remote/m/<tailscale node id>/…`), only ever to a machine Tailscale
  lists as a peer;
- adds that machine's access token when desktop Athena on the laptop has one
  saved (`remote-tokens.json` in its settings folder). Tokens never reach the
  phone.

A machine signed in to your Tailscale account needs no token while its "Trust
my own devices" setting is on. Any other machine needs its token pasted into
Athena on the laptop (Settings → System → Your machines) first.

On another machine you get its terminals (watch, type, stop), launches, and its
session history with resume. The conversation view needs that machine's Athena
to include remote chat (newer than 0.4.1); until then use the terminal view.
Past transcripts, Hermes status, and push alerts stay laptop-only for now.
Subscription usage always describes the laptop's accounts.

Overrides: `ATHENA_REMOTE_PORT` if the machines use a different remote port,
`ATHENA_USER_DATA` if desktop Athena's settings folder isn't the default
(`~/.config/context-workspace-client` on Linux).

## Notifications

The server watches every live terminal's output and alerts on timing, since an
agent's TUI writes output constantly while it works and goes silent when it
waits on you (`server/attention.mjs`):

- **Agent waiting**: quiet for 20 s with an approval dialog or picker on screen.
  Tapping it opens the Terminal view, where those prompts render.
- **Agent finished**: quiet for 60 s after at least 30 s of work. Tapping it
  opens the conversation. Repeat alerts for one terminal are held back for
  10 minutes, then sent if the agent is still waiting.
- **Agent exited**: the process exited with a non-zero code.

Answering within those windows (for example at the desk) sends no alert. Run
the timing tests with `npm test`.

## Subscription usage

The pill in the header shows the highest quota use across the Claude and Codex
accounts signed in on the laptop; a red dot means one of them needs attention
(an expired sign-in, for example). Tap it for the details sheet: the plan,
every quota window with its reset countdown, and a manual refresh, with a tab
per account. Settings lists every account with its bars.

The laptop's Athena backend owns the provider logins and a shared cache
(`GET /usage/accounts`, `POST /usage/refresh`, reached through
`/athena-backend`), so the phone never sees a token and never calls a provider.
Polling the cache is cheap: every 60 s, every 3 s while a refresh is running,
and paused while the app is in the background. A dashed chip with hatched bars
is a last-known value, not a live reading. That covers an expired sign-in, a
failed refresh, or a laptop that stopped answering. The pill stays hidden when
the running Athena build predates usage monitoring.

## Themes

`src/styles/tokens.css` and `src/styles/themes.css` are copies of desktop
Athena's design tokens and themes (`context-workspace` `client/src/styles/`);
re-copy them when the desktop's change, and keep `src/themes.ts` in sync (a
test checks the ids). The default, "Match laptop", follows the theme set in
desktop Athena on the laptop.

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
- `/athena-remote` lists other machines on the tailnet and forwards to their Athena (see "Other machines").
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
