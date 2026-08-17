/**
 * I2C component profiles.
 *
 * These exist to prove the architecture is generic: a motion sensor, an ADC, a
 * DAC, a GPIO expander, an OLED display and a plain EEPROM all describe
 * themselves through the same profile shape that the PN532 uses, and the engine
 * treats them identically.
 */

import type { ComponentProfile } from '../../types/hardware.js';

// ---------------------------------------------------------------------------
// InvenSense MPU-6050 — 6-axis IMU (sensor)
// ---------------------------------------------------------------------------

export const MPU6050_PROFILE: ComponentProfile = {
  id: 'mpu6050',
  manufacturer: 'InvenSense / TDK',
  partNumber: 'MPU-6050',
  aliases: ['mpu6050', 'gy-521'],
  description: '6-axis MEMS motion tracking device: 3-axis gyroscope, 3-axis accelerometer, on-chip temperature sensor and DMP.',

  interfaces: [
    {
      kind: 'I2C',
      addresses: [0x68, 0x69],
      defaultClockHz: 400000,
      signals: ['SDA', 'SCL', 'INT', 'AD0'],
      note: 'AD0 low selects 0x68, AD0 high selects 0x69.',
    },
  ],

  identification: [
    {
      id: 'mpu6050.address',
      description: 'Responds at I2C address 0x68 or 0x69',
      weight: 0.2,
      match: { kind: 'I2C_ADDRESS', addresses: [0x68, 0x69] },
    },
    {
      id: 'mpu6050.whoami',
      description: 'WHO_AM_I (0x75) reads back 0x68',
      weight: 0.8,
      necessary: true,
      match: { kind: 'PROBE_RESPONSE', probeId: 'mpu6050.who_am_i', pattern: '68' },
      reference: 'MPU-6000/6050 Register Map RM-MPU-6000A §4.32',
    },
  ],

  registers: [
    {
      address: 0x75,
      name: 'WHO_AM_I',
      description: 'Device identity: bits 6:1 of the I2C address, fixed at 0x34 (value 0x68)',
      width: 8,
      access: 'R',
      resetValue: 0x68,
      fields: [{ name: 'WHOAMI', bitOffset: 1, bitWidth: 6, description: 'Upper 6 bits of the device address' }],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.32',
    },
    {
      address: 0x6b,
      name: 'PWR_MGMT_1',
      description: 'Power management and clock source selection',
      width: 8,
      access: 'RW',
      resetValue: 0x40,
      fields: [
        {
          name: 'CLKSEL',
          bitOffset: 0,
          bitWidth: 3,
          enumerations: {
            '0': 'Internal 8 MHz oscillator',
            '1': 'PLL with X-axis gyro reference',
            '2': 'PLL with Y-axis gyro reference',
            '3': 'PLL with Z-axis gyro reference',
            '7': 'Clock stopped',
          },
        },
        { name: 'TEMP_DIS', bitOffset: 3, bitWidth: 1, description: 'Temperature sensor disabled' },
        { name: 'CYCLE', bitOffset: 5, bitWidth: 1, description: 'Cycled wake-up sampling' },
        { name: 'SLEEP', bitOffset: 6, bitWidth: 1, description: 'Sleep mode', enumerations: { '0': 'Awake', '1': 'Asleep' } },
        { name: 'DEVICE_RESET', bitOffset: 7, bitWidth: 1, description: 'Reset trigger (write-only in effect)' },
      ],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.28',
    },
    {
      address: 0x1b,
      name: 'GYRO_CONFIG',
      description: 'Gyroscope full-scale range and self-test enables',
      width: 8,
      access: 'RW',
      resetValue: 0x00,
      fields: [
        {
          name: 'FS_SEL',
          bitOffset: 3,
          bitWidth: 2,
          enumerations: { '0': '±250 °/s', '1': '±500 °/s', '2': '±1000 °/s', '3': '±2000 °/s' },
        },
        { name: 'ZG_ST', bitOffset: 5, bitWidth: 1, description: 'Z-axis self-test' },
        { name: 'YG_ST', bitOffset: 6, bitWidth: 1, description: 'Y-axis self-test' },
        { name: 'XG_ST', bitOffset: 7, bitWidth: 1, description: 'X-axis self-test' },
      ],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.4',
    },
    {
      address: 0x1c,
      name: 'ACCEL_CONFIG',
      description: 'Accelerometer full-scale range and self-test enables',
      width: 8,
      access: 'RW',
      resetValue: 0x00,
      fields: [
        { name: 'AFS_SEL', bitOffset: 3, bitWidth: 2, enumerations: { '0': '±2 g', '1': '±4 g', '2': '±8 g', '3': '±16 g' } },
        { name: 'ZA_ST', bitOffset: 5, bitWidth: 1 },
        { name: 'YA_ST', bitOffset: 6, bitWidth: 1 },
        { name: 'XA_ST', bitOffset: 7, bitWidth: 1 },
      ],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.5',
    },
    {
      address: 0x3b,
      name: 'ACCEL_XOUT',
      description: 'Most recent accelerometer X measurement (16-bit signed)',
      width: 16,
      access: 'R',
      fields: [{ name: 'ACCEL_XOUT', bitOffset: 0, bitWidth: 16 }],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.17',
    },
    {
      address: 0x41,
      name: 'TEMP_OUT',
      description: 'On-chip temperature (16-bit signed; °C = value/340 + 36.53)',
      width: 16,
      access: 'R',
      fields: [{ name: 'TEMP_OUT', bitOffset: 0, bitWidth: 16 }],
      safeToRead: true,
      reference: 'RM-MPU-6000A §4.18',
    },
    {
      address: 0x3a,
      name: 'INT_STATUS',
      description: 'Interrupt status — cleared on read',
      width: 8,
      access: 'R',
      fields: [
        { name: 'DATA_RDY_INT', bitOffset: 0, bitWidth: 1 },
        { name: 'I2C_MST_INT', bitOffset: 3, bitWidth: 1 },
        { name: 'FIFO_OFLOW_INT', bitOffset: 4, bitWidth: 1 },
      ],
      safeToRead: true,
      readHasSideEffects: true,
      reference: 'RM-MPU-6000A §4.16',
    },
  ],

  protocols: [{ name: 'I2C register file', description: 'Flat 8-bit register map addressed by a single pointer byte.' }],

  modes: [
    { name: 'Sleep', description: 'Low-power state entered via PWR_MGMT_1.SLEEP', reference: 'RM-MPU-6000A §4.28' },
    { name: 'Cycle (low-power accelerometer)', description: 'Periodic wake-and-sample', reference: 'RM-MPU-6000A §4.28' },
    { name: 'Normal measurement', description: 'Continuous gyro + accel sampling' },
    { name: 'DMP', description: 'On-chip digital motion processor', entryNote: 'Requires uploading InvenSense firmware; not exercised by interrogation.' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['mpu6050.who_am_i'] },
    { name: 'identification.who_am_i', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, evidenceProbes: ['mpu6050.who_am_i'], reference: 'RM-MPU-6000A §4.32' },
    { name: 'measurement.accelerometer', category: 'MEASUREMENT', documented: true, softwareSupported: true, evidenceProbes: ['mpu6050.read_accel'] },
    { name: 'measurement.gyroscope', category: 'MEASUREMENT', documented: true, softwareSupported: true },
    { name: 'measurement.temperature', category: 'MEASUREMENT', documented: true, softwareSupported: true, evidenceProbes: ['mpu6050.read_temp'] },
    { name: 'feature.fifo', category: 'FEATURE', documented: true, softwareSupported: true },
    { name: 'feature.dmp', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Digital motion processor — requires proprietary firmware upload' },
    { name: 'feature.interrupt', category: 'FEATURE', documented: true, softwareSupported: true },
    { name: 'feature.i2c_master_passthrough', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Auxiliary I2C master for an external magnetometer' },
    { name: 'power.sleep_mode', category: 'POWER', documented: true, softwareSupported: true },
  ],

  safeProbes: [
    {
      id: 'mpu6050.who_am_i',
      name: 'Read WHO_AM_I',
      description: 'Reads the identity register at 0x75.',
      interface: 'I2C',
      justification: 'Read-only identity register with no side effects.',
      writes: true,
      writeJustification: 'An I2C register read requires writing the one-byte register pointer first; no register content is modified.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x68, write: [0x75], readLength: 1 }],
      expect: { pattern: '68', minBytes: 1 },
      yields: ['device identity'],
      minDepth: 'BASIC',
      reference: 'RM-MPU-6000A §4.32',
    },
    {
      id: 'mpu6050.read_config',
      name: 'Read power and range configuration',
      description: 'Reads PWR_MGMT_1, GYRO_CONFIG and ACCEL_CONFIG.',
      interface: 'I2C',
      justification: 'Configuration inspection; all three registers are free of read side effects.',
      writes: true,
      writeJustification: 'Register pointer write required to address the read.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: 0x68, write: [0x1b], readLength: 2 },
        { op: 'I2C_WRITE_READ', address: 0x68, write: [0x6b], readLength: 1 },
      ],
      expect: { minBytes: 3 },
      yields: ['full-scale ranges', 'clock source', 'sleep state'],
      minDepth: 'STANDARD',
    },
    {
      id: 'mpu6050.read_accel',
      name: 'Read accelerometer burst',
      description: 'Burst-reads the six accelerometer output bytes from 0x3B.',
      interface: 'I2C',
      justification: 'Measurement registers are read-only and have no read side effects.',
      writes: true,
      writeJustification: 'Register pointer write required to address the burst read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x68, write: [0x3b], readLength: 6 }],
      expect: { minBytes: 6 },
      yields: ['accelerometer X/Y/Z'],
      minDepth: 'STANDARD',
    },
    {
      id: 'mpu6050.read_temp',
      name: 'Read temperature',
      description: 'Reads the 16-bit on-chip temperature output.',
      interface: 'I2C',
      justification: 'Read-only measurement register.',
      writes: true,
      writeJustification: 'Register pointer write required to address the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x68, write: [0x41], readLength: 2 }],
      expect: { minBytes: 2 },
      yields: ['die temperature'],
      minDepth: 'STANDARD',
    },
  ],

  functionalTests: [
    {
      id: 'mpu6050.test.identity',
      name: 'WHO_AM_I identity',
      capability: 'identification.who_am_i',
      objective: 'Confirm the device reports the documented identity value.',
      procedure: ['Read register 0x75.', 'Assert the value is 0x68.'],
      expectedResult: '0x68',
      probes: ['mpu6050.who_am_i'],
      expectPattern: '68',
      minDepth: 'BASIC',
    },
    {
      id: 'mpu6050.test.accel_read',
      name: 'Accelerometer measurement',
      capability: 'measurement.accelerometer',
      objective: 'Confirm six accelerometer bytes are returned.',
      procedure: ['Burst-read 6 bytes from 0x3B.', 'Assert 6 bytes were received.'],
      expectedResult: 'Six bytes of signed 16-bit X/Y/Z data.',
      probes: ['mpu6050.read_accel'],
      expectMinBytes: 6,
      minDepth: 'STANDARD',
    },
    {
      id: 'mpu6050.test.temperature',
      name: 'Temperature measurement',
      capability: 'measurement.temperature',
      objective: 'Confirm the temperature register returns two bytes.',
      procedure: ['Read 2 bytes from 0x41.'],
      expectedResult: 'Two-byte signed temperature value.',
      probes: ['mpu6050.read_temp'],
      expectMinBytes: 2,
      minDepth: 'STANDARD',
    },
  ],

  benchmarks: [
    { id: 'mpu6050.bench.accel_latency', name: 'Accelerometer burst-read latency', metric: 'RESPONSE_LATENCY', probeId: 'mpu6050.read_accel', iterations: 30, unit: 'ms' },
    { id: 'mpu6050.bench.sample_rate', name: 'Sustained accelerometer polling rate', metric: 'POLLING_RATE', probeId: 'mpu6050.read_accel', iterations: 50, documentedValue: 1000, unit: 'reads/s', reference: 'Datasheet gyro output rate up to 8 kHz; accel up to 1 kHz' },
    { id: 'mpu6050.bench.identity_consistency', name: 'WHO_AM_I consistency', metric: 'READ_CONSISTENCY', probeId: 'mpu6050.who_am_i', iterations: 20, unit: 'agreement ratio' },
  ],

  limitations: [
    'WHO_AM_I returns 0x68 regardless of the AD0 strap, so it does not distinguish the two possible bus addresses.',
    'Several MPU-6050 clones return the correct WHO_AM_I but differ in noise and DMP behaviour.',
    'INT_STATUS clears on read and is excluded from automated register inspection.',
    'DMP operation requires an undocumented firmware blob and is out of scope for interrogation.',
  ],

  documentation: [
    { title: 'MPU-6000/MPU-6050 Register Map and Descriptions', section: 'RM-MPU-6000A-00' },
    { title: 'MPU-6000/MPU-6050 Product Specification', section: 'PS-MPU-6000A-00' },
  ],

  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// Texas Instruments ADS1115 — 16-bit ADC
// ---------------------------------------------------------------------------

export const ADS1115_PROFILE: ComponentProfile = {
  id: 'ads1115',
  manufacturer: 'Texas Instruments',
  partNumber: 'ADS1115',
  aliases: ['ads1113', 'ads1114', 'ads111x'],
  description: '16-bit delta-sigma ADC with programmable gain amplifier, four single-ended or two differential inputs, and a comparator.',

  interfaces: [
    {
      kind: 'I2C',
      addresses: [0x48, 0x49, 0x4a, 0x4b],
      defaultClockHz: 400000,
      signals: ['SDA', 'SCL', 'ADDR', 'ALERT/RDY'],
      note: 'The ADDR pin selects the address: GND=0x48, VDD=0x49, SDA=0x4A, SCL=0x4B.',
    },
  ],

  identification: [
    { id: 'ads1115.address', description: 'Responds at one of the four ADDR-selected addresses', weight: 0.2, match: { kind: 'I2C_ADDRESS', addresses: [0x48, 0x49, 0x4a, 0x4b] } },
    {
      id: 'ads1115.config-default',
      description: 'Config register (0x01) reads back the documented reset value 0x8583',
      weight: 0.7,
      match: { kind: 'PROBE_RESPONSE', probeId: 'ads1115.read_config', pattern: '85 83' },
      reference: 'ADS111x datasheet SBAS444 §8.6.3',
    },
  ],

  registers: [
    {
      address: 0x00,
      name: 'CONVERSION',
      description: 'Last completed conversion result (16-bit two\'s complement)',
      width: 16,
      access: 'R',
      resetValue: 0x0000,
      fields: [{ name: 'RESULT', bitOffset: 0, bitWidth: 16 }],
      safeToRead: true,
      reference: 'SBAS444 §8.6.2',
    },
    {
      address: 0x01,
      name: 'CONFIG',
      description: 'Operating mode, input multiplexer, PGA range, data rate and comparator setup',
      width: 16,
      access: 'RW',
      resetValue: 0x8583,
      fields: [
        { name: 'COMP_QUE', bitOffset: 0, bitWidth: 2, enumerations: { '0': 'Assert after 1 conversion', '1': 'After 2', '2': 'After 4', '3': 'Comparator disabled' } },
        { name: 'COMP_LAT', bitOffset: 2, bitWidth: 1, description: 'Latching comparator' },
        { name: 'COMP_POL', bitOffset: 3, bitWidth: 1, description: 'ALERT/RDY polarity' },
        { name: 'COMP_MODE', bitOffset: 4, bitWidth: 1, enumerations: { '0': 'Traditional', '1': 'Window' } },
        { name: 'DR', bitOffset: 5, bitWidth: 3, enumerations: { '0': '8 SPS', '1': '16 SPS', '2': '32 SPS', '3': '64 SPS', '4': '128 SPS', '5': '250 SPS', '6': '475 SPS', '7': '860 SPS' } },
        { name: 'MODE', bitOffset: 8, bitWidth: 1, enumerations: { '0': 'Continuous conversion', '1': 'Single-shot / power-down' } },
        { name: 'PGA', bitOffset: 9, bitWidth: 3, enumerations: { '0': '±6.144 V', '1': '±4.096 V', '2': '±2.048 V', '3': '±1.024 V', '4': '±0.512 V', '5': '±0.256 V' } },
        { name: 'MUX', bitOffset: 12, bitWidth: 3, enumerations: { '0': 'AIN0-AIN1', '1': 'AIN0-AIN3', '2': 'AIN1-AIN3', '3': 'AIN2-AIN3', '4': 'AIN0-GND', '5': 'AIN1-GND', '6': 'AIN2-GND', '7': 'AIN3-GND' } },
        { name: 'OS', bitOffset: 15, bitWidth: 1, description: 'Operational status / single-shot start', enumerations: { '0': 'Conversion in progress', '1': 'Not converting' } },
      ],
      safeToRead: true,
      reference: 'SBAS444 §8.6.3',
    },
    { address: 0x02, name: 'LO_THRESH', description: 'Comparator low threshold', width: 16, access: 'RW', resetValue: 0x8000, fields: [{ name: 'LO_THRESH', bitOffset: 0, bitWidth: 16 }], safeToRead: true, reference: 'SBAS444 §8.6.4' },
    { address: 0x03, name: 'HI_THRESH', description: 'Comparator high threshold', width: 16, access: 'RW', resetValue: 0x7fff, fields: [{ name: 'HI_THRESH', bitOffset: 0, bitWidth: 16 }], safeToRead: true, reference: 'SBAS444 §8.6.5' },
  ],

  protocols: [{ name: 'I2C register file', description: 'Four 16-bit registers selected by a pointer byte.' }],

  modes: [
    { name: 'Continuous conversion', description: 'Free-running conversions at the configured data rate' },
    { name: 'Single-shot', description: 'One conversion per trigger, then power-down' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['ads1115.read_config'] },
    { name: 'measurement.adc_single_ended', category: 'MEASUREMENT', documented: true, softwareSupported: true, description: 'Four single-ended channels' },
    { name: 'measurement.adc_differential', category: 'MEASUREMENT', documented: true, softwareSupported: true, description: 'Two differential pairs' },
    { name: 'feature.pga', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Programmable gain amplifier, ±6.144 V to ±0.256 V' },
    { name: 'feature.comparator', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Traditional and window comparator with ALERT/RDY output' },
    { name: 'feature.data_rate_selection', category: 'FEATURE', documented: true, softwareSupported: true, description: '8 to 860 samples per second' },
    { name: 'power.single_shot', category: 'POWER', documented: true, softwareSupported: true, description: 'Auto power-down between single-shot conversions' },
  ],

  safeProbes: [
    {
      id: 'ads1115.read_config',
      name: 'Read CONFIG register',
      description: 'Reads the 16-bit configuration register.',
      interface: 'I2C',
      justification: 'Configuration read with no side effects.',
      writes: true,
      writeJustification: 'Pointer-register write required to select CONFIG before the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x48, write: [0x01], readLength: 2 }],
      expect: { minBytes: 2 },
      yields: ['gain', 'data rate', 'mode', 'mux selection'],
      minDepth: 'BASIC',
      reference: 'SBAS444 §8.6.3',
    },
    {
      id: 'ads1115.read_conversion',
      name: 'Read CONVERSION register',
      description: 'Reads the most recent conversion result without starting a new one.',
      interface: 'I2C',
      justification: 'Read-only result register; reading does not trigger a conversion.',
      writes: true,
      writeJustification: 'Pointer-register write required to select CONVERSION before the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x48, write: [0x00], readLength: 2 }],
      expect: { minBytes: 2 },
      yields: ['last conversion result'],
      minDepth: 'STANDARD',
    },
    {
      id: 'ads1115.read_thresholds',
      name: 'Read comparator thresholds',
      description: 'Reads LO_THRESH and HI_THRESH.',
      interface: 'I2C',
      justification: 'Configuration read with no side effects.',
      writes: true,
      writeJustification: 'Pointer-register writes required to select each threshold register.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: 0x48, write: [0x02], readLength: 2 },
        { op: 'I2C_WRITE_READ', address: 0x48, write: [0x03], readLength: 2 },
      ],
      expect: { minBytes: 4 },
      yields: ['comparator thresholds'],
      minDepth: 'DEEP',
    },
  ],

  functionalTests: [
    {
      id: 'ads1115.test.config_read',
      name: 'Configuration readback',
      capability: 'interface.i2c',
      objective: 'Confirm the configuration register can be read.',
      procedure: ['Select CONFIG.', 'Read two bytes.'],
      expectedResult: 'Two bytes; 0x8583 on a freshly reset device.',
      probes: ['ads1115.read_config'],
      expectMinBytes: 2,
      minDepth: 'BASIC',
    },
    {
      id: 'ads1115.test.conversion_read',
      name: 'Conversion result readback',
      capability: 'measurement.adc_single_ended',
      objective: 'Confirm a conversion result can be read.',
      procedure: ['Select CONVERSION.', 'Read two bytes.'],
      expectedResult: 'Two-byte signed conversion result.',
      probes: ['ads1115.read_conversion'],
      expectMinBytes: 2,
      minDepth: 'STANDARD',
    },
  ],

  benchmarks: [
    { id: 'ads1115.bench.conversion_latency', name: 'Conversion register read latency', metric: 'RESPONSE_LATENCY', probeId: 'ads1115.read_conversion', iterations: 30, unit: 'ms' },
    { id: 'ads1115.bench.sample_rate', name: 'Sustained read rate', metric: 'POLLING_RATE', probeId: 'ads1115.read_conversion', iterations: 40, documentedValue: 860, unit: 'reads/s', reference: 'Datasheet maximum data rate 860 SPS' },
  ],

  limitations: [
    'The CONFIG reset value only identifies a device that has not been reconfigured since power-up.',
    'ADS1113 and ADS1114 share the register map; the identification cannot distinguish them over the bus.',
    'Reading CONVERSION does not itself trigger a conversion in single-shot mode.',
  ],

  documentation: [{ title: 'ADS111x Ultra-Small, Low-Power, 16-Bit ADC', section: 'SBAS444' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// Microchip MCP4725 — 12-bit DAC
// ---------------------------------------------------------------------------

export const MCP4725_PROFILE: ComponentProfile = {
  id: 'mcp4725',
  manufacturer: 'Microchip Technology',
  partNumber: 'MCP4725',
  aliases: ['mcp4725a0', 'mcp4725a1'],
  description: '12-bit single-channel digital-to-analog converter with non-volatile EEPROM storage of the output setting.',

  interfaces: [
    { kind: 'I2C', addresses: [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67], defaultClockHz: 400000, signals: ['SDA', 'SCL', 'A0'], note: 'Base address is set by the A0 pin and the factory address-code variant.' },
  ],

  identification: [
    { id: 'mcp4725.address', description: 'Responds in the 0x60-0x67 DAC address block', weight: 0.2, match: { kind: 'I2C_ADDRESS', addresses: [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67] } },
    // A plain read returns five bytes whose values are entirely device state,
    // with no fixed signature to match against. There is deliberately no
    // response-based rule here: inventing one that matches any 5-byte reply
    // would manufacture confidence out of nothing.
  ],

  registers: [
    {
      address: 'STATUS',
      name: 'STATUS (read byte 0)',
      description: 'Ready flag, power-down mode and EEPROM write status',
      width: 8,
      access: 'R',
      fields: [
        { name: 'PD', bitOffset: 1, bitWidth: 2, enumerations: { '0': 'Normal', '1': '1 kΩ to ground', '2': '100 kΩ to ground', '3': '500 kΩ to ground' } },
        { name: 'POR', bitOffset: 6, bitWidth: 1, description: 'Power-on-reset state' },
        { name: 'RDY', bitOffset: 7, bitWidth: 1, description: 'EEPROM write complete', enumerations: { '0': 'EEPROM write in progress', '1': 'Ready' } },
      ],
      safeToRead: true,
      responseOffset: 0,
      readProbeId: 'mcp4725.read_status',
      reference: 'DS22039 §6.2',
    },
  ],

  protocols: [{ name: 'MCP4725 read block', description: 'A plain read returns status, DAC register (2 bytes) and EEPROM contents (2 bytes).' }],
  modes: [
    { name: 'Normal', description: 'DAC output active' },
    { name: 'Power-down (1k/100k/500k)', description: 'Output disconnected through the selected resistance', entryNote: 'Entered by a write command; interrogation never writes the DAC.' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['mcp4725.read_status'] },
    { name: 'measurement.dac_output', category: 'MEASUREMENT', documented: true, softwareSupported: true, description: '12-bit voltage output' },
    { name: 'feature.eeprom_persistence', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Output value survives power cycling' },
    { name: 'power.power_down_modes', category: 'POWER', documented: true, softwareSupported: true, description: 'Three selectable pull-down resistances' },
    { name: 'diagnostic.status_readback', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, evidenceProbes: ['mcp4725.read_status'] },
  ],

  safeProbes: [
    {
      id: 'mcp4725.read_status',
      name: 'Read status block',
      description: 'Reads the 5-byte status/DAC/EEPROM block.',
      interface: 'I2C',
      justification: 'A plain I2C read. No command byte is written and the DAC output is not altered.',
      writes: false,
      reversible: true,
      operations: [{ op: 'I2C_READ', address: 0x60, length: 5 }],
      expect: { minBytes: 5 },
      yields: ['ready flag', 'power-down mode', 'current DAC value', 'stored EEPROM value'],
      minDepth: 'BASIC',
      reference: 'DS22039 §6.2',
    },
  ],

  functionalTests: [
    {
      id: 'mcp4725.test.status_read',
      name: 'Status block readback',
      capability: 'diagnostic.status_readback',
      objective: 'Confirm the device returns its 5-byte status block.',
      procedure: ['Read 5 bytes from the device address.'],
      expectedResult: 'Five bytes: status, DAC high/low, EEPROM high/low.',
      probes: ['mcp4725.read_status'],
      expectMinBytes: 5,
      minDepth: 'BASIC',
    },
  ],

  benchmarks: [{ id: 'mcp4725.bench.status_latency', name: 'Status read latency', metric: 'RESPONSE_LATENCY', probeId: 'mcp4725.read_status', iterations: 25, unit: 'ms' }],

  limitations: [
    'The DAC output value cannot be verified over the bus alone — confirming it needs an external voltage measurement.',
    'This profile declares no EEPROM write probe. Writing the non-volatile setting is out of scope for interrogation.',
    'Address alone cannot distinguish an MCP4725 from other devices in the 0x60-0x67 range.',
    'No bus response identifies this part: the readable bytes are pure device state with no ' +
      'fixed signature. Expect LOW identification confidence and confirm by markings.',
  ],

  documentation: [{ title: 'MCP4725 12-Bit DAC with EEPROM Memory', section: 'DS22039' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// Microchip MCP23017 — 16-bit I2C GPIO expander
// ---------------------------------------------------------------------------

export const MCP23017_PROFILE: ComponentProfile = {
  id: 'mcp23017',
  manufacturer: 'Microchip Technology',
  partNumber: 'MCP23017',
  aliases: ['mcp23s17', 'mcp23017-e/sp'],
  description: '16-bit bidirectional I/O expander with interrupt output, configurable via a paired 8-bit register bank.',

  interfaces: [
    { kind: 'I2C', addresses: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27], defaultClockHz: 400000, signals: ['SDA', 'SCL', 'INTA', 'INTB', 'RESET'], note: 'A2/A1/A0 select one of eight addresses in the 0x20-0x27 block.' },
  ],

  identification: [
    { id: 'mcp23017.address', description: 'Responds in the 0x20-0x27 expander address block', weight: 0.2, match: { kind: 'I2C_ADDRESS', addresses: [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27] } },
    {
      id: 'mcp23017.iodir-reset',
      description: 'IODIRA/IODIRB read back 0xFF 0xFF, the documented reset state (all pins inputs)',
      weight: 0.6,
      match: { kind: 'PROBE_RESPONSE', probeId: 'mcp23017.read_iodir', pattern: 'FF FF' },
      reference: 'MCP23017 datasheet DS20001952 §3.5.1',
    },
  ],

  registers: [
    { address: 0x00, name: 'IODIRA', description: 'Port A direction — 1 = input, 0 = output', width: 8, access: 'RW', resetValue: 0xff, fields: [{ name: 'IO', bitOffset: 0, bitWidth: 8, description: 'Per-pin direction bits' }], safeToRead: true, reference: 'DS20001952 §3.5.1' },
    { address: 0x01, name: 'IODIRB', description: 'Port B direction', width: 8, access: 'RW', resetValue: 0xff, fields: [{ name: 'IO', bitOffset: 0, bitWidth: 8 }], safeToRead: true, reference: 'DS20001952 §3.5.1' },
    { address: 0x0c, name: 'GPPUA', description: 'Port A 100 kΩ pull-up enables', width: 8, access: 'RW', resetValue: 0x00, fields: [{ name: 'PU', bitOffset: 0, bitWidth: 8 }], safeToRead: true, reference: 'DS20001952 §3.5.7' },
    { address: 0x0a, name: 'IOCON', description: 'Global configuration: bank mode, mirroring, sequential operation, interrupt polarity', width: 8, access: 'RW', resetValue: 0x00, fields: [
        { name: 'INTPOL', bitOffset: 1, bitWidth: 1, description: 'Interrupt output polarity' },
        { name: 'ODR', bitOffset: 2, bitWidth: 1, description: 'Interrupt output open-drain' },
        { name: 'DISSLW', bitOffset: 4, bitWidth: 1, description: 'Slew-rate control disabled' },
        { name: 'SEQOP', bitOffset: 5, bitWidth: 1, description: 'Sequential operation disabled' },
        { name: 'MIRROR', bitOffset: 6, bitWidth: 1, description: 'INTA/INTB internally connected' },
        { name: 'BANK', bitOffset: 7, bitWidth: 1, description: 'Register addressing scheme', enumerations: { '0': 'Interleaved A/B', '1': 'Separate banks' } },
      ], safeToRead: true, reference: 'DS20001952 §3.5.6' },
    { address: 0x12, name: 'GPIOA', description: 'Port A logic levels', width: 8, access: 'RW', fields: [{ name: 'GP', bitOffset: 0, bitWidth: 8 }], safeToRead: true, reference: 'DS20001952 §3.5.10' },
    { address: 0x13, name: 'GPIOB', description: 'Port B logic levels', width: 8, access: 'RW', fields: [{ name: 'GP', bitOffset: 0, bitWidth: 8 }], safeToRead: true, reference: 'DS20001952 §3.5.10' },
    { address: 0x0e, name: 'INTFA', description: 'Port A interrupt flags', width: 8, access: 'R', resetValue: 0x00, fields: [{ name: 'INT', bitOffset: 0, bitWidth: 8 }], safeToRead: true, reference: 'DS20001952 §3.5.8' },
    { address: 0x10, name: 'INTCAPA', description: 'Port A captured value at interrupt — cleared on read', width: 8, access: 'R', fields: [{ name: 'ICP', bitOffset: 0, bitWidth: 8 }], safeToRead: true, readHasSideEffects: true, reference: 'DS20001952 §3.5.9' },
  ],

  protocols: [{ name: 'I2C register file', description: 'Paired A/B register bank, interleaved or split depending on IOCON.BANK.' }],
  modes: [
    { name: 'Interleaved bank (BANK=0)', description: 'Default addressing with A/B registers adjacent' },
    { name: 'Split bank (BANK=1)', description: 'Port A and B registers in separate 0x00/0x10 blocks' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['mcp23017.read_iodir'] },
    { name: 'feature.gpio_expansion', category: 'FEATURE', documented: true, softwareSupported: true, description: '16 bidirectional I/O pins' },
    { name: 'feature.input_pullups', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Per-pin 100 kΩ pull-ups' },
    { name: 'feature.interrupt_on_change', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Interrupt-on-change with captured state' },
    { name: 'feature.interrupt_mirroring', category: 'FEATURE', documented: true, softwareSupported: false, description: 'INTA and INTB internally OR-ed' },
    { name: 'feature.input_polarity_inversion', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Per-pin input polarity inversion via IPOL' },
    { name: 'diagnostic.state_readback', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, evidenceProbes: ['mcp23017.read_gpio'] },
  ],

  safeProbes: [
    {
      id: 'mcp23017.read_iodir',
      name: 'Read IODIRA/IODIRB',
      description: 'Reads both direction registers.',
      interface: 'I2C',
      justification: 'Configuration read with no side effects; pin directions are not altered.',
      writes: true,
      writeJustification: 'Register pointer write required to address the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x20, write: [0x00], readLength: 2 }],
      expect: { minBytes: 2 },
      yields: ['pin direction configuration'],
      minDepth: 'BASIC',
      reference: 'DS20001952 §3.5.1',
    },
    {
      id: 'mcp23017.read_iocon',
      name: 'Read IOCON',
      description: 'Reads the global configuration register.',
      interface: 'I2C',
      justification: 'Configuration read with no side effects.',
      writes: true,
      writeJustification: 'Register pointer write required to address the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x20, write: [0x0a], readLength: 1 }],
      expect: { minBytes: 1 },
      yields: ['bank mode', 'interrupt configuration'],
      minDepth: 'STANDARD',
    },
    {
      id: 'mcp23017.read_gpio',
      name: 'Read GPIOA/GPIOB',
      description: 'Reads the current logic level of all 16 pins.',
      interface: 'I2C',
      justification: 'Reading GPIO levels does not drive any pin. Directions are left untouched.',
      writes: true,
      writeJustification: 'Register pointer write required to address the read.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x20, write: [0x12], readLength: 2 }],
      expect: { minBytes: 2 },
      yields: ['pin logic levels'],
      minDepth: 'STANDARD',
    },
  ],

  functionalTests: [
    { id: 'mcp23017.test.direction_read', name: 'Direction register readback', capability: 'interface.i2c', objective: 'Confirm both direction registers can be read.', procedure: ['Read 2 bytes from 0x00.'], expectedResult: 'Two bytes; 0xFF 0xFF after reset.', probes: ['mcp23017.read_iodir'], expectMinBytes: 2, minDepth: 'BASIC' },
    { id: 'mcp23017.test.state_read', name: 'Pin state readback', capability: 'diagnostic.state_readback', objective: 'Confirm current pin levels can be read.', procedure: ['Read 2 bytes from 0x12.'], expectedResult: 'Two bytes of pin state.', probes: ['mcp23017.read_gpio'], expectMinBytes: 2, minDepth: 'STANDARD' },
  ],

  benchmarks: [
    { id: 'mcp23017.bench.gpio_latency', name: 'GPIO read latency', metric: 'RESPONSE_LATENCY', probeId: 'mcp23017.read_gpio', iterations: 30, unit: 'ms' },
    { id: 'mcp23017.bench.gpio_poll_rate', name: 'GPIO polling rate', metric: 'POLLING_RATE', probeId: 'mcp23017.read_gpio', iterations: 50, unit: 'reads/s' },
  ],

  limitations: [
    'Register addresses shift when IOCON.BANK is set; this profile assumes the reset (BANK=0) layout.',
    'The MCP23S17 is the SPI variant of the same die and shares the register map.',
    'INTCAP clears on read and is excluded from automated register inspection.',
    'Interrogation never changes pin direction, so output drive capability cannot be verified without an external measurement.',
  ],

  documentation: [{ title: 'MCP23017/MCP23S17 16-Bit I/O Expander', section: 'DS20001952' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// SSD1306 — OLED display controller
// ---------------------------------------------------------------------------

export const SSD1306_PROFILE: ComponentProfile = {
  id: 'ssd1306',
  manufacturer: 'Solomon Systech',
  partNumber: 'SSD1306',
  aliases: ['ssd1315', 'oled-128x64'],
  description: '128x64 dot-matrix OLED/PLED display driver with an embedded controller and graphic display data RAM.',

  interfaces: [
    { kind: 'I2C', addresses: [0x3c, 0x3d], defaultClockHz: 400000, signals: ['SDA', 'SCL', 'RES'], note: 'SA0 selects 0x3C or 0x3D.' },
    { kind: 'SPI', defaultClockHz: 8000000, spiMode: 0, signals: ['SCK', 'MOSI', 'DC', 'CS', 'RES'], note: 'Write-only 4-wire SPI — the controller does not drive MISO.' },
  ],

  identification: [
    { id: 'ssd1306.address', description: 'Responds at I2C address 0x3C or 0x3D', weight: 0.25, match: { kind: 'I2C_ADDRESS', addresses: [0x3c, 0x3d] } },
    // The single readable status byte has no fixed signature — every bit is
    // state. No response-based rule can distinguish this part over the bus.
  ],

  registers: [
    {
      address: 'STATUS',
      name: 'STATUS',
      description: 'Single readable status byte reporting display on/off',
      width: 8,
      access: 'R',
      fields: [{ name: 'DISPLAY_OFF', bitOffset: 6, bitWidth: 1, enumerations: { '0': 'Display on', '1': 'Display off' } }],
      safeToRead: true,
      readProbeId: 'ssd1306.read_status',
      responseOffset: 0,
      reference: 'SSD1306 Rev 1.1 §8.1.5',
    },
  ],

  protocols: [{ name: 'SSD1306 command stream', description: 'Control byte (0x00 command, 0x40 data) followed by payload bytes.', signatures: ['00', '40'] }],
  modes: [
    { name: 'Page addressing', description: 'Default GDDRAM addressing mode' },
    { name: 'Horizontal addressing', description: 'Auto-incrementing column then page' },
    { name: 'Vertical addressing', description: 'Auto-incrementing page then column' },
    { name: 'Sleep (display off)', description: 'Panel off, RAM retained', entryNote: 'Entered with command 0xAE; interrogation issues no display commands.' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['ssd1306.read_status'] },
    { name: 'interface.spi', category: 'INTERFACE', documented: true, softwareSupported: true, description: '4-wire write-only SPI' },
    { name: 'feature.gddram', category: 'FEATURE', documented: true, softwareSupported: true, description: '128x64 bit graphic display data RAM' },
    { name: 'feature.hardware_scrolling', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Horizontal and vertical hardware scroll' },
    { name: 'feature.contrast_control', category: 'FEATURE', documented: true, softwareSupported: true, description: '256-step contrast' },
    { name: 'feature.charge_pump', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Internal charge pump for panel supply' },
    { name: 'diagnostic.status_readback', category: 'DIAGNOSTIC', documented: true, softwareSupported: false, description: 'Single status byte over I2C', evidenceProbes: ['ssd1306.read_status'] },
  ],

  safeProbes: [
    {
      id: 'ssd1306.read_status',
      name: 'Read status byte',
      description: 'Performs a plain I2C read of the single status byte.',
      interface: 'I2C',
      justification: 'A plain read. No control byte and no command is sent, so nothing on the panel changes.',
      writes: false,
      reversible: true,
      operations: [{ op: 'I2C_READ', address: 0x3c, length: 1 }],
      expect: { minBytes: 1 },
      yields: ['display on/off state'],
      minDepth: 'BASIC',
      reference: 'SSD1306 Rev 1.1 §8.1.5',
    },
  ],

  functionalTests: [
    { id: 'ssd1306.test.status_read', name: 'Status readback', capability: 'diagnostic.status_readback', objective: 'Confirm the controller returns a status byte.', procedure: ['Read one byte from the display address.'], expectedResult: 'One status byte.', probes: ['ssd1306.read_status'], expectMinBytes: 1, minDepth: 'BASIC' },
  ],

  benchmarks: [{ id: 'ssd1306.bench.status_latency', name: 'Status read latency', metric: 'RESPONSE_LATENCY', probeId: 'ssd1306.read_status', iterations: 20, unit: 'ms' }],

  limitations: [
    'The SSD1306 is fundamentally a write-oriented device: only one status byte can be read back.',
    'Display content cannot be read over I2C, so rendering correctness cannot be verified electrically.',
    'SSD1315 and several clones share the address and command set and are indistinguishable over the bus.',
    'The single status byte carries no fixed signature, so identification rests on the address ' +
      'alone and cannot rise above LOW confidence from the bus.',
    'Over SPI the controller drives no MISO line, so SPI discovery cannot detect it by response.',
  ],

  documentation: [{ title: 'SSD1306 Advanced Information', section: 'Rev 1.1' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// Generic 24Cxx I2C EEPROM
// ---------------------------------------------------------------------------

export const EEPROM_24CXX_PROFILE: ComponentProfile = {
  id: 'eeprom-24cxx',
  manufacturer: 'Multiple (Atmel/Microchip/ST and compatibles)',
  partNumber: '24Cxx',
  aliases: ['at24c32', 'at24c256', '24lc256', 'i2c-eeprom'],
  description: 'Serial I2C EEPROM family with 8-bit or 16-bit word addressing, page-write buffering and byte-level random read.',

  interfaces: [
    { kind: 'I2C', addresses: [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57], defaultClockHz: 400000, signals: ['SDA', 'SCL', 'WP'], note: 'A2/A1/A0 select one of eight addresses in the 0x50-0x57 block.' },
  ],

  identification: [
    { id: 'eeprom24.address', description: 'Responds in the 0x50-0x57 EEPROM address block', weight: 0.3, match: { kind: 'I2C_ADDRESS', addresses: [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57] } },
    // Stored contents are arbitrary, so no response pattern identifies the part.
    // Address is the only bus-visible evidence, and it is weak on its own.
  ],

  registers: [],

  protocols: [{ name: '24Cxx random read', description: 'Dummy write of the word address followed by a repeated-start read.' }],
  modes: [
    { name: 'Byte read', description: 'Single-byte random read' },
    { name: 'Sequential read', description: 'Auto-incrementing multi-byte read' },
    { name: 'Page write', description: 'Buffered write of a page', entryNote: 'This profile declares no write probe — EEPROM writes are out of scope.' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['eeprom24.read_first_bytes'] },
    { name: 'feature.sequential_read', category: 'FEATURE', documented: true, softwareSupported: true, evidenceProbes: ['eeprom24.read_first_bytes'] },
    { name: 'feature.random_read', category: 'FEATURE', documented: true, softwareSupported: true },
    { name: 'feature.page_write', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Deliberately unsupported here — interrogation does not write non-volatile memory.' },
    { name: 'feature.write_protect_pin', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Hardware write protect via the WP pin' },
  ],

  safeProbes: [
    {
      id: 'eeprom24.read_first_bytes',
      name: 'Sequential read from word address 0',
      description: 'Reads the first 16 bytes using a two-byte word address.',
      interface: 'I2C',
      justification: 'Read-only access to user data. No write cycle is initiated and no cell is modified.',
      writes: true,
      writeJustification:
        'A 24Cxx random read requires a dummy write of the word address pointer before the ' +
        'repeated-start read. The dummy write sets the address counter only; it never latches data.',
      reversible: true,
      operations: [{ op: 'I2C_WRITE_READ', address: 0x50, write: [0x00, 0x00], readLength: 16 }],
      expect: { minBytes: 16 },
      yields: ['stored contents at offset 0', 'word-addressing width'],
      minDepth: 'BASIC',
    },
  ],

  functionalTests: [
    { id: 'eeprom24.test.read', name: 'Sequential read', capability: 'feature.sequential_read', objective: 'Confirm the device returns data for a sequential read.', procedure: ['Write word address 0x0000.', 'Read 16 bytes.'], expectedResult: 'Sixteen bytes of stored data.', probes: ['eeprom24.read_first_bytes'], expectMinBytes: 16, minDepth: 'BASIC' },
  ],

  benchmarks: [
    { id: 'eeprom24.bench.read_latency', name: 'Sequential read latency', metric: 'RESPONSE_LATENCY', probeId: 'eeprom24.read_first_bytes', iterations: 20, unit: 'ms' },
    { id: 'eeprom24.bench.throughput', name: 'Read throughput', metric: 'THROUGHPUT', probeId: 'eeprom24.read_first_bytes', iterations: 20, unit: 'bytes/s' },
  ],

  limitations: [
    'Device capacity cannot be determined by reading alone without address-wrap probing, which this profile does not perform.',
    'Parts with 8-bit word addressing will misinterpret the two-byte address used here; a returned block of 0xFF may indicate an addressing-width mismatch rather than an erased device.',
    'This profile declares no write probe by default; use esp32_register_inspect `writes` or ' +
      'esp32_hardware_execute to write deliberately.',
    'Stored contents are arbitrary, so no response pattern identifies the part — identification ' +
      'rests on the address block alone.',
  ],

  documentation: [{ title: 'AT24C32/64 Datasheet' }, { title: 'Microchip 24LC256 Datasheet' }],
  confidence: 'DOCUMENTED',
};
