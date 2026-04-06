import { Session, type ConversationMessage } from "./session";

export interface CompactionConfig {
  preserveRecentMessages: number;
}

export interface CompactionResult {
  summary: string;
  formattedSummary: string;
  compactedSession: Session;
  removedMessageCount: number;
}

const COMPACT_CONTINUATION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context.";

export function formatCompactSummary(summary: string): string {
  const withoutAnalysis = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    return `Summary:\n${summaryMatch[1]!.trim()}`;
  }
  return withoutAnalysis.replace(/\n{3,}/g, "\n\n").trim();
}

export function shouldCompact(session: Session, config: CompactionConfig): boolean {
  return session.messages.length > config.preserveRecentMessages;
}

export function compactSession(session: Session, config: CompactionConfig): CompactionResult {
  if (!shouldCompact(session, config)) {
    return {
      summary: "",
      formattedSummary: "",
      compactedSession: session,
      removedMessageCount: 0
    };
  }

  const removedMessageCount = Math.max(0, session.messages.length - config.preserveRecentMessages);
  const removed = session.messages.slice(0, removedMessageCount);
  const preserved = session.messages.slice(removedMessageCount);
  const summary = summarizeMessages(removed);
  const formattedSummary = formatCompactSummary(summary);
  const compactedSession = new Session(
    session.sessionId,
    [
      {
        role: "system",
        blocks: [{ type: "text", text: `${COMPACT_CONTINUATION_PREAMBLE}\n\n${formattedSummary}` }]
      },
      ...preserved
    ],
    session.persistencePath,
    {
      summary,
      removedMessageCount,
      count: (session.compaction?.count ?? 0) + 1
    },
    session.fork,
    session.maxPersistenceBytes,
    session.version,
    session.createdAtMs,
    Date.now()
  );

  return {
    summary,
    formattedSummary,
    compactedSession,
    removedMessageCount
  };
}

function summarizeMessages(messages: ConversationMessage[]): string {
  const timeline = messages
    .map((message) => {
      const block = message.blocks[0];
      if (!block) {
        return `${message.role}: (empty)`;
      }
      if (block.type === "text") {
        return `${message.role}: ${truncate(block.text, 80)}`;
      }
      if (block.type === "tool_use") {
        return `${message.role}: tool_use ${block.name}`;
      }
      return `${message.role}: tool_result ${block.tool_name}`;
    })
    .join("\n  - ");

  return [
    "<summary>",
    "Conversation summary:",
    `- Scope: ${messages.length} earlier messages compacted.`,
    "- Key timeline:",
    `  - ${timeline}`,
    "</summary>"
  ].join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}
