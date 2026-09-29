import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Send, Wrench } from "lucide-react";
import type { AthenaClient } from "../api/athenaClient";
import { parseTranscript, type TranscriptMessage } from "../transcript";
import type { TranscriptRef } from "../types";

type Props = {
  client: AthenaClient;
  /** The live terminal's native session. */
  transcript: TranscriptRef;
  /** Submits a whole message to the agent; rejects if it wasn't delivered. */
  onSend: (text: string) => Promise<void>;
};

// The transcript is the agent's own session log, which grows per message, so a
// few seconds of lag is fine. Polling stops while the page is hidden.
const POLL_MS = 4000;
// Older messages longer than this start collapsed; the latest never is.
const COLLAPSE_CHARS = 900;
// How close to the bottom still counts as "following" new messages.
const STICKY_PX = 80;

export function ConversationView({ client, transcript, onSend }: Props) {
  const [messages, setMessages] = useState<TranscriptMessage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);
  const reloadRef = useRef<() => void>(() => {});
  const keys = useMemo(() => messageKeys(messages ?? []), [messages]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    let lastText: string | null = null;
    setMessages(null);
    setLoadError(null);
    followBottom.current = true;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      try {
        const text = await client.sessionTranscript(transcript);
        if (cancelled) return;
        if (text !== lastText) {
          lastText = text;
          setMessages(parseTranscript(text));
        }
        setLoadError(null);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        // A session's log file appears with its first message; until then the
        // backend answers 404, which just means there is nothing to show yet.
        if (message.startsWith("404")) setMessages((current) => current ?? []);
        else setLoadError(message);
      } finally {
        inFlight = false;
        if (!cancelled && document.visibilityState === "visible") timer = window.setTimeout(load, POLL_MS);
      }
    };
    reloadRef.current = () => void load();

    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
      else window.clearTimeout(timer);
    };
    void load();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `transcript` is a fresh object each render; its fields identify the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, transcript.provider, transcript.id]);

  // Keep the newest message in view unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && followBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const list = listRef.current;
    if (list) followBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICKY_PX;
  };

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft("");
      followBottom.current = true;
      // The agent logs the prompt as soon as it submits; pick it up promptly.
      window.setTimeout(() => reloadRef.current(), 1500);
    } catch {
      // The caller surfaced the error; keep the draft so it can be resent.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="conversation">
      <div className="conversationList" ref={listRef} onScroll={onScroll}>
        {messages === null ? (
          <p className="conversationStatus">{loadError ? `Couldn't load the conversation: ${loadError}` : "Loading conversation…"}</p>
        ) : messages.length === 0 ? (
          <p className="conversationStatus">No messages yet.</p>
        ) : (
          messages.map((message, index) => {
            const key = keys[index];
            if (message.role === "tool") {
              return (
                <div key={key} className="chatTool">
                  <Wrench size={12} /> {message.text}
                </div>
              );
            }
            const collapsible = index < messages.length - 1 && message.text.length > COLLAPSE_CHARS;
            const collapsed = collapsible && !expanded.has(key);
            return (
              <div key={key} className={`chatMessage ${message.role}`}>
                <div className={collapsed ? "chatText collapsed" : "chatText"}>{message.text}</div>
                {collapsible && (
                  <button type="button" className="chatMore" onClick={() => toggle(key)}>
                    {collapsed ? "Show more" : "Show less"}
                  </button>
                )}
              </div>
            );
          })
        )}
        {messages !== null && loadError && <p className="conversationStatus error">Couldn't refresh: {loadError}</p>}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds a line (as on a phone keyboard); Ctrl/Cmd+Enter sends.
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder="Message the agent. Approvals and menus are in Terminal."
          aria-label="Message"
        />
        <button type="submit" className="composerSend" disabled={sending || !draft.trim()} aria-label="Send">
          <Send size={17} />
        </button>
      </form>
    </div>
  );
}

// Keys from each message's role and opening text, so they stay stable while
// the latest reply grows or older messages scroll out of the transcript tail.
function messageKeys(messages: TranscriptMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base = `${message.role}:${message.text.slice(0, 64)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  });
}
