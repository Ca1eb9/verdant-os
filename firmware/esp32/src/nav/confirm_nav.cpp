// confirm_nav.cpp
// See confirm_nav.h.

#include "confirm_nav.h"

#include "../config.h"

void ConfirmNav::on_edge(NodeIndex to, EdgeDrive drive, uint32_t now) {
  if (drive == EdgeDrive::Turn) {  // it faults: there's nothing to reach
    on_tag();
    return;
  }
  if (to != target_) since_ms_ = now;
  target_ = to;
  armed_ = drive == EdgeDrive::Forward || drive == EdgeDrive::Backward;
}

void ConfirmNav::update(bool driving_edge) {
  if (driving_edge && target_ != NO_NODE) armed_ = true;
}

void ConfirmNav::on_tag() {
  target_ = NO_NODE;
  armed_ = false;
}

NodeIndex ConfirmNav::reached(RobotStatus status, uint32_t now, const char** why) const {
  switch (status) {
    case RobotStatus::Initializing:
      return GRAPH_DOCK;  // set down there before it was turned on
    case RobotStatus::EnRoute:
    case RobotStatus::ReturningToDock:
    case RobotStatus::Stopped:
    case RobotStatus::Error:
    case RobotStatus::Manual:
      break;
    default:
      *why = "ignored: node_reached with no node to drive to";
      return NO_NODE;
  }
  if (target_ == NO_NODE) {
    *why = "ignored: node_reached with no node to drive to";
    return NO_NODE;
  }
  if (!armed_) {
    *why = "ignored: node_reached during the elevator ride";
    return NO_NODE;
  }
  // Signed: the edge may have started a few ms after this loop's `now`, at the
  // node_reached before this one in the same loop.
  if ((int32_t)(now - since_ms_) < (int32_t)CONFIRM_NAV_MIN_MS) {
    *why = "ignored: node_reached too soon after it set off for that node (a double tap?)";
    return NO_NODE;
  }
  return target_;
}
