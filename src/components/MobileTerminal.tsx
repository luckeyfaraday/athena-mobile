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

export function MobileTerminal({ streamUrl, sessionId, onInput }: Props) {
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
    const connect = () => {
      if (!streamUrl || source || exited) return;
      setState("connecting");
      source = new EventSource(streamUrl);
      // Each (re)connection begins with a snapshot of the current buffer; reset
      // first so an auto-reconnect re-syncs the screen instead of duplicating it.
      source.addEventListener("snapshot", (event) => {
        terminal.reset();
        const bytes = base64ToBytes((event as MessageEvent<string>).data);
        if (bytes.length) terminal.write(bytes);
        setState("live");
      });
      source.addEventListener("data", (event) => {
        terminal.write(base64ToBytes((event as MessageEvent<string>).data));
      });
      source.addEventListener("exit", (event) => {
        const exitCode = parseExitCode((event as MessageEvent<string>).data);
        terminal.writeln(`\r\n\x1b[33m[process exited: ${exitCode ?? "unknown"}]\x1b[0m`);
        exited = true;
        setState("exited");
        source?.close();
        source = null;
      });
      // EventSource auto-reconnects on transient errors; only flag the UI.
      source.addEventListener("error", () => {
        setState((current) => (current === "exited" ? current : "error"));
      });
    };
    const disconnect = () => {
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

function readTerminalTheme(): ITheme {
  const root = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--terminal", "#000000"),
    foreground: value("--text", "#f5f5f5"),
    cursor: value("--accent", "#fafafa"),
    selectionBackground: "rgba(250, 250, 250, 0.24)",
  };
}
