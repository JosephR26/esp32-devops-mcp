/**
 * Built-in component profiles.
 *
 * Adding support for a new component means adding a profile object here (or
 * registering one at runtime with registerProfile). No tool handler, no
 * identification code and no test runner needs to change.
 */

import type { ComponentProfile } from '../../types/hardware.js';
import { PN532_PROFILE } from './pn532.js';
import {
  ADS1115_PROFILE,
  EEPROM_24CXX_PROFILE,
  MCP23017_PROFILE,
  MCP4725_PROFILE,
  MPU6050_PROFILE,
  SSD1306_PROFILE,
} from './i2c-devices.js';
import { MCP2515_PROFILE, NEO6M_PROFILE, NRF24L01_PROFILE } from './spi-uart-devices.js';

export const BUILT_IN_PROFILES: ComponentProfile[] = [
  // NFC / RFID
  PN532_PROFILE,
  // Sensors
  MPU6050_PROFILE,
  // ADC / DAC
  ADS1115_PROFILE,
  MCP4725_PROFILE,
  // GPIO expansion
  MCP23017_PROFILE,
  // Displays
  SSD1306_PROFILE,
  // Memory
  EEPROM_24CXX_PROFILE,
  // Radio modules
  NRF24L01_PROFILE,
  // CAN controllers
  MCP2515_PROFILE,
  // GNSS receivers
  NEO6M_PROFILE,
];

export {
  PN532_PROFILE,
  MPU6050_PROFILE,
  ADS1115_PROFILE,
  MCP4725_PROFILE,
  MCP23017_PROFILE,
  SSD1306_PROFILE,
  EEPROM_24CXX_PROFILE,
  NRF24L01_PROFILE,
  MCP2515_PROFILE,
  NEO6M_PROFILE,
};
