import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";

type StreamState = "connecting" | "live" | "exited" | "error";

type Props = {
  /** Same-origin SSE URL from `client.terminalStreamUrl(id)`, or null. */
  streamUrl: string | null;
  /** Stable identity so the terminal is recreated when the session changes. */
  sessionId: string;
  /** Raw keystroke bytes from xterm (Enter, arrows, control codes), sent to the PTY verbatim. */
  onInput: (data: string) => void;
  /** The painted theme; a change recolors the open terminal. */
  theme: string;
};

// The control server spawns PTYs at 96 columns and the agent TUIs (Claude Code,
// Codex) draw their frames with absolute cursor positioning at that width — so
// any narrower grid corrupts the layout, and there is no remote resize endpoint.
// We therefore render the real 96 columns and scroll horizontally, at a readable
// font, with the canvas renderer keeping every glyph crisply aligned.
const TERMINAL_COLS = 96;
const FONT_SIZE = 11;
const LINE_HEIGHT = 1.2;
const MONO_FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
// Backoff for reopening a stream the browser gave up on.
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export function MobileTerminal({ streamUrl, sessionId, onInput, theme }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Hold the latest onInput so the data handler isn't baked into the mount effect
  // (which would otherwise tear down and recreate the terminal on every render).
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const terminal = new Terminal({
      cols: TERMINAL_COLS,
      cursorBlink: true,
      // stdin enabled: keystrokes flow out via onData and are written to the PTY.
      // xterm does not echo locally — the PTY echoes back through the SSE stream.
      disableStdin: false,
      fontFamily: MONO_FONT,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      scrollback: 5000,
      convertEol: false,
      theme: readTerminalTheme(),
    });
    terminal.open(mount);
    // Canvas renderer: the DOM renderer accumulates sub-pixel rounding error
    // across the 96 narrow cells, dropping/overlapping glyphs (the misaligned,
    // run-together text). The canvas renderer paints each cell at an exact
    // integer offset instead. Load after open().
    try {
      terminal.loadAddon(new CanvasAddon());
    } catch {
      // Canvas context unavailable (rare on mobile) — fall back to the DOM renderer.
    }
    terminalRef.current = terminal;
    const dataSub = terminal.onData((data) => onInputRef.current(data));

    // Keep 96 columns fixed (so TUIs render correctly) and only grow the row
    // count to fill the available height; re-run on layout changes.
    const fitRows = () => {
      const cellHeight = FONT_SIZE * LINE_HEIGHT;
      const rows = Math.max(6, Math.floor(mount.clientHeight / cellHeight));
      if (rows !== terminal.rows) terminal.resize(TERMINAL_COLS, rows);
    };
    fitRows();
    const observer = new ResizeObserver(fitRows);
    observer.observe(mount);

    // Full-screen TUIs (Claude Code) enable mouse reporting, so xterm consumes
    // touch drags (preventDefault) and the container never scrolls — unlike
    // shell/Codex. We drive the horizontal pan ourselves in the capture phase:
    // a mostly-horizontal swipe scrolls the 96-column view and is withheld from
    // xterm; taps (focus) and vertical drags (scrollback) still reach it.
    let startX = 0;
    let startY = 0;
    let startScroll = 0;
    let panning = false;
    let decided = false;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      startScroll = mount.scrollLeft;
      panning = false;
      decided = false;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
          panning = true;
          decided = true;
        } else if (Math.abs(dy) > 8) {
          decided = true; // vertical intent — hand it to xterm
        }
      }
      if (panning) {
        mount.scrollLeft = startScroll - dx;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    mount.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    mount.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });

    // The live SSE keeps an HTTP connection open, which disqualifies the page from
    // the browser's back/forward cache — so a backgrounded PWA is torn down and
    // must fully reload on return. We close the stream while the tab is hidden (so
    // the page can be frozen/restored instead) and reopen it on return. Each
    // reconnect replays a buffer snapshot, so the screen resyncs cleanly.
    let source: EventSource | null = null;
    let exited = false;
    let retryTimer: number | undefined;
    let retryDelay = RETRY_MIN_MS;
    const connect = () => {
      if (!streamUrl || source || exited) return;
      setState("connecting");
      const current = new EventSource(streamUrl);
      source = current;
      // Each (re)connection begins with a snapshot of the current buffer; reset
      // first so an auto-reconnect re-syncs the screen instead of duplicating it.
      current.addEventListener("snapshot", (event) => {
        terminal.reset();
        const bytes = base64ToBytes((event as MessageEvent<string>).data);
        if (bytes.length) terminal.write(bytes);
        retryDelay = RETRY_MIN_MS;
        setState("live");
      });
      current.addEventListener("data", (event) => {
        terminal.write(base64ToBytes((event as MessageEvent<string>).data));
      });
      current.addEventListener("exit", (event) => {
        const exitCode = parseExitCode((event as MessageEvent<string>).data);
        terminal.writeln(`\r\n\x1b[33m[process exited: ${exitCode ?? "unknown"}]\x1b[0m`);
        exited = true;
        setState("exited");
        source?.close();
        source = null;
      });
      // EventSource reconnects by itself after a dropped connection, but an
      // error answer (another machine still unreachable, say) closes it for
      // good. Reopen that one ourselves, backing off while it keeps failing.
      current.addEventListener("error", () => {
        setState((state) => (state === "exited" ? state : "error"));
        if (current.readyState !== EventSource.CLOSED || source !== current) return;
        source = null;
        if (exited || document.visibilityState !== "visible") return;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      });
    };
    const disconnect = () => {
      window.clearTimeout(retryTimer);
      source?.close();
      source = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") connect();
      else disconnect();
    };

    if (streamUrl) {
      if (document.visibilityState === "visible") connect();
      document.addEventListener("visibilitychange", onVisibility);
    } else {
      terminal.writeln("\x1b[90mLive stream unavailable in this mode.\x1b[0m");
      setState("error");
    }

    return () => {
      dataSub.dispose();
      observer.disconnect();
      mount.removeEventListener("touchstart", onTouchStart, { capture: true });
      mount.removeEventListener("touchmove", onTouchMove, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, streamUrl]);

  // Tapping the terminal focuses xterm's hidden textarea, which raises the mobile
  // soft keyboard so typed characters reach the PTY.
  const focusTerminal = () => terminalRef.current?.focus();


  // App repaints the document in a layout effect, so the new tokens are in place here.
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = readTerminalTheme();
  }, [theme]);

  return (
    <div className="mobileTerminal">
      <div className="mobileTerminalMount" ref={mountRef} onClick={focusTerminal} />
      <span className={`mobileTerminalState ${state}`}>{stateLabel(state)}</span>
    </div>
  );
}

