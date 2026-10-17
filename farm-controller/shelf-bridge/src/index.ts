// ============================================================
// Shelf bridge
//
// Reads each shelf sensor node's JSON lines over USB serial and
// publishes them as ShelfSensorData. Reopens a port that drops
// and alerts once when a shelf goes quiet.
//
// Run:  npx tsx src/index.ts
// ============================================================

import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { performance } from "perf_hooks";
import { SerialPort } from "serialport";
import {
  type AlertsCleared,
  type FarmAlert,
  AlertSeverity,
  TOPICS,
  createMqttClient,
  readStateFile,
  writeStateFile,
  type TypedMqttClient,
  LogOnce,
} from "@farm/shared";

import { loadConfig, type ShelfBridgeConfig, type ShelfPort } from "./config.js";
import { parseLine } from "./parse.js";

// --- Config --------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../shelf-bridge-config.json";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";
/** Open silence alerts by shelf, so readings after a restart or reboot still resolve them */
const STATE_PATH = fileURLToPath(
  new URL(process.env.STATE_PATH ?? "../../shelf-bridge-state.json", import.meta.url),
);

let config: ShelfBridgeConfig;
try {
  config = loadConfig(fileURLToPath(new URL(CONFIG_PATH, import.meta.url)));
} catch (err) {
  console.error(`[FATAL] Bad shelf bridge config (${CONFIG_PATH}): ${(err as Error).message}`);
  process.exit(1);
}

interface ShelfLink {
  shelf: ShelfPort;
  port: SerialPort | null;
  buffer: string;
  reopenTimer: NodeJS.Timeout | null;
  /** Open failures log once per outage, not every retry */
  openFailing: boolean;
  /** Monotonic ms (performance.now) of the last valid reading; startup until the first */
  lastReadingAt: number;
  /** Monotonic ms the port last opened; a node needs time to boot before it's silent */
  openedAt: number;
  lastSeq: number | null;
  /** The open silence alert, while the shelf is silent, for the next reading to resolve */
  silenceAlertId: string | null;
  /** Last non-reading line, so a sensor library repeating its error logs once */
  lastNodeLog: string;
}

const links: ShelfLink[] = config.shelves.map((shelf) => ({
  shelf,
  port: null,
  buffer: "",
  reopenTimer: null,
  openFailing: false,
  lastReadingAt: performance.now(),
  openedAt: 0,
  lastSeq: null,
  silenceAlertId: null,
  lastNodeLog: "",
}));

let mqtt: TypedMqttClient;
let shuttingDown = false;
/** A shelf's bad lines: logged once until it sends a valid reading */
const logs = new LogOnce();

const tag = (link: ShelfLink) => `[${link.shelf.shelf_id}]`;

// --- Lines ---------------------------------------------------

function onLine(link: ShelfLink, raw: string) {
  const line = raw.trim();
  if (!line) return;
  // Readings are JSON objects; anything else is the node's '#' logs, a sensor
  // library's own error prints, or boot noise
  if (!line.startsWith("{")) {
    if (line !== link.lastNodeLog) console.log(`${tag(link)} node: ${line.replace(/^#\s*/, "")}`);
    link.lastNodeLog = line;
    return;
  }

  // Wall clock only for the published timestamp; the Pi's clock can jump
  // (no RTC, NTP may sync late), so silence is measured on a monotonic clock
  const reading = parseLine(line, link.shelf, Date.now());
  const now = performance.now();
  if (!reading) {
    logs.warn(`invalid ${link.shelf.shelf_id}`,
      `${tag(link)} dropped invalid line (logged once until a valid reading): ${line}`);
    return;
  }
  logs.ok(`invalid ${link.shelf.shelf_id}`, `${tag(link)} valid readings again`);
  logs.ok(`long ${link.shelf.shelf_id}`);

  if (link.lastSeq !== null && reading.seq <= link.lastSeq) {
    console.log(`${tag(link)} node restarted (seq ${link.lastSeq} → ${reading.seq})`);
  }
  if (link.silenceAlertId) {
    // Since this run started, if the silence began before a restart
    const silence = Math.round((now - link.lastReadingAt) / 1000);
    console.log(`${tag(link)} reporting again after ${silence}s`);
    const alert: FarmAlert = {
      alert_id: randomUUID(),
      severity: AlertSeverity.INFO,
      source: link.shelf.shelf_id,
      source_type: "shelf",
      message: "Sensor readings resumed",
      metric: "silence_s",
      value: silence,
      threshold: Math.round(config.silence_timeout_ms / 1000),
      timestamp: Date.now(),
      resolves: link.silenceAlertId,
    };
    mqtt.publish(TOPICS.alerts, alert);
    link.silenceAlertId = null;
    saveSilenceAlerts();
  }
  link.lastSeq = reading.seq;
  link.lastReadingAt = now;

  mqtt.publish(TOPICS.shelf.sensors(link.shelf.shelf_id), reading.data);
}

function onData(link: ShelfLink, chunk: Buffer) {
  link.buffer += chunk.toString("utf8");
  const lines = link.buffer.split(/\r?\n/);
  link.buffer = lines.pop() ?? "";
  if (link.buffer.length > config.max_line_length) {
    logs.warn(`long ${link.shelf.shelf_id}`,
      `${tag(link)} dropped ${link.buffer.length} bytes with no newline (logged once until a valid reading)`);
    link.buffer = "";
  }
  for (const line of lines) {
    if (line.length > config.max_line_length) {
      logs.warn(`long ${link.shelf.shelf_id}`,
        `${tag(link)} dropped over-long line of ${line.length} bytes (logged once until a valid reading)`);
      continue;
    }
    onLine(link, line);
  }
}

