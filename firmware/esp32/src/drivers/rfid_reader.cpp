// rfid_reader.cpp

#include "rfid_reader.h"

#include <Arduino.h>
#include <SPI.h>

#include "../comms/comms_json.h"  // format_tag_uid()
#include "../config.h"
#include "../log.h"

// Log a missing reader once, not on every 5 s retry.
static bool s_fail_logged = false;

#if defined(RFID_READER_PN532)
// ---- Adafruit PN532 over hardware SPI ---------------------------------------
// Set the breakout's SEL0/SEL1 jumpers to SPI mode.
#include <Adafruit_PN532.h>

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

#elif defined(RFID_READER_RC522)
// ---- MFRC522 (RC522) over hardware SPI ---------------------------------------
#include <MFRC522.h>

static MFRC522 s_rc522(PIN_RFID_SS, PIN_RFID_RST);

bool RfidReader::begin() {
  SPI.begin(PIN_SPI_SCK, PIN_SPI_MISO, PIN_SPI_MOSI, PIN_RFID_SS);
  s_rc522.PCD_Init();
  byte v = s_rc522.PCD_ReadRegister(MFRC522::VersionReg);
  if (v == 0x00 || v == 0xFF) {
    if (!s_fail_logged) LOG("rfid", "RC522 not found (VersionReg 0x%02X); retrying quietly", v);
    s_fail_logged = true;
    ok_ = false;
    return false;
  }
  s_fail_logged = false;
  LOG("rfid", "RC522 version 0x%02X", v);
  ok_ = true;
  return true;
}

bool RfidReader::poll(char* out, size_t cap) {
  if (!ok_) return false;
  // WUPA wakes cards in HALT too, so a tag sitting under the reader is seen
  // on every poll. PICC_IsNewCardPresent() alternates true/false for a
  // tag that stays in the field.
  byte atqa[2];
  byte atqa_size = sizeof(atqa);
  MFRC522::StatusCode st = s_rc522.PICC_WakeupA(atqa, &atqa_size);
  if (st != MFRC522::STATUS_OK && st != MFRC522::STATUS_COLLISION) return false;
  if (!s_rc522.PICC_ReadCardSerial()) return false;
  bool ok = format_tag_uid(s_rc522.uid.uidByte, s_rc522.uid.size, out, cap);
  s_rc522.PICC_HaltA();
  return ok;
}

#else
#error "Define RFID_READER_PN532 or RFID_READER_RC522 in config.h"
#endif
