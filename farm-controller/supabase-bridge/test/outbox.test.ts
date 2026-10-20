import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LogOnce } from "@farm/shared";
import { Outbox, type Op, type Row } from "../src/outbox.js";

type Reply = { message: string; code?: string } | null;

/** Records each request and answers with `reply(table, rows)` */
function fakeSupabase(reply: (table: string, rows: Row[]) => Reply = () => null) {
  const calls: { table: string; rows: Row[] }[] = [];
  const answer = (table: string, rows: Row[]) => {
    calls.push({ table, rows });
    return Promise.resolve({ error: reply(table, rows) });
  };
  const client = {
    from: (table: string) => ({
      insert: (rows: Row[]) => answer(table, rows),
      upsert: (rows: Row[]) => answer(table, rows),
      delete: () => ({ eq: () => answer(table, []) }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

function outbox(client: SupabaseClient, maxBufferRows = 100) {
  return new Outbox(client, { farmId: "atlas", maxBatchRows: 10, maxBufferRows }, new LogOnce());
}

const telemetry = (n: number): Op => ({ kind: "telemetry", row: { n } });
const alert = (id: string): Op => ({ kind: "alert", row: { alert_id: id } });

describe("outbox", () => {
  it("sends in order, one batch per run of the same kind", async () => {
    const { client, calls } = fakeSupabase();
    const box = outbox(client);
    box.add(telemetry(1));
    box.add(telemetry(2));
    box.add(alert("a"));
    box.add(telemetry(3));
    await box.flush();
    assert.deepEqual(calls.map((c) => [c.table, c.rows.length]), [
      ["robot_telemetry", 2], ["alerts", 1], ["robot_telemetry", 1],
    ]);
    assert.equal(box.size, 0);
  });

  it("keeps rows on errors that may pass later", async () => {
    for (const code of [undefined, "", "PGRST000", "PGRST002", "PGRST003", "PGRST301", "57014", "53300", "57P03", "08006", "40001", "42501"]) {
      let down = true;
      const { client, calls } = fakeSupabase(() => (down ? { message: "unwell", code } : null));
      const box = outbox(client);
      box.add(alert("a"));
      box.add(alert("b"));
      await box.flush();
      assert.equal(box.size, 2, `code ${code}`);
      down = false;
      await box.flush();
      assert.equal(box.size, 0, `code ${code}`);
      assert.deepEqual(calls.at(-1)?.rows, [{ alert_id: "a" }, { alert_id: "b" }]);
    }
  });

  it("drops only the row Supabase refuses, not the rest of its batch", async () => {
    const { client, calls } = fakeSupabase((_, rows) =>
      rows.some((r) => r.alert_id === "bad") ? { message: "bad value", code: "22P02" } : null);
    const box = outbox(client);
    box.add(alert("a"));
    box.add(alert("bad"));
    box.add(alert("c"));
    await box.flush();
    assert.equal(box.size, 0);
    const sent = calls.filter((c) => c.rows.length === 1 && c.rows[0].alert_id !== "bad").map((c) => c.rows[0].alert_id);
    assert.deepEqual(sent, ["a", "c"]);
  });

  it("puts the rest back in order when Supabase goes away while finding the bad row", async () => {
    let calls = 0;
    const { client } = fakeSupabase(() => {
      calls++;
      if (calls === 1) return { message: "duplicate", code: "23505" };
      if (calls === 2) return null;
      return { message: "fetch failed" };
    });
    const box = outbox(client);
    box.add(alert("a"));
    box.add(alert("b"));
    box.add(alert("c"));
    await box.flush();
    // a went through alone; b and c wait, in order
    assert.equal(box.size, 2);
  });

  it("keeps only the latest queued state per robot", async () => {
    const { client, calls } = fakeSupabase();
    const box = outbox(client);
    box.add({ kind: "state", key: "robot-1", row: { v: 1 } });
    box.add({ kind: "state", key: "robot-2", row: { v: 2 } });
    box.add({ kind: "state", key: "robot-1", row: { v: 3 } });
    await box.flush();
    assert.deepEqual(calls[0].rows, [{ v: 2 }, { v: 3 }]);
  });

  it("doesn't put back state a newer one replaced while it was in flight", async () => {
    let box: Outbox;
    const { client } = fakeSupabase((_, rows) => {
      if (rows[0]?.v === 1) {
        box.add({ kind: "state", key: "robot-1", row: { v: 2 } });
        return { message: "fetch failed" };
      }
      return null;
    });
    box = outbox(client);
    box.add({ kind: "state", key: "robot-1", row: { v: 1 } });
    await box.flush();
    assert.equal(box.size, 1);
  });

  it("drops the oldest telemetry first when full, never alerts while there's telemetry", () => {
    const { client } = fakeSupabase();
    const box = outbox(client, 3);
    box.add(alert("a"));
    box.add(telemetry(1));
    box.add(telemetry(2));
    box.add(alert("b"));
    assert.equal(box.size, 3);
  });

  it("a clear drops the alerts still queued", async () => {
    const { client, calls } = fakeSupabase();
    const box = outbox(client);
    box.add(alert("a"));
    box.add({ kind: "clear" });
    box.add(alert("b"));
    await box.flush();
    assert.deepEqual(calls.map((c) => c.table), ["alerts", "alerts"]);
    assert.deepEqual(calls[1].rows, [{ alert_id: "b" }]);
  });

  it("finish() waits for a flush in flight, then sends rows added meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tables: number[] = [];
    const client = {
      from: () => ({
        insert: async (rows: Row[]) => {
          if (rows[0].n === 1) await gate;
          tables.push(rows[0].n as number);
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;
    const box = outbox(client);
    box.add(telemetry(1));
    void box.flush();
    box.add(telemetry(2));
    const done = box.finish();
    release();
    await done;
    assert.deepEqual(tables, [1, 2]);
    assert.equal(box.size, 0);
  });
});
