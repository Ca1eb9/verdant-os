// pad_task.h
// Controller task: the Xbox Wireless Controller paired with this robot over
// Bluetooth LE (README "Bluetooth controller").
//
//   left stick / B / A  ->  g_command_queue (Command: drive / stop / resume)
//
// Stop and resume are the commands the comms task queues for the dashboard,
// so nav treats both alike. The stick's drive is a jog at a speed, which only
// the controller sends.
//
// A held stick sends no reports, and a controller that dies takes about 3 s
// to show as disconnected. So every cycle the task first reads the
// controller's battery level: an answer proves the link is alive, and only
// then is the stick acted on. With no answer no drive is sent, and the robot
// stops when its last drive pulse runs out.
//
// Lowest priority, core 0 with the WiFi stack (they share one radio).

#pragma once

void pad_task(void* param);
