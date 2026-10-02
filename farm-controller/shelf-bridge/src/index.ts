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
import { SerialPort } from "serialport";
import {
  type FarmAlert,
  AlertSeverity,
  TOPICS,
  createMqttClient,
  type TypedMqttClient,
} from "@farm/shared";

import { loadConfig, type ShelfBridgeConfig, type ShelfPort } from "./config.js";
import { parseLine } from "./parse.js";

// --- Config --------------------------------------------------

const CONFIG_PATH = process.env.CONFIG_PATH ?? "../../shelf-bridge-config.json";
const BROKER_URL = process.env.BROKER_URL ?? "mqtt://localhost:1883";

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
  /** Last valid reading; startup time until the first one */
  lastReadingAt: number;
  lastSeq: number | null;
  silent: boolean;
}

const links: ShelfLink[] = config.shelves.map((shelf) => ({
  shelf,
  port: null,
  buffer: "",
  reopenTimer: null,
  openFailing: false,
  lastReadingAt: Date.now(),
  lastSeq: null,
  silent: false,
}));

let mqtt: TypedMqttClient;
let shuttingDown = false;

const tag = (link: ShelfLink) => `[${link.shelf.shelf_id}]`;

// --- Lines ---------------------------------------------------

function onLine(link: ShelfLink, raw: string) {
  const line = raw.trim();
  if (!line) return;
  if (line.startsWith("#")) {
    console.log(`${tag(link)} node: ${line.slice(1).trim()}`);
    return;
  }

  const now = Date.now();
  const reading = parseLine(line, link.shelf, now);
  if (!reading) {
    console.warn(`${tag(link)} dropped invalid line: ${line}`);
    return;
  }

  if (link.lastSeq !== null && reading.seq <= link.lastSeq) {
    console.log(`${tag(link)} node restarted (seq ${link.lastSeq} → ${reading.seq})`);
  }
  if (link.silent) {
    console.log(`${tag(link)} reporting again after ${Math.round((now - link.lastReadingAt) / 1000)}s`);
    link.silent = false;
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
    console.warn(`${tag(link)} dropped ${link.buffer.length} bytes with no newline`);
    link.buffer = "";
  }
  for (const line of lines) {
    if (line.length > config.max_line_length) {
      console.warn(`${tag(link)} dropped over-long line (${line.length} bytes)`);
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

  port.on("data", (chunk: Buffer) => onData(link, chunk));
  port.on("error", (err) => console.error(`${tag(link)} serial error: ${err.message}`));
  port.on("close", () => {
    link.port = null;
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

function checkSilence() {
  const now = Date.now();
  for (const link of links) {
    const silence = now - link.lastReadingAt;
    if (link.silent || silence <= config.silence_timeout_ms) continue;
    link.silent = true;

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
      timestamp: now,
    };
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

  for (const link of links) openPort(link);
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
