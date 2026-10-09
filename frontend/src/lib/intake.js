// The new-project conversation, before any plan exists (POST /brief/chat). Pure helpers.

/** Messages since the last created project: the current task's conversation. */
export function currentThread(messages) {
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "divider") start = i + 1;
  });
  return messages.slice(start);
}

/** What an assistant turn said, as plain text, so the model remembers what it asked. */
export function turnText(turn) {
  const questions = (turn.questions ?? []).map((q) => `- ${q.question}`);
  return [turn.reply, ...questions].filter(Boolean).join("\n");
}

/**
 * The current task's conversation as the API takes it: user messages and finished
 * assistant turns, oldest first (pending, failed and plan messages are left out).
 */
export function toApiMessages(messages) {
  const out = [];
  for (const m of currentThread(messages)) {
    if (m.role === "user" && m.text?.trim()) {
      out.push({ role: "user", content: m.text.trim().slice(0, 4000) });
    } else if (m.role === "assistant" && m.kind === "turn" && m.turn) {
      out.push({ role: "assistant", content: turnText(m.turn).slice(0, 4000) });
    }
  }
  return out.slice(-40);
}

/** The latest finished intake turn of the current task, if it has a brief to plan from. */
export function latestBriefTurn(messages) {
  const thread = currentThread(messages);
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const m = thread[i];
    if (m.role === "assistant" && m.kind === "plan") return null;
    if (m.role === "assistant" && m.kind === "turn" && m.status === "done") {
      return m.turn?.brief?.trim() ? m : null;
    }
  }
  return null;
}

/** A clicked quick answer, added to whatever the user is typing. */
export function addAnswer(draft, question, option) {
  const line = `${question} ${option}`;
  return draft.trim() ? `${draft.trimEnd()}\n${line}` : line;
}
