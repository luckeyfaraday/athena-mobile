import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type StreamState = "connecting" | "live" | "exited" | "error";

type Props = {
  /** Same-origin SSE URL from `client.terminalStreamUrl(id)`, or null. */
  streamUrl: string | null;
  /** Stable identity so the terminal is recreated when the session changes. */
  sessionId: string;
};

// The control server spawns PTYs at 96 columns; rendering at that width and
// scrolling horizontally preserves agent TUIs exactly (resizing the shared PTY
// would disrupt the desktop view, and there is no remote resize endpoint).
const TERMINAL_COLS = 96;
const FONT_SIZE = 11;
const LINE_HEIGHT = 1.2;

export function MobileTerminal({ streamUrl, sessionId }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<StreamState>("connecting");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const terminal = new Terminal({
      cols: TERMINAL_COLS,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      scrollback: 5000,
      convertEol: false,
      theme: readTerminalTheme(),
    });
    terminal.open(mount);

    const fitRows = () => {
      const cellHeight = FONT_SIZE * LINE_HEIGHT;
      const rows = Math.max(6, Math.floor(mount.clientHeight / cellHeight));
      if (rows !== terminal.rows) terminal.resize(TERMINAL_COLS, rows);
    };
    fitRows();
    const observer = new ResizeObserver(fitRows);
    observer.observe(mount);

    let source: EventSource | null = null;
    if (streamUrl) {
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
        setState("exited");
        source?.close();
      });
      // EventSource auto-reconnects on transient errors; only flag the UI.
      source.addEventListener("error", () => {
        setState((current) => (current === "exited" ? current : "error"));
      });
    } else {
      terminal.writeln("\x1b[90mLive stream unavailable in this mode.\x1b[0m");
      setState("error");
    }

    return () => {
      observer.disconnect();
      source?.close();
      terminal.dispose();
    };
  }, [sessionId, streamUrl]);

  return (
    <div className="mobileTerminal">
      <div className="mobileTerminalMount" ref={mountRef} />
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
