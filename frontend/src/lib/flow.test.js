import { describe, expect, it } from "vitest";
import {
  END,
  START,
  agentColor,
  agentTitle,
  buildGraph,
  finalAgentIds,
  sequentialOrder,
} from "./flow.js";

const agent = (id, depends_on = []) => ({ id, role: id, depends_on });

describe("buildGraph", () => {
  it("wires a sequential plan as the compiler's chain, with Start and End", () => {
    const plan = { orchestration_pattern: "sequential", agents: [agent("b", ["a"]), agent("a")] };
    expect(sequentialOrder(plan.agents)).toEqual(["a", "b"]);
    expect(buildGraph(plan).edges.map((e) => e.id)).toEqual([`${START}->a`, "a->b", `b->${END}`]);
  });

  it("wires a parallel plan as its dependency DAG", () => {
    const plan = {
      orchestration_pattern: "parallel",
      agents: [agent("pros"), agent("cons"), agent("verdict", ["pros", "cons"])],
    };
    const ids = buildGraph(plan).edges.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        `${START}->pros`,
        `${START}->cons`,
        "pros->verdict",
        "cons->verdict",
        `verdict->${END}`,
      ]),
    );
    expect(finalAgentIds(plan)).toEqual(["verdict"]);
  });

  it("wires a supervisor plan as a router with round trips to each worker", () => {
    const plan = {
      orchestration_pattern: "supervisor",
      supervisor_id: "sup",
      agents: [agent("sup"), agent("w")],
    };
    const { agents, edges } = buildGraph(plan);
    expect(edges.map((e) => e.id)).toEqual([`${START}->sup`, "sup->w", "w->sup", `sup->${END}`]);
    expect(agents.find((a) => a.id === "sup").isRouter).toBe(true);
  });

  it("gives agents readable titles and stable colours", () => {
    expect(agentTitle("travel_advisor")).toBe("Travel Advisor");
    expect(agentColor(0)).toBe(agentColor(12));
    expect(agentColor(0)).not.toBe(agentColor(1));
  });
});
