// pad_task.h
// Controller task: the Xbox Wireless Controller paired with this robot over
// Bluetooth LE (README "Bluetooth controller").
//
//   left stick / B / A  ->  g_command_queue (Command: jog / stop / resume)
//
// It puts the same commands on the queue as the comms task does for the
// dashboard, so nav treats both alike.
//
// A held stick sends no reports, and a controller that dies takes about 3 s
// to show as disconnected. So every cycle the task first reads the
// controller's battery level: an answer proves the link is alive, and only
// then is the stick acted on. With no answer no jog is sent, and the robot
// stops when its last jog pulse runs out.
//
// Lowest priority, core 0 with the WiFi stack (they share one radio).

#pragma once

void pad_task(void* param);
