// Agent-attention detection for mobile push, driven by output timing.
//
// Matching keywords in every output chunk (what context-workspace's
// client/src/workspace-attention.ts does for desktop badges) fires on ordinary
// chatter and misses prompts that avoid its words. Timing is a better signal:
// agent TUIs repaint continuously while they work (Claude Code writes every
// ~100 ms, even during long tool calls) and go silent once they wait on the
// user. So a terminal that has gone quiet has stopped, and the last screen
// tells a question or approval prompt apart from a finished turn.

/** Quiet this long with a prompt on screen: the agent is waiting on an answer. */
export const ACTION_SETTLE_MS = 20_000;
/** Quiet this long after real work: the agent finished its turn. */
export const FINISH_SETTLE_MS = 60_000;
/** Shorter bursts (typing echo, redraws) never count as finished work. */
export const MIN_WORK_MS = 30_000;
const SCREEN_TAIL_CHARS = 1_500;

// Phrases from approval dialogs and pickers rather than ordinary prose. Bare
// words like "permission" or "allow" would misfire: Claude Code's idle footer
// can read "bypass permissions on".
const PROMPT_CUES = [
  /\b(?:do you want to|would you like to)\b[^?]{0,160}\?/i, // Claude Code / Codex approval dialogs
  /\bno, and tell \w+ what to do\b/i,
  /\bdon['’]?t ask again\b/i,
  /[([]y\/n[)\]]/i,
  /\benter to (?:select|confirm)\b/i,
  /\bpress enter to continue\b/i,
];

/**
 * Tracks output bursts per terminal. A burst is output whose gaps are all
 * shorter than ACTION_SETTLE_MS, and each burst yields at most one attention
 * event: `due` keeps reporting it until the caller acknowledges it, so a
 * rate-limited alert can still go out later if the agent is still waiting.
 */
export class AttentionTracker {
  #bursts = new Map();

  output(id, chunk, now) {
    let burst = this.#bursts.get(id);
    if (!burst || now - burst.lastOutputAt >= ACTION_SETTLE_MS) {
      burst = { startedAt: now, lastOutputAt: now, tail: "", acknowledged: false };
      this.#bursts.set(id, burst);
    }
    burst.lastOutputAt = now;
    burst.tail = (burst.tail + chunk).slice(-SCREEN_TAIL_CHARS);
  }

  /** Returns "action" or "finished" once the terminal has been quiet long enough, else null. */
  due(id, now) {
    const burst = this.#bursts.get(id);
    if (!burst || burst.acknowledged) return null;
    const quietFor = now - burst.lastOutputAt;
    if (quietFor >= ACTION_SETTLE_MS && showsPrompt(burst.tail)) return "action";
    if (quietFor >= FINISH_SETTLE_MS && burst.lastOutputAt - burst.startedAt >= MIN_WORK_MS) return "finished";
    return null;
  }

  acknowledge(id) {
    const burst = this.#bursts.get(id);
    if (burst) burst.acknowledged = true;
  }

  /** Drops state for terminals that are no longer running. */
  retain(liveIds) {
    for (const id of this.#bursts.keys()) {
      if (!liveIds.has(id)) this.#bursts.delete(id);
    }
  }
}

export function showsPrompt(output) {
  const text = stripTerminalCodes(output).replace(/\s+/g, " ");
  return PROMPT_CUES.some((cue) => cue.test(text));
}

function stripTerminalCodes(data) {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ") // OSC: titles, hyperlinks
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, " ") // CSI: cursor moves, colors
    .replace(/\x1b[()#][0-9A-Za-z]|\x1b[@-_]/g, " ") // charset and other short escapes
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
}