// --- Serial port ---------------------------------------------

function scheduleReopen(link: ShelfLink) {
  if (shuttingDown || link.reopenTimer) return;
  link.reopenTimer = setTimeout(() => {
    link.reopenTimer = null;
    openPort(link);
  }, config.reopen_interval_ms);
}

function openPort(link: ShelfLink) {
  const port = new SerialPort({
    path: link.shelf.port,
    baudRate: config.baud,
    autoOpen: false,
  });
  link.port = port;
  link.buffer = "";
  link.lastNodeLog = "";
  // Set before open() so the silence check never sees an open port with a stale time
  link.openedAt = performance.now();

  port.on("data", (chunk: Buffer) => onData(link, chunk));
  port.on("error", (err) => console.error(`${tag(link)} serial error: ${err.message}`));
  port.on("close", () => {
    if (link.port === port) link.port = null;
    if (shuttingDown) return;
    console.warn(`${tag(link)} ${link.shelf.port} closed, reopening`);
    scheduleReopen(link);
  });

  port.open((err) => {
    if (err) {
      if (!link.openFailing) {
        console.warn(`${tag(link)} can't open ${link.shelf.port}: ${err.message}, retrying`);
        link.openFailing = true;
      }
      link.port = null;
      scheduleReopen(link);
      return;
    }
    link.openFailing = false;
    console.log(`${tag(link)} opened ${link.shelf.port}`);
  });
}

// --- Silence watchdog ----------------------------------------

function saveSilenceAlerts() {
  writeStateFile(STATE_PATH, Object.fromEntries(
    links.flatMap((link) => (link.silenceAlertId ? [[link.shelf.shelf_id, link.silenceAlertId]] : [])),
  ));
}

/** Shelves still silent when the last run stopped: the shelf's next reading resolves the alert */
function restoreSilenceAlerts() {
  const saved = readStateFile(STATE_PATH);
  if (typeof saved !== "object" || saved === null) return;
  for (const link of links) {
    const alertId = (saved as Record<string, unknown>)[link.shelf.shelf_id];
    if (typeof alertId === "string" && alertId !== "") link.silenceAlertId = alertId;
  }
}

function checkSilence() {
  const now = performance.now();
  for (const link of links) {
    // An open port that stays quiet may be wedged, or the node hung past its
    // watchdog. Reopening it toggles DTR, which also resets the Uno.
    if (link.port?.isOpen && now - Math.max(link.lastReadingAt, link.openedAt) > config.silence_timeout_ms) {
      console.warn(`${tag(link)} open but silent, reopening ${link.shelf.port}`);
      link.port.close();
    }

    const silence = now - link.lastReadingAt;
    if (link.silenceAlertId || silence <= config.silence_timeout_ms) continue;

    const port = link.port?.isOpen ? `${link.shelf.port} open` : `${link.shelf.port} not open`;
    const alert: FarmAlert = {
      alert_id: randomUUID(),
      severity: AlertSeverity.WARNING,
      source: link.shelf.shelf_id,
      source_type: "shelf",
      message: `No sensor readings for ${Math.round(silence / 1000)}s (${port})`,
      metric: "silence_s",
      value: Math.round(silence / 1000),
      threshold: Math.round(config.silence_timeout_ms / 1000),
      timestamp: Date.now(),
      resolves: null,
    };
    link.silenceAlertId = alert.alert_id;
    saveSilenceAlerts();
    mqtt.publish(TOPICS.alerts, alert);
    console.warn(`[ALERT] ${link.shelf.shelf_id}: ${alert.message}`);
  }
}

// --- Main ----------------------------------------------------

async function main() {
  mqtt = await createMqttClient({
    serviceName: "shelf-bridge",
    brokerUrl: BROKER_URL,
  });

  console.log(`[SHELF] Shelf bridge running`);
  console.log(`[SHELF]   broker:  ${BROKER_URL}`);
  for (const { shelf } of links) {
    console.log(`[SHELF]   ${shelf.shelf_id} (level ${shelf.level}) ← ${shelf.port}`);
  }

  restoreSilenceAlerts();
  const stillSilent = links.filter((link) => link.silenceAlertId).length;
  console.log(`[SHELF]   state:   ${STATE_PATH} (${stillSilent} silent before the restart)`);
  for (const link of links) openPort(link);
  // npm run clear-alerts: forget open silence alerts; a shelf still silent alerts again
  mqtt.subscribe<unknown>(TOPICS.alertsClear, (msg) => {
    if (!Number.isFinite((msg as Partial<AlertsCleared> | null)?.timestamp)) return;
    for (const link of links) link.silenceAlertId = null;
    saveSilenceAlerts();
    console.log("[SHELF] Alerts cleared");
  });
  setInterval(checkSilence, config.watchdog_interval_ms);

  const shutdown = async () => {
    shuttingDown = true;
    console.log("[SHELF] Shutting down");
    for (const link of links) {
      if (link.reopenTimer) clearTimeout(link.reopenTimer);
      if (link.port?.isOpen) link.port.close();
    }
    await mqtt.disconnect();
    process.exit(0);
  };
  // systemd stops services with SIGTERM
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[FATAL] Shelf bridge failed:", err);
  process.exit(1);
});
