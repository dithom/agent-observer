import { describe, it, expect } from "vitest";
import { sortAgents } from "../src/sort-agents";

function agent(status: string, timestamp: number, id = "") {
  return { status, timestamp, id };
}

describe("sortAgents", () => {
  it("returns list unchanged when moveInactiveToTop is false", () => {
    const list = [agent("running", 100), agent("idle", 50)];
    const result = sortAgents(list, false);
    expect(result).toBe(list); // same reference
  });

  it("moves inactive agents before running agents", () => {
    const running = agent("running", 200, "r");
    const idle = agent("idle", 100, "i");
    const result = sortAgents([running, idle], true);
    expect(result.map((a) => a.id)).toEqual(["i", "r"]);
  });

  it("moves waiting_for_user before running", () => {
    const running = agent("running", 200, "r");
    const waiting = agent("waiting_for_user", 100, "w");
    const result = sortAgents([running, waiting], true);
    expect(result.map((a) => a.id)).toEqual(["w", "r"]);
  });

  it("moves error before running", () => {
    const running = agent("running", 200, "r");
    const error = agent("error", 100, "e");
    const result = sortAgents([running, error], true);
    expect(result.map((a) => a.id)).toEqual(["e", "r"]);
  });

  it("sorts inactive agents by timestamp ascending (oldest first)", () => {
    const a = agent("idle", 300, "new");
    const b = agent("waiting_for_user", 100, "old");
    const c = agent("error", 200, "mid");
    const result = sortAgents([a, b, c], true);
    expect(result.map((a) => a.id)).toEqual(["old", "mid", "new"]);
  });

  it("sorts running agents by timestamp ascending", () => {
    const a = agent("running", 300, "new");
    const b = agent("running", 100, "old");
    const result = sortAgents([a, b], true);
    expect(result.map((a) => a.id)).toEqual(["old", "new"]);
  });

  it("agent switching from running to inactive moves above running agents", () => {
    // Scenario: two agents, both were running, one becomes idle
    const stillRunning = agent("running", 100, "still-running");
    const justBecameIdle = agent("idle", 200, "just-idle");
    const result = sortAgents([stillRunning, justBecameIdle], true);
    expect(result.map((a) => a.id)).toEqual(["just-idle", "still-running"]);
  });

  it("agent switching back to running moves below inactive agents", () => {
    const inactive = agent("idle", 100, "inactive");
    const backToRunning = agent("running", 200, "back-running");
    const result = sortAgents([backToRunning, inactive], true);
    expect(result.map((a) => a.id)).toEqual(["inactive", "back-running"]);
  });

  it("mixed scenario: multiple inactive and running agents", () => {
    const agents = [
      agent("running", 500, "r2"),
      agent("idle", 300, "i2"),
      agent("running", 400, "r1"),
      agent("waiting_for_user", 100, "w1"),
      agent("error", 200, "e1"),
    ];
    const result = sortAgents(agents, true);
    expect(result.map((a) => a.id)).toEqual(["w1", "e1", "i2", "r1", "r2"]);
  });

  it("does not mutate the original array", () => {
    const list = [agent("running", 200), agent("idle", 100)];
    const copy = [...list];
    sortAgents(list, true);
    expect(list).toEqual(copy);
  });
});
