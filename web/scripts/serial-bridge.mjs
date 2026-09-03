import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { SerialPort } from "serialport";

const DEFAULT_DEVICE = "arduino-uno-r3-1";
const DEFAULT_PORT = "/dev/ttyACM0";
const DEFAULT_BAUD = 9600;
const BLOCK_END = "-----------------------------------";
const RECONNECT_DELAY_MS = 3000;
function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env.local");

const serialPortPath = process.env.SERIAL_PORT ?? DEFAULT_PORT;
const serialBaud = Number(process.env.SERIAL_BAUD ?? DEFAULT_BAUD);
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

if (!Number.isInteger(serialBaud) || serialBaud <= 0) {
  console.error(`Invalid SERIAL_BAUD: ${process.env.SERIAL_BAUD}`);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

let lineBuffer = "";
let blockLines = [];
let reconnectTimer = null;
let port = null;

function toNumber(value) {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value) {
  const match = value.match(/^Time:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/m);

  if (!match) {
    return null;
  }

  const date = new Date(`${match[1]}T${match[2]}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseArduinoBlock(rawText) {
  const ts = parseTimestamp(rawText);

  const airMatch = rawText.match(
    /Air Temp:\s*([-+]?\d+(?:\.\d+)?)\s*C\s*\|\s*Temperature in Fahrenheit:\s*([-+]?\d+(?:\.\d+)?)\s*F\s*\|\s*Humidity:\s*([-+]?\d+(?:\.\d+)?)\s*%/i,
  );
  const waterTempMatch = rawText.match(
    /Water Temp:\s*([-+]?\d+(?:\.\d+)?)\s*C\s*\|\s*Temperature in Fahrenheit:\s*([-+]?\d+(?:\.\d+)?)\s*F/i,
  );
  const waterLevelMatch = rawText.match(/Water Level:\s*(LOW|OK)\s*\/\s*([^\r\n]+)/i);
  const phMatch = rawText.match(
    /pH Voltage:\s*([-+]?\d+(?:\.\d+)?)\s*V\s*\|\s*pH:\s*([-+]?\d+(?:\.\d+)?)/i,
  );
  const lightMatch = rawText.match(/Light:\s*([-+]?\d+(?:\.\d+)?)\s*lux/i);
  const lightLux = toNumber(lightMatch?.[1]);

  return {
    device: process.env.DEVICE_ID ?? DEFAULT_DEVICE,
    source: "serial",
    ts,
    air_temp_c: toNumber(airMatch?.[1]),
    air_temp_f: toNumber(airMatch?.[2]),
    humidity_pct: toNumber(airMatch?.[3]),
    water_temp_c: toNumber(waterTempMatch?.[1]),
    water_temp_f: toNumber(waterTempMatch?.[2]),
    water_level_ok: waterLevelMatch ? waterLevelMatch[1].toUpperCase() === "OK" : null,
    water_level_text: waterLevelMatch
      ? `${waterLevelMatch[1].toUpperCase()} / ${waterLevelMatch[2].trim()}`
      : null,
    ph_voltage: toNumber(phMatch?.[1]),
    ph: toNumber(phMatch?.[2]),
    light_lux: lightLux,
    // Approximate lux to PPFD conversion. Real PPFD depends on fixture spectrum.
    light_ppfd: lightLux === null ? null : lightLux / 54,
    raw_text: rawText,
  };
}

async function insertBlock(rawText) {
  let record;

  try {
    record = parseArduinoBlock(rawText);
  } catch (error) {
    console.error(`Parse failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(rawText);
    return;
  }

  const { error } = await supabase.from("sensor_events").insert(record);

  if (error) {
    console.error(`Supabase insert failed: ${error.message}`);
    return;
  }
  console.log(
    `Inserted ${record.device} ${record.ts} air=${record.air_temp_c ?? "null"}C water=${record.water_temp_c ?? "null"}C pH=${record.ph ?? "null"} light=${record.light_ppfd === null ? "null" : record.light_ppfd.toFixed(1)} PPFD`,
  );
}

function handleLine(line) {
  const trimmed = line.trim();

  if (!trimmed || trimmed === "BH1750 started" || trimmed === "DS1307 RTC started") {
    return;
  }

  if (trimmed === BLOCK_END) {
    if (blockLines.length > 0) {
      const rawText = [...blockLines, BLOCK_END].join("\n");
      blockLines = [];
      void insertBlock(rawText);
    }

    return;
  }

  if (trimmed.startsWith("Time:")) {
    blockLines = [trimmed];
    return;
  }

  if (blockLines.length > 0) {
    blockLines.push(trimmed);
  }
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSerialPort();
  }, RECONNECT_DELAY_MS);
}

function openSerialPort() {
  console.log(`Opening ${serialPortPath} at ${serialBaud} baud...`);
  port = new SerialPort({
    path: serialPortPath,
    baudRate: serialBaud,
    autoOpen: false,
  });

  port.on("data", (chunk) => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      handleLine(line);
    }
  });

  port.on("error", (error) => {
    console.error(`Serial error: ${error.message}`);
  });

  port.on("close", () => {
    console.error(`Serial port closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  port.open((error) => {
    if (error) {
      console.error(`Could not open ${serialPortPath}: ${error.message}`);
      console.error("Check the Arduino Uno R3 port with: ls /dev/ttyACM* /dev/ttyUSB*");
      scheduleReconnect();
      return;
    }

    console.log("Serial bridge running. Waiting for Arduino Uno R3 sensor blocks...");
  });
}

process.on("SIGINT", () => {
  console.log("\nStopping serial bridge.");
  clearTimeout(reconnectTimer);

  if (port?.isOpen) {
    port.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
});

openSerialPort();
