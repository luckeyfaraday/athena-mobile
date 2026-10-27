import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AudioLines,
  Bot,
  CircleArrowUp,
  KeyRound,
  Loader2,
  Megaphone,
  Mic,
  MicOff,
  Power,
  RefreshCw,
  SearchX,
  Send,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { AppConfig } from "../config";
import {
  JarvisRequestError,
  askJarvis,
  discoverJarvis,
  fetchJarvis,
  fetchJarvisAudio,
  jarvisEventsUrl,
  launchJarvis,
  setJarvisMic,
  type JarvisSearch,
} from "../api/jarvisClient";
import {
  ReplyAudioQueue,
  audioForAsk,
  findingSummary,
  isGoodFinding,
  jarvisChat,
  jarvisStatus,
  jarvisStatusLabel,
  lastFeedId,
  locationName,
  newerState,
  openAsks,
  parseJarvisAudioEvent,
  parseJarvisState,
  type JarvisAudioEvent,
  type JarvisChatItem,
  type JarvisLocation,
  type JarvisState,
  type PendingAsk,
} from "../jarvis";

// Jarvis, the user's voice assistant on one of their computers, from anywhere:
// its live state (an event stream, or polling when that fails), the
// conversation as chat, and a composer that types to it or, through the
// phone's own speech recognition, talks to it. Jarvis answers what's asked
// here in its own voice, on the phone. Everything stops while the screen is
// closed or the app is in the background.

const POLL_MS = 2_000;
// While polling covers for a failed stream, the stream is retried this often (doubling).
const STREAM_RETRY_MIN_MS = 5_000;
const STREAM_RETRY_MAX_MS = 60_000;
// Failed polls in a row before looking for Jarvis somewhere else.
const FAILURES_BEFORE_SEARCH = 3;
// How close to the bottom still counts as "following" new messages.
const STICKY_PX = 80;
// A press on the talk button held this long is hold-to-talk (release sends);
// a shorter tap listens until the user pauses.
const HOLD_MS = 350;
// An ask Jarvis never echoed stops showing as pending after this long.
const PENDING_MAX_MS = 60_000;
// After "Open Jarvis", how long to show it opening before giving up.
const OPENING_MAX_MS = 45_000;
// With no Jarvis found, look again this often while the screen is open.
const MISSING_RECHECK_MS = 30_000;

const STORAGE_KEYS = {
  location: "athena.jarvisLocation",
  state: "athena.jarvisState",
  // Only an explicit choice is stored; the first release stored its "off"
  // default on mount, so it moved to a new key with "on" as the default. It
  // was "read replies aloud" and is now Jarvis's own voice, same choice.
  voice: "athena.jarvisSpeakReplies",
} as const;

