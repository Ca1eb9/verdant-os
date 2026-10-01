// comms_task.h
// Communications task: WiFi + MQTT link to the Pi.
//
//   g_telemetry_queue (TelemetryMsg)  -> farm/robot/{id}/telemetry
//   g_event_queue     (RobotEventMsg) -> farm/robot/{id}/events
//   farm/robot/{id}/command           -> g_command_queue (Command)
//
// Queued events always go out before queued telemetry, so a status change
// never reaches the Pi ahead of the event that caused it.
//
// Lowest priority, pinned to core 0 next to the WiFi stack. Never calls
// delay(). A slow broker connect can stall this task for a few seconds,
// but never the motor, sensor or nav tasks.

#pragma once

void comms_task(void* param);
