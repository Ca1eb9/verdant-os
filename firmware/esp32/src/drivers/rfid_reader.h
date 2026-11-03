// rfid_reader.h
// Thin wrapper around the PN532 so the sensor task doesn't deal with the library.

#pragma once

#include <stddef.h>

class RfidReader {
 public:
  // Initialises SPI and the reader. Returns false if the chip doesn't answer.
  bool begin();
  bool ok() const { return ok_; }

  // Checks for a tag. Blocks for at most RFID_READ_TIMEOUT_MS. On success
  // writes the tag ID ("0x04A1B2C3") into `out` and returns true.
  bool poll(char* out, size_t cap);

  // A reader that reset (brownout, loose cable) answers "no tag" forever
  // until begin() runs again: false, and ok() false, if it doesn't answer.
  bool check();

 private:
  bool ok_ = false;
};