export function JarvisView({ config }: { config: AppConfig }) {
  // The stream's jarvis-audio events go to the voice hook, made below.
  const hearAudio = useRef<(event: JarvisAudioEvent) => void>(() => undefined);
  const link = useJarvisLink(config, hearAudio);
  const { location, state, live } = link;
  const name = location ? locationName(location, state) : null;
  const status = jarvisStatus(state, live);
  const voice = useJarvisVoice(config, location);
  hearAudio.current = voice.hear;

  const [pending, setPending] = useState<PendingAsk[]>([]);
  const [sending, setSending] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // What the phone's speech recognition has heard so far, while it listens.
  const [heard, setHeard] = useState<string | null>(null);
  const draftBeforeTalk = useRef("");
  const press = useRef<number | null>(null);

  // Another Jarvis has its own feed (and feed ids).
  useEffect(() => {
    setPending([]);
    setActionError(null);
    setOpening(false);
  }, [location?.base]);

  // Drop pending asks once Jarvis echoes them into the feed.
  useEffect(() => {
    if (!state) return;
    setPending((current) => {
      const open = openAsks(state.feed, current).filter((ask) => Date.now() - ask.sentAt < PENDING_MAX_MS);
      return open.length === current.length ? current : open;
    });
    if (state.running) setOpening(false);
  }, [state]);

  useEffect(() => {
    if (!opening) return;
    const timer = window.setTimeout(() => setOpening(false), OPENING_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [opening]);

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !location) return;
    // One request at a time; spoken words wait in the field instead of being lost.
    if (sending) return setDraft(trimmed);
    setSending(true);
    setActionError(null);
    const ask: PendingAsk = { text: trimmed, afterId: lastFeedId(state?.feed ?? []), sentAt: Date.now() };
    setPending((current) => [...current, ask]);
    voice.arm();
    setDraft("");
    try {
      const asked = await askJarvis(config, location, trimmed);
      link.receive(asked.state);
      voice.answered(asked.turn);
    } catch (error) {
      setPending((current) => current.filter((entry) => entry !== ask));
      voice.disarm();
      // Keep the words so they can be sent again.
      setDraft((current) => current || trimmed);
      if (error instanceof JarvisRequestError && error.state) link.receive(error.state);
      setActionError(messageOf(error));
    } finally {
      setSending(false);
    }
  };

  const talk = useTalk({
    onHeard: setHeard,
    onDone: (text) => {
      setHeard(null);
      const spoken = joinDraft(draftBeforeTalk.current, text);
      if (text.trim()) void submit(spoken);
      else setDraft(draftBeforeTalk.current);
    },
    onError: setActionError,
  });

  const beginTalk = () => {
    draftBeforeTalk.current = draft;
    setHeard("");
    setActionError(null);
    // The phone shouldn't hear Jarvis's last reply while it listens.
    voice.silence();
    // The spoken request is sent after this tap ends, too late for iOS to
    // allow audio; unlocking now lets Jarvis's reply play.
    voice.prime();
    talk.start();
  };

  const toggleMic = async () => {
    if (!location || !state || state.micOpen === null) return;
    setMicBusy(true);
    setActionError(null);
    try {
      link.receive(await setJarvisMic(config, location, state.micOpen ? "off" : "on"));
    } catch (error) {
      if (error instanceof JarvisRequestError && error.state) link.receive(error.state);
      setActionError(messageOf(error));
    } finally {
      setMicBusy(false);
    }
  };

  const launch = async () => {
    if (!location) return;
    setOpening(true);
    setActionError(null);
    try {
      link.receive(await launchJarvis(config, location));
    } catch (error) {
      setOpening(false);
      if (error instanceof JarvisRequestError && error.state) link.receive(error.state);
      setActionError(messageOf(error));
    }
  };

  if (!location || !state || !name) {
    return (
      <section className="jarvisView">
        {/* The spinner is for the first search; later ones keep showing what was found. */}
        {link.searching && !link.search ? (
          <div className="emptyState">
            <Loader2 size={28} className="spinning" />
            <strong>Looking for Jarvis…</strong>
            <span>Asking Athena here and on your other machines.</span>
          </div>
        ) : (
          <JarvisMissing search={link.search} searching={link.searching} onSearch={link.searchAgain} />
        )}
      </section>
    );
  }

  const banner = link.lost ? `Lost touch with Jarvis on ${name} (${link.lost}). Looking again…` : actionError;
  const fieldValue = heard !== null ? joinDraft(draftBeforeTalk.current, heard) : draft;

  let body: ReactNode;
  if (!state.license.licensed) {
    body = (
      <div className="emptyState">
        <KeyRound size={28} />
        <strong>Jarvis is for Jarvis license holders</strong>
        <span>
          Athena on {name} has no active Jarvis license{state.license.detail ? ` (${state.license.detail})` : ""}. Activate Jarvis on
          that computer, then look again.
        </span>
        <button className="ghostButton" type="button" onClick={link.searchAgain} disabled={link.searching}>
          <RefreshCw size={14} className={link.searching ? "spinning" : undefined} /> Look again
        </button>
      </div>
    );
  } else if (!state.running) {
    body = (
      <div className="emptyState">
        <Power size={28} />
        <strong>Jarvis isn't running on {name}</strong>
        <span>
          {state.installPath
            ? "Open it there to talk to Jarvis from your phone."
            : `Athena on ${name} can't find the Jarvis app there. Install or open Jarvis on that computer.`}
        </span>
        {state.lastError && <span className="jarvisError">{state.lastError}</span>}
        {state.installPath && (
          <button className="primaryButton" type="button" onClick={() => void launch()} disabled={opening}>
            {opening ? <Loader2 size={16} className="spinning" /> : <Power size={16} />}
            {opening ? "Opening Jarvis…" : `Open Jarvis on ${name}`}
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <JarvisConversation
        items={jarvisChat(state.feed, pending)}
        thinking={status === "thinking"}
        partial={state.partial}
        placeholder={talk.listening ? "Listening…" : `Ask Jarvis on ${name}`}
        value={fieldValue}
        listening={talk.listening}
        sending={sending}
        canTalk={talk.supported}
        onChange={setDraft}
        onSend={() => void submit(draft)}
        onTalkDown={(event) => {
          if (event.button !== 0) return;
          // No focus change, text selection, or long-press menu on the button.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          if (talk.listening) {
            press.current = null;
            talk.stop();
            return;
          }
          press.current = Date.now();
          beginTalk();
        }}
        onTalkUp={() => {
          const pressedAt = press.current;
          press.current = null;
          if (pressedAt !== null && Date.now() - pressedAt >= HOLD_MS) talk.stop();
        }}
        onTalkCancel={() => {
          if (press.current === null) return;
          press.current = null;
          talk.stop();
        }}
        onTalkKey={() => (talk.listening ? talk.stop() : beginTalk())}
      />
    );
  }

  return (
    <section className="jarvisView">
      <header className="jarvisHead">
        <span className={`jarvisOrb ${status}`} aria-hidden="true" />
        <div className="jarvisHeadText">
          <strong>
            Jarvis <span className={`jarvisStatus ${status}`}>{jarvisStatusLabel(status)}</span>
          </strong>
          <small>{[`on ${name}`, state.model ?? state.provider].filter(Boolean).join(" · ")}</small>
        </div>
        <div className="jarvisHeadActions">
          {voice.supported && (
            <button
              type="button"
              className={voice.enabled ? "iconButton jarvisToggle active" : "iconButton jarvisToggle"}
              aria-pressed={voice.enabled}
              aria-label="Play Jarvis's voice on this phone"
              title="Play Jarvis's voice on this phone"
              onClick={voice.toggle}
            >
              {voice.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
          )}
          <button
            type="button"
            className={state.micOpen ? "jarvisMic on" : "jarvisMic"}
            aria-pressed={state.micOpen === true}
            aria-label={`Microphone on ${name}`}
            title={`Microphone on ${name}`}
            disabled={micBusy || state.micOpen === null || !state.running}
            onClick={() => void toggleMic()}
          >
            {state.micOpen ? <Mic size={14} /> : <MicOff size={14} />} PC mic
          </button>
        </div>
      </header>
      {banner && <div className="errorBanner">{banner}</div>}
      {body}
    </section>
  );
}

function JarvisConversation({
  items,
  thinking,
  partial,
  placeholder,
  value,
  listening,
  sending,
  canTalk,
  onChange,
  onSend,
  onTalkDown,
  onTalkUp,
  onTalkCancel,
  onTalkKey,
}: {
  items: JarvisChatItem[];
  thinking: boolean;
  /** What Jarvis's computer is hearing right now. */
  partial: string | null;
  placeholder: string;
  value: string;
  listening: boolean;
  sending: boolean;
  /** The phone has speech recognition (and a secure context to use it). */
  canTalk: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onTalkDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTalkUp: () => void;
  onTalkCancel: () => void;
  onTalkKey: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const followBottom = useRef(true);

  // Keep the newest message in view unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && followBottom.current) list.scrollTop = list.scrollHeight;
  }, [items, thinking]);

  const onScroll = () => {
    const list = listRef.current;
    if (list) followBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICKY_PX;
  };

  const send = () => {
    followBottom.current = true;
    onSend();
  };

  return (
    <div className="conversation jarvisConversation">
      <div className="conversationList" ref={listRef} onScroll={onScroll}>
        {items.length === 0 ? (
          <p className="conversationStatus">Nothing said yet. Ask Jarvis anything from here.</p>
        ) : (
          items.map((item) => (
            <Fragment key={item.key}>
              {item.showTime && <p className="jarvisTime">{formatClock(item.at)}</p>}
              <ChatRow item={item} />
            </Fragment>
          ))
        )}
        {thinking && (
          <div className="chatMessage assistant jarvisTyping" role="status" aria-label="Jarvis is thinking">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      {partial && (
        <p className="jarvisPartial" aria-live="polite">
          <AudioLines size={14} aria-hidden="true" />
          <span>{partial}</span>
        </p>
      )}

      <form
        className="composer jarvisComposer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          value={value}
          readOnly={listening}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Requests are one line, like speech: Enter (the keyboard's send key) sends; Shift+Enter adds a line.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
          rows={1}
          enterKeyHint="send"
          placeholder={placeholder}
          aria-label="Message to Jarvis"
        />
        {canTalk && (
          <button
            type="button"
            className={listening ? "jarvisTalk listening" : "jarvisTalk"}
            aria-pressed={listening}
            aria-label={listening ? "Stop listening" : "Talk to Jarvis (hold, or tap)"}
            onPointerDown={onTalkDown}
            onPointerUp={onTalkUp}
            onPointerCancel={onTalkCancel}
            // Touch and mouse use the pointer handlers; a keyboard's Enter or Space arrives as a click with no detail.
            onClick={(event) => {
              if (event.detail === 0) onTalkKey();
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <Mic size={17} />
          </button>
        )}
        <button type="submit" className="composerSend" disabled={sending || listening || !value.trim()} aria-label="Send">
          <Send size={17} />
        </button>
      </form>
    </div>
  );
}

function ChatRow({ item }: { item: JarvisChatItem }) {
  if (item.role === "system") {
    return (
      <div className={`jarvisEvent ${item.kind}`}>
        {item.kind === "announce" ? <Megaphone size={12} aria-hidden="true" /> : <Bot size={12} aria-hidden="true" />}
        <span>
          {item.agent && <strong>{item.agent} </strong>}
          {item.text}
        </span>
      </div>
    );
  }
  const className = item.role === "user" ? (item.pending ? "chatMessage user pending" : "chatMessage user") : "chatMessage assistant";
  return (
    <div className={className}>
      <div className="chatText">{item.text}</div>
    </div>
  );
}

/** Nothing usable was found: say what each place answered, in plain words. */
function JarvisMissing({ search, searching, onSearch }: { search: JarvisSearch | null; searching: boolean; onSearch: () => void }) {
  const findings = search?.findings ?? [];
  const tooOld = findings.filter((finding) => finding.status === "too-old");
  const updateOnly = tooOld.length > 0 && !findings.some((finding) => finding.status === "absent");
  const names = (list: typeof findings) => list.map((finding) => locationName(finding.location, finding.state)).join(", ");
  return (
    <div className="emptyState">
      {updateOnly ? <CircleArrowUp size={28} /> : <SearchX size={28} />}
      <strong>{updateOnly ? (tooOld.length === 1 ? `Update Athena on ${names(tooOld)}` : "Update Athena to use Jarvis") : "No Jarvis found"}</strong>
      <span>
        {updateOnly
          ? "Athena there can't reach Jarvis from the phone yet. Update it, then look again."
          : "Jarvis runs on a computer with Athena. Here's what each one said:"}
      </span>
      {findings.length > 0 && (
        <ul className="jarvisFindings">
          {findings.map((finding) => (
            <li key={finding.location.base}>
              <strong>{locationName(finding.location, finding.state)}</strong>
              <small>{findingSummary(finding)}</small>
            </li>
          ))}
        </ul>
      )}
      {search?.notes.map((note) => (
        <span key={note} className="jarvisError">
          {note}
        </span>
      ))}
      <button className="ghostButton" type="button" onClick={onSearch} disabled={searching}>
        <RefreshCw size={14} className={searching ? "spinning" : undefined} /> Look again
      </button>
    </div>
  );
}

// ── Finding Jarvis and following it ─────────────────────────────────────────

/**
 * Where Jarvis is and its newest state. The last place it answered (and what
 * it showed) is remembered, so reopening paints at once and asks there first.
 * Live updates run only while this screen is open and the app is in front.
 */
function useJarvisLink(config: AppConfig, onAudio: { current: (event: JarvisAudioEvent) => void }) {
  const saved = useMemo(loadSaved, []);
  const [location, setLocation] = useState<JarvisLocation | null>(saved.location);
  const [state, setState] = useState<JarvisState | null>(saved.state);
  // The state came from Jarvis just now, not from storage or a connection that dropped.
  const [live, setLive] = useState(false);
  const [search, setSearch] = useState<JarvisSearch | null>(null);
  const [searching, setSearching] = useState(true);
  const [searches, setSearches] = useState(0);
  // Bumped when a search confirms where Jarvis is, to (re)start following it.
  const [epoch, setEpoch] = useState(0);
  // Why the last place stopped answering, while looking again.
  const [lost, setLost] = useState<string | null>(null);

  const searchAgain = useCallback(() => setSearches((count) => count + 1), []);
  const receive = useCallback((next: JarvisState) => setState((current) => newerState(current, next)), []);

  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    void discoverJarvis(config, loadPersisted<JarvisLocation | null>(STORAGE_KEYS.location, null)).then((result) => {
      if (cancelled) return;
      setSearch(result);
      setSearching(false);
      setLost(null);
      const best = result.best;
      if (!best?.state) {
        setLocation(null);
        setState(null);
        return;
      }
      if (isGoodFinding(best)) persist(STORAGE_KEYS.location, best.location);
      const found = best.state;
      setLocation((current) => (current?.base === best.location.base && current.name === best.location.name ? current : best.location));
      setState((current) => (location?.base === best.location.base ? newerState(current, found) : found));
      setLive(true);
      setEpoch((count) => count + 1);
    });
    return () => {
      cancelled = true;
    };
    // `location` is read only to tell a refresh of the same Jarvis from a move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, searches]);

  // Nothing found: look again now and then, and when the app comes back to the foreground.
  useEffect(() => {
    if (searching || location) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") searchAgain();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") searchAgain();
    }, MISSING_RECHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [searching, location, searchAgain]);

  useEffect(() => {
    if (location && state) persist(STORAGE_KEYS.state, { base: location.base, state });
  }, [location, state]);

  // The event stream while the app is in front; polling while it fails.
  useEffect(() => {
    if (!location || epoch === 0) return;
    let stopped = false;
    let source: EventSource | null = null;
    let streaming = false;
    let polling = false;
    let pollTimer: number | undefined;
    let retryTimer: number | undefined;
    let retryDelay = STREAM_RETRY_MIN_MS;
    let failures = 0;

    const apply = (next: JarvisState) => {
      failures = 0;
      receive(next);
      setLive(true);
    };
    const halt = () => {
      window.clearTimeout(pollTimer);
      window.clearTimeout(retryTimer);
      pollTimer = retryTimer = undefined;
      source?.close();
      source = null;
      streaming = false;
    };
    const poll = async () => {
      if (polling) return;
      polling = true;
      window.clearTimeout(pollTimer);
      try {
        const next = await fetchJarvis(config, location);
        if (!stopped) apply(next);
      } catch (error) {
        if (stopped) return;
        failures += 1;
        setLive(false);
        // That Athena went away or stopped serving Jarvis: look for it again.
        if (failures >= FAILURES_BEFORE_SEARCH || (error instanceof JarvisRequestError && error.status === 404)) {
          stopped = true;
          halt();
          setLost(messageOf(error));
          searchAgain();
          return;
        }
      } finally {
        polling = false;
      }
      if (!stopped && !streaming && document.visibilityState === "visible") pollTimer = window.setTimeout(() => void poll(), POLL_MS);
    };
    const connect = () => {
      if (stopped || source) return;
      const current = new EventSource(jarvisEventsUrl(location));
      source = current;
      current.addEventListener("jarvis", (event) => {
        const next = parseJarvisState(parseJson((event as MessageEvent<string>).data));
        if (!next || source !== current) return;
        streaming = true;
        retryDelay = STREAM_RETRY_MIN_MS;
        window.clearTimeout(pollTimer);
        apply(next);
      });
      // A sentence of a reply in Jarvis's own voice, for the phone to fetch and play.
      current.addEventListener("jarvis-audio", (event) => {
        const audio = parseJarvisAudioEvent(parseJson((event as MessageEvent<string>).data));
        if (audio && source === current) onAudio.current(audio);
      });
      // A dropped or refused stream: poll instead, and try the stream again later.
      current.addEventListener("error", () => {
        if (source !== current) return;
        current.close();
        source = null;
        streaming = false;
        if (stopped || document.visibilityState !== "visible") return;
        void poll();
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, STREAM_RETRY_MAX_MS);
      });
    };
    // Closing the stream in the background keeps the page bfcache-eligible, as MobileTerminal does.
    const onVisibility = () => {
      if (document.visibilityState === "visible") connect();
      else {
        halt();
        setLive(false);
      }
    };
    if (document.visibilityState === "visible") connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      halt();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [config, location, epoch, receive, searchAgain]);

  return { location, state, live, search, searching, lost, searchAgain, receive };
}

// ── Jarvis's voice on the phone ─────────────────────────────────────────────

/** The reply to the phone's latest ask, while its sentences arrive. */
type PhoneReply = {
  /** Its turn: undefined until the ask answers, null when it names none. */
  turn: string | null | undefined;
  queue: ReplyAudioQueue<AudioBuffer>;
  /** Audio announced before the ask answered, held until it does. */
  early: JarvisAudioEvent[];
};

const EARLY_AUDIO_MAX = 64;

/**
 * Plays Jarvis's own voice for its replies to what was asked from this phone:
 * Jarvis keeps its computer quiet for them and sends each sentence as audio,
 * fetched as it's announced and played straight after the one before. A reply
 * without audio (a text-only Jarvis, an Athena without the audio route, no
 * event stream) shows as text only; the phone has no voice of its own.
 */
function useJarvisVoice(config: AppConfig, location: JarvisLocation | null) {
  const player = useMemo(() => new VoicePlayer(), []);
  // On by default: asking from the phone means listening on it, as the computer stays quiet.
  const [enabled, setEnabled] = useState(() => player.supported && loadPersisted<boolean>(STORAGE_KEYS.voice, true) !== false);
  const reply = useRef<PhoneReply | null>(null);
  const latest = useRef({ config, location, enabled });
  latest.current = { config, location, enabled };

  // Hand out what can play, unless a newer ask (or talking) replaced the reply.
  const play = useCallback(
    (voicing: PhoneReply, buffers: AudioBuffer[]) => {
      if (reply.current !== voicing) return;
      for (const buffer of buffers) player.play(buffer);
    },
    [player],
  );

  const voice = useCallback(
    (voicing: PhoneReply, event: JarvisAudioEvent) => {
      const { config, location, enabled } = latest.current;
      if (!location || !enabled) return;
      if (event.final && event.interrupted) {
        // Jarvis was cut off: so is the phone.
        player.stop();
        reply.current = null;
        return;
      }
      if (event.final) return play(voicing, voicing.queue.finish(event.seq));
      if (!voicing.queue.announce(event.seq)) return;
      void fetchJarvisAudio(config, location, event.turn, event.seq)
        .then((bytes) => player.decode(bytes))
        .then(
          (buffer) => play(voicing, voicing.queue.settle(event.seq, buffer)),
          // Gone or undecodable: that sentence is skipped, the rest still play.
          () => play(voicing, voicing.queue.settle(event.seq, null)),
        );
    },
    [play, player],
  );

  useEffect(() => {
    reply.current = null;
    player.stop();
  }, [location?.base, player]);
  useEffect(() => () => player.close(), [player]);

  return {
    supported: player.supported,
    enabled,
    toggle: () => {
      if (!player.supported) return;
      if (enabled) player.stop();
      else player.unlock();
      persist(STORAGE_KEYS.voice, !enabled);
      setEnabled(!enabled);
    },
    /** Called from the tap that asks, which also lets the phone play audio later. */
    arm: () => {
      player.stop();
      reply.current = { turn: undefined, queue: new ReplyAudioQueue<AudioBuffer>(), early: [] };
      if (enabled) player.unlock();
    },
    /** The ask's answer: the turn its reply's audio will carry, or null when none will come. */
    answered: (turn: string | null) => {
      const voicing = reply.current;
      if (!voicing || voicing.turn !== undefined) return;
      voicing.turn = turn;
      const held = voicing.early;
      voicing.early = [];
      for (const event of held) if (audioForAsk(turn, event) === "play") voice(voicing, event);
    },
    disarm: () => {
      reply.current = null;
    },
    /** A `jarvis-audio` event from the stream. */
    hear: (event: JarvisAudioEvent) => {
      const voicing = reply.current;
      const action = audioForAsk(voicing ? voicing.turn : null, event);
      if (!voicing || action === "ignore") return;
      if (action === "hold") voicing.early = [...voicing.early, event].slice(-EARLY_AUDIO_MAX);
      else voice(voicing, event);
    },
    /** Talking: the phone mustn't hear itself, and the reply being played is over. */
    silence: () => {
      player.stop();
      reply.current = null;
    },
    /** For taps that ask later (talking): unlock audio while it's still a tap. */
    prime: () => {
      if (enabled) player.unlock();
    },
  };
}

// Scheduling a sentence this far ahead keeps its first samples from being clipped.
const START_LEAD_S = 0.05;

/**
 * Plays reply sentences back to back through one AudioContext. Phone browsers
 * (iOS above all) only let audio start from a tap, so the context is made or
 * resumed during one and plays a moment of silence; after that, sentences can
 * start whenever they arrive.
 */
class VoicePlayer {
  readonly supported = audioContextConstructor() !== null;
  private context: AudioContext | null = null;
  private readonly playing = new Set<AudioBufferSourceNode>();
  // When the last scheduled sentence ends, in the context's clock.
  private until = 0;

  unlock(): void {
    const Context = audioContextConstructor();
    if (!Context) return;
    try {
      this.context ??= new Context();
      void this.context.resume().catch(() => undefined);
      const silence = this.context.createBufferSource();
      silence.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
      silence.connect(this.context.destination);
      silence.start();
    } catch {
      // No Web Audio after all: replies show as text.
    }
  }

  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.context) return Promise.reject(new Error("audio wasn't unlocked by a tap"));
    return this.context.decodeAudioData(bytes);
  }

  /** Start a sentence the moment the one before it ends (or now, after a gap). */
  play(buffer: AudioBuffer): void {
    const context = this.context;
    if (!context) return;
    // iOS suspends the context while the app is in the background.
    if (context.state !== "running") void context.resume().catch(() => undefined);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(this.until, context.currentTime + START_LEAD_S);
    source.onended = () => this.playing.delete(source);
    source.start(at);
    this.playing.add(source);
    this.until = at + buffer.duration;
  }

  stop(): void {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        // already ended
      }
    }
    this.playing.clear();
    this.until = 0;
  }

  close(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}

function audioContextConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

// Jarvis listens in English whatever the phone's own language is: a Spanish
// iPhone would otherwise transcribe English as Spanish.
const JARVIS_LISTEN_LANG = "en-US";

// ── Talking with the phone's speech recognition ─────────────────────────────

// The Web Speech API isn't in TypeScript's DOM types; this is the part used here.
type RecognitionResults = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: RecognitionResults }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = new () => Recognition;

/** Chrome on Android (webkit-prefixed) and Safari have it, only on HTTPS. */
function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * One utterance at a time: interim words go to `onHeard` as they're
 * recognized, and `onDone` gets the final text (empty if nothing was caught)
 * once recognition ends, by itself after a pause or on `stop()`.
 */
function useTalk(handlers: { onHeard: (text: string) => void; onDone: (text: string) => void; onError: (message: string) => void }) {
  const Recognition = useMemo(recognitionConstructor, []);
  const [listening, setListening] = useState(false);
  const active = useRef<Recognition | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const start = useCallback(() => {
    if (!Recognition || active.current) return;
    const recognition = new Recognition();
    recognition.lang = JARVIS_LISTEN_LANG;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    let finalText = "";
    recognition.onresult = (event) => {
      let interim = "";
      finalText = "";
      for (const result of Array.from(event.results)) {
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      handlersRef.current.onHeard(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") handlersRef.current.onError(recognitionError(event.error));
    };
    recognition.onend = () => {
      if (active.current === recognition) active.current = null;
      setListening(false);
      handlersRef.current.onDone(finalText.trim());
    };
    active.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch (error) {
      active.current = null;
      handlersRef.current.onError(messageOf(error));
      handlersRef.current.onDone("");
    }
  }, [Recognition]);

  const stop = useCallback(() => active.current?.stop(), []);

  // Leaving the screen or the app drops what was being said, without sending it.
  useEffect(() => {
    const drop = () => {
      const recognition = active.current;
      active.current = null;
      if (!recognition) return;
      recognition.onend = null;
      recognition.onresult = null;
      recognition.abort();
      setListening(false);
      handlersRef.current.onDone("");
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") drop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      drop();
    };
  }, []);

  return { supported: Recognition !== null, listening, start, stop };
}

function recognitionError(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") return "The microphone is blocked for this site. Allow it in the browser's site settings.";
  if (code === "audio-capture") return "No microphone was found on this phone.";
  if (code === "network") return "Speech recognition needs a network connection.";
  if (code === "language-not-supported") return "Speech recognition doesn't support this phone's language.";
  return `Speech recognition stopped (${code}).`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function joinDraft(before: string, spoken: string): string {
  const head = before.trim();
  return head && spoken ? `${head} ${spoken}` : head || spoken;
}

function formatClock(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** The remembered place and what Jarvis showed there, for an instant first paint. */
function loadSaved(): { location: JarvisLocation | null; state: JarvisState | null } {
  const location = loadPersisted<JarvisLocation | null>(STORAGE_KEYS.location, null);
  const saved = loadPersisted<{ base?: unknown; state?: unknown } | null>(STORAGE_KEYS.state, null);
  if (!location || typeof location.base !== "string" || saved?.base !== location.base) return { location: null, state: null };
  const state = parseJarvisState(saved.state);
  return state ? { location, state } : { location: null, state: null };
}

// localStorage, like the rest of the app's cross-reload state.
function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Storage unavailable (private mode) or corrupt JSON — fall back to default.
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — non-fatal; the screen just loses instant restore.
  }
}