function stateLabel(state: StreamState): string {
  if (state === "live") return "Live";
  if (state === "connecting") return "Connecting…";
  if (state === "exited") return "Exited";
  return "Reconnecting…";
}

function parseExitCode(payloadBase64: string): number | null {
  try {
    const json = new TextDecoder().decode(base64ToBytes(payloadBase64));
    const parsed = JSON.parse(json) as { exitCode?: number | null };
    return typeof parsed.exitCode === "number" ? parsed.exitCode : null;
  } catch {
    return null;
  }
}

// Stream chunks are base64-encoded raw PTY bytes. Decode to a Uint8Array and let
// xterm handle UTF-8 (including multibyte sequences split across chunks).
function base64ToBytes(payloadBase64: string): Uint8Array {
  const binary = atob(payloadBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// The theme's terminal tokens, the same ones desktop Athena gives its xterm.
function readTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  const ansi = (name: string) => root.getPropertyValue(`--ansi-${name}`).trim() || undefined;
  return {
    background: value("--terminal", "#000000"),
    foreground: value("--text", "#f5f5f5"),
    cursor: value("--accent", "#fafafa"),
    cursorAccent: value("--terminal", "#000000"),
    selectionBackground: root.colorScheme === "light" ? "rgba(0, 0, 0, 0.18)" : "rgba(250, 250, 250, 0.24)",
    black: ansi("black"),
    red: ansi("red"),
    green: ansi("green"),
    yellow: ansi("yellow"),
    blue: ansi("blue"),
    magenta: ansi("magenta"),
    cyan: ansi("cyan"),
    white: ansi("white"),
    brightBlack: ansi("bright-black"),
    brightRed: ansi("bright-red"),
    brightGreen: ansi("bright-green"),
    brightYellow: ansi("bright-yellow"),
    brightBlue: ansi("bright-blue"),
    brightMagenta: ansi("bright-magenta"),
    brightCyan: ansi("bright-cyan"),
    brightWhite: ansi("bright-white"),
  };
}
