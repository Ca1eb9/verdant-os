// rfid_reader.h
// Thin wrapper so the sensor task doesn't care which RFID module is fitted.
// Select the module with RFID_READER_PN532 or RFID_READER_RC522 in config.h.

#pragma once

#include <stddef.h>

class RfidReader {
 public:
  // Initialises SPI and the reader. Returns false if the chip doesn't answer.
  bool begin();
  bool ok() const { return ok_; }

  // Checks for a tag. Blocks for at most RFID_READ_TIMEOUT_MS. On success
  // writes the canonical tag ID ("0x04A1B2C3") into `out` and returns true.
  bool poll(char* out, size_t cap);

 private:
  bool ok_ = false;
};
