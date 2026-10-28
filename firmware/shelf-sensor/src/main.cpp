// main.cpp
// Shelf sensor node: reads the air and reservoir sensors and prints one JSON
// line per report over USB serial. The Pi's shelf-bridge adds the shelf id,
// pH conversion and timestamp. Lines starting with '#' are logs the bridge
// ignores. A failed sensor prints null; the others keep reporting.
// The other way, the bridge sends "lights <0|1 per channel>" to switch the
// level light relays (README "Input").

#include <Arduino.h>
#include <BH1750.h>
#include <DHT.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>
#include <avr/wdt.h>
#include <math.h>

#include "config.h"

static DHT dht(PIN_DHT, DHT11);
static BH1750 lightMeter;
static OneWire oneWire(PIN_WATER_TEMP);
static DallasTemperature waterProbe(&oneWire);

static bool lightReady = false;
static uint32_t seq = 0;
static uint32_t lastReportMs = 0;

// The Pi's input line being read, and when it last set the lights
static char inputLine[MAX_INPUT_LINE + 1];
static uint8_t inputLen = 0;
static bool inputTooLong = false;
static bool lightsFromPi = false;
static uint32_t lastLightsMs = 0;

// Last known health per sensor, so failures log once instead of every report
static bool airOk = true;
static bool lightOk = true;
static bool waterTempOk = true;

static void noteHealth(const __FlashStringHelper* name, bool ok, bool& wasOk) {
  if (ok == wasOk) return;
  wasOk = ok;
  Serial.print(F("# "));
  Serial.print(name);
  Serial.println(ok ? F(" ok") : F(" failed"));
}

static float readLight() {
  if (!lightReady) lightReady = lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE);
  if (!lightReady) return NAN;
  float lux = lightMeter.readLightLevel();
  if (lux < 0) {
    // Bus error: configure it again on the next report
    lightReady = false;
    return NAN;
  }
  // A BH1750 that browns out restarts powered down and keeps answering with
  // a stale value; re-sending the mode each report recovers it by the next one
  lightReady = lightMeter.configure(BH1750::CONTINUOUS_HIGH_RES_MODE);
  return lux;
}

// Reads the conversion started at the previous report, then starts the next
// one, so the 750 ms conversion never blocks the loop.
static float readWaterTemp() {
  float c = waterProbe.getTempCByIndex(0);
  waterProbe.requestTemperatures();
  if (c == DEVICE_DISCONNECTED_C || c == WATER_TEMP_POWER_ON_C) return NAN;
  return c;
}

// Median rejects the spikes the high-impedance pH board picks up
static uint16_t readPhMv() {
  uint16_t s[PH_SAMPLES];
  for (uint8_t i = 0; i < PH_SAMPLES; i++) {
    s[i] = analogRead(PIN_PH);
    delay(PH_SAMPLE_GAP_MS);
  }
  for (uint8_t i = 1; i < PH_SAMPLES; i++) {
    uint16_t v = s[i];
    uint8_t j = i;
    for (; j > 0 && s[j - 1] > v; j--) s[j] = s[j - 1];
    s[j] = v;
  }
  return (uint32_t)s[PH_SAMPLES / 2] * ADC_REF_MV / ADC_MAX;
}

static void printField(const __FlashStringHelper* key, float v, uint8_t decimals) {
  Serial.print(F(",\""));
  Serial.print(key);
  Serial.print(F("\":"));
  // Serial.print renders inf as "inf", which would break the JSON line
  if (isnan(v) || isinf(v)) Serial.print(F("null"));
  else Serial.print(v, decimals);
}

// on[i]: channel i's light on. Logged only when it changes.
static void setLights(const bool* on) {
  static int8_t shown[LIGHT_CHANNELS] = {};  // 0 unknown, 1 on, -1 off
  bool changed = false;
  for (uint8_t i = 0; i < LIGHT_CHANNELS; i++) {
    digitalWrite(PIN_LIGHT_RELAY[i], on[i] ? !LIGHT_OFF_RELAY_STATE : LIGHT_OFF_RELAY_STATE);
    int8_t v = on[i] ? 1 : -1;
    if (shown[i] != v) changed = true;
    shown[i] = v;
  }
  if (!changed) return;
  Serial.print(F("# lights "));
  for (uint8_t i = 0; i < LIGHT_CHANNELS; i++) Serial.print(on[i] ? '1' : '0');
  Serial.println();
}

