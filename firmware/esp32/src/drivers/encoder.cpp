// encoder.cpp
// See encoder.h.

#include "encoder.h"

#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/pcnt.h>

#include "../config.h"
#include "../log.h"

namespace {

constexpr pcnt_unit_t UNIT = PCNT_UNIT_0;
// The counter goes back to 0 on reaching +-LIMIT, so it holds the position
// modulo LIMIT: encoder_take_counts() unwraps it, which holds while under
// LIMIT / 2 counts (~2 s at full speed) pass between calls.
constexpr int16_t LIMIT = INT16_MAX;

int16_t s_last = 0;

}  // namespace

bool encoder_begin() {
  // x4 quadrature: each channel counts both edges of one signal, the other
  // signal's level giving the direction.
  pcnt_config_t c = {};
  c.pulse_gpio_num = PIN_ENCODER_A;
  c.ctrl_gpio_num = PIN_ENCODER_B;
  c.channel = PCNT_CHANNEL_0;
  c.unit = UNIT;
  c.pos_mode = PCNT_COUNT_DEC;
  c.neg_mode = PCNT_COUNT_INC;
  c.lctrl_mode = PCNT_MODE_REVERSE;
  c.hctrl_mode = PCNT_MODE_KEEP;
  c.counter_h_lim = LIMIT;
  c.counter_l_lim = -LIMIT;
  esp_err_t err = pcnt_unit_config(&c);
  if (err == ESP_OK) {
    c.pulse_gpio_num = PIN_ENCODER_B;
    c.ctrl_gpio_num = PIN_ENCODER_A;
    c.channel = PCNT_CHANNEL_1;
    c.pos_mode = PCNT_COUNT_INC;
    c.neg_mode = PCNT_COUNT_DEC;
    err = pcnt_unit_config(&c);
  }
  if (err == ESP_OK) err = pcnt_set_filter_value(UNIT, ENCODER_FILTER_CYCLES);
  if (err == ESP_OK) err = pcnt_filter_enable(UNIT);
  if (err != ESP_OK) {
    LOG("enc", "PCNT setup failed (%s): no encoder assist", esp_err_to_name(err));
    return false;
  }
  // PCNT turns the pull-ups on. Pull down instead: an unplugged encoder
  // then reads a steady low (no counts) rather than floating.
  gpio_set_pull_mode((gpio_num_t)PIN_ENCODER_A, GPIO_PULLDOWN_ONLY);
  gpio_set_pull_mode((gpio_num_t)PIN_ENCODER_B, GPIO_PULLDOWN_ONLY);
  pcnt_counter_pause(UNIT);
  pcnt_counter_clear(UNIT);
  pcnt_counter_resume(UNIT);
  s_last = 0;
  LOG("enc", "counting on GPIO %d / %d", PIN_ENCODER_A, PIN_ENCODER_B);
  return true;
}

int32_t encoder_take_counts() {
  int16_t count = 0;
  if (pcnt_get_counter_value(UNIT, &count) != ESP_OK) return 0;
  int32_t d = (int32_t)count - s_last;
  s_last = count;
  if (d > LIMIT / 2) d -= LIMIT;
  else if (d < -LIMIT / 2) d += LIMIT;
  return d;
}
