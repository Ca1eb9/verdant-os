// ============================================================
// Recurring problems logged once: a bad sender, a broker that's down
// or a node printing garbage would otherwise log on every message
// and fill a service's journal.
// ============================================================

export class LogOnce {
  private readonly open = new Set<string>();

  /** Logs `message` when `key` goes bad, then nothing until ok(key) */
  warn(key: string, message: string) {
    if (this.open.has(key)) return;
    this.open.add(key);
    console.warn(message);
  }

  /** `key` is fine again: logs `message`, if given, when it had gone bad */
  ok(key: string, message?: string) {
    if (this.open.delete(key) && message) console.log(message);
  }
}
