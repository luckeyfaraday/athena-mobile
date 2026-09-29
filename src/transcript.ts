// Turns the markdown transcripts from Athena's backend into chat messages.
//
// Section headings per provider (context-workspace backend/agent_sessions.py):
//   Claude, Hermes, OpenCode  "## User" / "## Assistant (agent / model)"
//   Grok, Athena Code         "### User" / "### Assistant (timestamp)"
//   Codex                     "### <timestamp> response_item: <role or item type>"
//                             "### <timestamp> event_msg: <event type>"
// Only these shapes start a section, so headings inside a reply (such as
// "## Plan") stay part of the message body.

export type TranscriptRole = "user" | "assistant" | "tool";

export type TranscriptMessage = { role: TranscriptRole; text: string };

const ROLE_HEADING = /^#{2,3} (User|Assistant|System|Developer|Tool|Message)(?: \(.*\))?$/i;
const CODEX_HEADING = /^### (?:\S+ )?(response_item|event_msg): (\S+)$/;

export function parseTranscript(markdown: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  // null while inside a section we don't show (metadata, developer context,
  // tool output, or the partial section a tail read starts in).
  let current: { role: TranscriptRole; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanMessage(current.role, current.lines.join("\n"));
    if (text) messages.push({ role: current.role, text });
    current = null;
  };

  for (const line of markdown.split("\n")) {
    const role = sectionRole(line);
    if (role === undefined) {
      current?.lines.push(line);
      continue;
    }
    flush();
    if (role) current = { role, lines: [] };
  }
  flush();
  return mergeRuns(messages);
}

/** The role a heading line opens; null for a hidden section; undefined if not a heading. */
function sectionRole(line: string): TranscriptRole | null | undefined {
  const role = ROLE_HEADING.exec(line)?.[1].toLowerCase();
  if (role) return role === "user" || role === "assistant" ? role : null;

  const codex = CODEX_HEADING.exec(line);
  if (!codex) return undefined;
  const [, entryType, itemType] = codex;
  // Codex's event messages repeat the response items, so only items are shown.
  if (entryType !== "response_item") return null;
  if (itemType === "user" || itemType === "assistant") return itemType;
  if (itemType.endsWith("_call")) return "tool";
  return null;
}

function cleanMessage(role: TranscriptRole, raw: string): string {
  let text = raw.trim();
  if (role === "tool") {
    // Codex writes "tool: <name>" followed by the call's arguments.
    return /^tool: (.+)$/m.exec(text)?.[1].trim() || "tool";
  }
  if (role === "user") {
    // Claude Code slash commands arrive as tagged blocks; show them as typed.
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1].trim();
    if (command) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim();
      return args ? `${command} ${args}` : command;
    }
  }
  // Agents prepend injected context (system reminders, environment details)
  // as tagged blocks; drop leading ones so only what was written remains.
  let previous;
  do {
    previous = text;
    text = text.replace(/^<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i, "");
  } while (text !== previous);
  return text;
}

// Claude Code records each block of a reply as its own message, and Codex
// often makes several tool calls in a row; show each run as one message.
function mergeRuns(messages: TranscriptMessage[]): TranscriptMessage[] {
  const merged: TranscriptMessage[] = [];
  let toolNames: string[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === "assistant" && message.role === "assistant") {
      merged[merged.length - 1] = { role: "assistant", text: `${last.text}\n\n${message.text}` };
    } else if (last?.role === "tool" && message.role === "tool") {
      toolNames.push(message.text);
      merged[merged.length - 1] = { role: "tool", text: describeToolRun(toolNames) };
    } else {
      if (message.role === "tool") toolNames = [message.text];
      merged.push(message.role === "tool" ? { role: "tool", text: describeToolRun(toolNames) } : message);
    }
  }
  return merged;
}

function describeToolRun(names: string[]): string {
  const unique = Array.from(new Set(names)).join(", ");
  return names.length === 1 ? `Tool call: ${unique}` : `${names.length} tool calls: ${unique}`;
}
