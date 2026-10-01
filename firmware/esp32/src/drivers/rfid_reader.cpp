// rfid_reader.cpp

#include "rfid_reader.h"

#include <Adafruit_PN532.h>
#include <Arduino.h>
#include <SPI.h>

#include "../comms/comms_json.h"  // format_tag_uid()
#include "../config.h"
#include "../log.h"

// Log a missing reader once, not on every 5 s retry.
static bool s_fail_logged = false;

// PN532 over hardware SPI. Set the breakout's SEL0/SEL1 jumpers to SPI mode.
static Adafruit_PN532 s_nfc(PIN_RFID_SS, &SPI);

bool RfidReader::begin() {
  SPI.begin(PIN_SPI_SCK, PIN_SPI_MISO, PIN_SPI_MOSI, PIN_RFID_SS);
  s_nfc.begin();
  uint32_t ver = s_nfc.getFirmwareVersion();
  if (!ver) {
    if (!s_fail_logged) LOG("rfid", "PN532 not found (check wiring + SPI jumpers); retrying quietly");
    s_fail_logged = true;
    ok_ = false;
    return false;
  }
  LOG("rfid", "PN532 firmware %lu.%lu", (unsigned long)(ver >> 16) & 0xFF,
      (unsigned long)(ver >> 8) & 0xFF);
  // One activation attempt per poll, so an empty field returns quickly.
  s_fail_logged = false;
  s_nfc.setPassiveActivationRetries(0x01);
  s_nfc.SAMConfig();
  ok_ = true;
  return true;
}

bool RfidReader::poll(char* out, size_t cap) {
  if (!ok_) return false;
  uint8_t uid[10];
  uint8_t uid_len = 0;
  if (!s_nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uid_len, RFID_READ_TIMEOUT_MS))
    return false;
  return format_tag_uid(uid, uid_len, out, cap);
}

