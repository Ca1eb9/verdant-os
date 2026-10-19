// ============================================================
// Outbox: rows waiting to go to Supabase
//
// One queue, flushed oldest first in batches, so an alert clear
// runs after the alerts before it. While Supabase is unreachable
// rows wait here (bounded) and go out when it's back.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogOnce } from "@farm/shared";

export type Row = Record<string, unknown>;

export type Op =
  | { kind: "telemetry" | "sensor" | "alert"; row: Row }
  /** Latest wins: a newer one with the same key replaces a queued one */
  | { kind: "state" | "topology" | "thresholds"; key: string; row: Row }
  /** Delete this farm's alerts */
  | { kind: "clear" };

export interface OutboxOptions {
  farmId: string;
  maxBatchRows: number;
  maxBufferRows: number;
}

/**
 * Postgres data and integrity errors (classes 22 and 23): the row itself is
 * bad, so retrying can't help. Anything else may pass later and is retried: no
 * network, Supabase restarting or overloaded (PGRST000-003, 57P03, 53300), a
 * timeout (57014), a rejected key (PGRST301), a missing grant or column.
 */
const ROW_REFUSED = /^2[23][0-9A-Z]{3}$/;

type SendError = { message: string; code?: string };

export class Outbox {
  private queue: Op[] = [];
  private running: Promise<void> | null = null;
  private sent = new Map<Op["kind"], number>();
  private droppedFull = 0;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly opts: OutboxOptions,
    private readonly logs: LogOnce,
  ) {}

  get size() {
    return this.queue.length;
  }

  add(op: Op) {
    if ("key" in op) {
      this.queue = this.queue.filter((o) => !(o.kind === op.kind && o.key === op.key));
    } else if (op.kind === "clear") {
      // Alerts still waiting would only be deleted again
      this.queue = this.queue.filter((o) => o.kind !== "alert");
    }
    this.queue.push(op);

    while (this.queue.length > this.opts.maxBufferRows) {
      // Telemetry and readings are the least missed; alerts go last
      let i = this.queue.findIndex((o) => o.kind === "telemetry" || o.kind === "sensor");
      if (i < 0) i = 0;
      this.queue.splice(i, 1);
      this.droppedFull++;
      this.logs.warn("full", `[OUT] Buffer full (${this.opts.maxBufferRows} rows), dropping the oldest telemetry and readings (logged once)`);
    }
  }

  /** Sends everything queued, in order; stops at the first batch Supabase can't take yet */
  flush(): Promise<void> {
    // One at a time; a call meanwhile shares the one running
    this.running ??= this.flushQueue().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Waits for a flush in flight, then sends what's left (when stopping) */
  async finish() {
    await this.running;
    await this.flush();
  }

  private async flushQueue() {
    while (this.queue.length > 0) {
      const batch = this.takeBatch();
      const error = await this.send(batch);
      if (!error) {
        this.count(batch);
        continue;
      }
      if (!ROW_REFUSED.test(error.code ?? "")) {
        this.wait(batch, error);
        return;
      }
      if (batch.length === 1) {
        this.drop(batch[0], error);
        continue;
      }
      // One bad row refuses its whole batch: send them one by one to drop only it
      if (!(await this.sendEach(batch))) return;
    }
    this.logs.ok("unreachable", "[OUT] Supabase reachable again, buffered rows sent");
    if (this.droppedFull > 0) {
      console.warn(`[OUT] ${this.droppedFull} row(s) were dropped while the buffer was full`);
      this.droppedFull = 0;
      this.logs.ok("full");
    }
  }

  /** False when Supabase stopped taking rows partway; the rest are back in the queue */
  private async sendEach(batch: Op[]) {
    for (let i = 0; i < batch.length; i++) {
      const error = await this.send([batch[i]]);
      if (!error) {
        this.count([batch[i]]);
      } else if (ROW_REFUSED.test(error.code ?? "")) {
        this.drop(batch[i], error);
      } else {
        this.wait(batch.slice(i), error);
        return false;
      }
    }
    return true;
  }

  private count(batch: Op[]) {
    this.sent.set(batch[0].kind, (this.sent.get(batch[0].kind) ?? 0) + batch.length);
  }

  /** Retrying can't help, and it would hold up every row behind it */
  private drop(op: Op, error: SendError) {
    console.error(`[OUT] Supabase refused one ${op.kind} row, dropped: ${error.message} (${error.code})`);
  }

  private wait(batch: Op[], error: SendError) {
    this.putBack(batch);
    const reason = error.code ? `${error.message} (${error.code})` : error.message;
    this.logs.warn("unreachable", `[OUT] Supabase can't take rows yet (${reason}), keeping them to retry (logged once)`);
  }

  /** Rows sent by kind since the last call */
  takeStats(): Map<Op["kind"], number> {
    const stats = this.sent;
    this.sent = new Map();
    return stats;
  }

  /** Taken off the queue while in flight, so add() never edits a batch being sent */
  private takeBatch(): Op[] {
    const kind = this.queue[0].kind;
    if (kind === "clear") return this.queue.splice(0, 1);
    let n = 1;
    while (n < this.queue.length && n < this.opts.maxBatchRows && this.queue[n].kind === kind) n++;
    return this.queue.splice(0, n);
  }

  /** Back at the front, minus state or topology that a newer one replaced meanwhile */
  private putBack(batch: Op[]) {
    const kept = batch.filter((op) =>
      !("key" in op) || !this.queue.some((o) => o.kind === op.kind && "key" in o && o.key === op.key));
    this.queue.unshift(...kept);
  }

  private async send(batch: Op[]): Promise<SendError | null> {
    const kind = batch[0].kind;
    const rows = batch.map((op) => ("row" in op ? op.row : {}));
    const db = this.supabase;
    let result;
    switch (kind) {
      case "telemetry":
        result = await db.from("robot_telemetry").insert(rows);
        break;
      case "sensor":
        result = await db.from("sensor_events").insert(rows);
        break;
      case "alert":
        // An alert redelivered after a reconnect is already there
        result = await db.from("alerts").upsert(rows, { onConflict: "alert_id", ignoreDuplicates: true });
        break;
      case "state":
        result = await db.from("robot_state").upsert(rows, { onConflict: "farm_id,robot_id" });
        break;
      case "topology":
        result = await db.from("farm_topology").upsert(rows, { onConflict: "farm_id" });
        break;
      case "thresholds":
        result = await db.from("alert_thresholds").upsert(rows, { onConflict: "farm_id" });
        break;
      case "clear":
        // Only this farm's: one project serves every farm
        result = await db.from("alerts").delete().eq("farm_id", this.opts.farmId);
        break;
    }
    return result.error ? { message: result.error.message, code: result.error.code } : null;
  }
}