static void allLightsOn() {
  bool on[LIGHT_CHANNELS];
  for (uint8_t i = 0; i < LIGHT_CHANNELS; i++) on[i] = true;
  setLights(on);
}

// "lights 10": one '1' (on) or '0' (off) per channel, from channel 0. Channels
// past the end of the line stay on. Anything else is logged and ignored.
static void onInputLine(const char* line) {
  static const char PREFIX[] = "lights ";
  const uint8_t prefixLen = sizeof(PREFIX) - 1;
  uint8_t len = strlen(line);
  bool ok = strncmp(line, PREFIX, prefixLen) == 0 && len > prefixLen &&
            len - prefixLen <= LIGHT_CHANNELS;
  bool on[LIGHT_CHANNELS];
  for (uint8_t i = 0; ok && i < LIGHT_CHANNELS; i++) {
    char c = prefixLen + i < len ? line[prefixLen + i] : '1';
    ok = c == '0' || c == '1';
    on[i] = c == '1';
  }
  if (!ok) {
    Serial.print(F("# bad input: "));
    Serial.println(line);
    return;
  }
  setLights(on);
  lightsFromPi = true;
  lastLightsMs = millis();
}

// Never blocks: takes what has arrived and acts on each complete line
static void readInput() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (inputLen < MAX_INPUT_LINE) inputLine[inputLen++] = c;
      else inputTooLong = true;
      continue;
    }
    inputLine[inputLen] = '\0';
    if (inputTooLong) Serial.println(F("# bad input: line too long"));
    else if (inputLen > 0) onInputLine(inputLine);
    inputLen = 0;
    inputTooLong = false;
  }
}

static void report() {
  float airC = dht.readTemperature();
  float rh = dht.readHumidity();
  float lux = readLight();
  float waterC = readWaterTemp();
  bool levelOk = digitalRead(PIN_WATER_LEVEL) == WATER_LEVEL_OK_STATE;
  uint16_t phMv = readPhMv();

  noteHealth(F("dht11"), !isnan(airC) && !isnan(rh), airOk);
  noteHealth(F("bh1750"), !isnan(lux), lightOk);
  noteHealth(F("ds18b20"), !isnan(waterC), waterTempOk);

  // Field names match ShelfSensorData in @farm/shared where they overlap
  Serial.print(F("{\"seq\":"));
  Serial.print(seq++);
  printField(F("temperature_c"), airC, 1);
  printField(F("humidity_pct"), rh, 0);
  printField(F("light_lux"), lux, 0);
  printField(F("water_temp_c"), waterC, 2);
  Serial.print(F(",\"water_level_ok\":"));
  Serial.print(levelOk ? F("true") : F("false"));
  Serial.print(F(",\"ph_mv\":"));
  Serial.print(phMv);
  Serial.println('}');
}

void setup() {
  // A set WDRF keeps the watchdog armed after a watchdog reset; clear it
  // before the slow sensor setup below
  MCUSR = 0;
  wdt_disable();

  Serial.begin(SERIAL_BAUD);
  Serial.println(F("# shelf-sensor boot"));
  // Lights at full brightness until the Pi says otherwise, the same as with
  // no power: a reset or power cut never leaves a level dark
  for (uint8_t i = 0; i < LIGHT_CHANNELS; i++) pinMode(PIN_LIGHT_RELAY[i], OUTPUT);
  allLightsOn();

  pinMode(PIN_WATER_LEVEL, INPUT);
  dht.begin();
  Wire.begin();
  Wire.setWireTimeout(I2C_TIMEOUT_US, true);
  waterProbe.begin();
  waterProbe.setWaitForConversion(false);
  waterProbe.requestTemperatures();

  wdt_enable(WDTO_8S);
}

void loop() {
  wdt_reset();
  readInput();
  uint32_t now = millis();
  // The bridge stopped, or its port closed without resetting the Uno
  if (lightsFromPi && now - lastLightsMs > LIGHTS_TIMEOUT_MS) {
    Serial.println(F("# no lights line from the Pi, all lights on"));
    lightsFromPi = false;
    allLightsOn();
  }
  if (now - lastReportMs < REPORT_INTERVAL_MS) return;
  lastReportMs = now;
  report();
}
