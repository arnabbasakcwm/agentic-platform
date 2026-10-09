import { describe, expect, it } from "vitest";
import {
  addAnswer,
  currentThread,
  latestBriefTurn,
  toApiMessages,
  turnText,
} from "./intake.js";

const turn = (id, t, status = "done") => ({
  id,
  role: "assistant",
  kind: "turn",
  status,
  turn: t,
});

describe("intake conversation", () => {
  const hello = { id: 1, role: "user", text: "hello" };
  const greet = turn(2, {
    reply: "Hi! What should your agents do?",
    questions: [{ question: "Which task?", options: ["Email"] }],
    brief: "",
  });
  const detail = { id: 3, role: "user", text: "Summarise my emails" };
  const ready = turn(4, {
    reply: "Shall I plan it?",
    questions: [],
    brief: "Summarise emails",
    ready: true,
  });

  it("sends user messages and finished turns, with the questions asked", () => {
    expect(
      toApiMessages([hello, greet, detail, turn(5, null, "pending")]),
    ).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "Hi! What should your agents do?\n- Which task?",
      },
      { role: "user", content: "Summarise my emails" },
    ]);
    expect(turnText({ reply: "Ok", questions: [] })).toBe("Ok");
  });

  it("starts fresh after a project was created", () => {
    const plan = { id: 6, role: "assistant", kind: "plan", status: "done" };
    const all = [
      hello,
      greet,
      detail,
      ready,
      plan,
      { id: 7, role: "divider" },
      { id: 8, role: "user", text: "next" },
    ];
    expect(currentThread(all).map((m) => m.id)).toEqual([8]);
    expect(toApiMessages(all)).toEqual([{ role: "user", content: "next" }]);
  });

  it("offers planning only from the latest turn with a brief", () => {
    expect(latestBriefTurn([hello, greet])).toBeNull();
    expect(latestBriefTurn([hello, greet, detail, ready]).id).toBe(4);
    // A newer turn without a brief hides it again.
    expect(
      latestBriefTurn([
        hello,
        greet,
        detail,
        ready,
        { id: 9, role: "user", text: "x" },
        turn(10, { reply: "?", brief: "" }),
      ]),
    ).toBeNull();
    // Once a plan was made from it, it's not offered again.
    expect(
      latestBriefTurn([
        hello,
        ready,
        { id: 11, role: "assistant", kind: "plan", status: "pending" },
      ]),
    ).toBeNull();
  });

  it("adds clicked answers to the draft", () => {
    expect(addAnswer("", "Which task?", "Email")).toBe("Which task? Email");
    expect(addAnswer("Also daily", "Act?", "Read only")).toBe(
      "Also daily\nAct? Read only",
    );
  });
});
