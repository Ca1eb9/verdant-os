# firmware

Device firmware. Each folder is its own PlatformIO project: open that folder,
not this one.

```
firmware/
├── esp32/          # Robot (ESP32-S3, FreeRTOS)
└── shelf-sensor/   # Shelf sensor node and grow light relays (Arduino Uno R3)
```

| Board | Firmware | Wiring |
|---|---|---|
| Robot | [esp32/README.md](esp32/README.md) | [docs/wiring/robot.md](../docs/wiring/robot.md) |
| Shelf sensor node | [shelf-sensor/README.md](shelf-sensor/README.md) | [docs/wiring/shelf-sensor.md](../docs/wiring/shelf-sensor.md) |
