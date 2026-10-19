import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toRemoteCommand } from "../src/commands.js";

// As web/src/app/api/commands/route.ts inserts it
const row = (command: object) => ({
  id: "6f1c1f4e-0000-4000-8000-000000000000",
  robot_id: "robot-1",
  command: { priority: "normal", source: "remote", ...command },
  issued_by: "dashboard",
  issued_at: "1700000000000",
});

describe("remote command rows", () => {
  it("passes what the dashboard's route inserts, issued_at as a number", () => {
    const remote = toRemoteCommand(row({ command: "navigate", target_node: "n-3", action_at_target: "water", duration_ms: 5000 }));
    assert.equal(typeof remote, "object");
    assert.equal((remote as { issued_at: number }).issued_at, 1700000000000);
    assert.equal(typeof toRemoteCommand(row({ command: "stop", immediate: true })), "object");
    assert.equal(typeof toRemoteCommand(row({ command: "cancel", task_id: "t-1", immediate: true })), "object");
  });

  it("refuses local-only commands", () => {
    assert.match(toRemoteCommand(row({ command: "jog", direction: "forward" })) as string, /farm network/);
    assert.match(toRemoteCommand(row({ command: "connect_controller" })) as string, /farm network/);
  });

  it("refuses rows the orchestrator would drop", () => {
    assert.match(toRemoteCommand(row({ command: "fly" })) as string, /unknown command/);
    assert.match(toRemoteCommand(row({ command: "stop", priority: "urgent" })) as string, /command fields/);
    assert.match(toRemoteCommand(row({ command: "navigate", path: [1, 2] })) as string, /command fields/);
    assert.match(toRemoteCommand({ ...row({ command: "stop" }), issued_at: "soon" }) as string, /issued_at/);
    assert.match(toRemoteCommand({ ...row({ command: "stop" }), command: null }) as string, /invalid: command/);
  });
});
