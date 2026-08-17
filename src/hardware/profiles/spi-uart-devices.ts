/**
 * SPI and UART component profiles.
 *
 * A radio module, a CAN controller and a GPS receiver — three completely
 * different classes of part, all described through the same profile shape. The
 * engine has no knowledge of any of them.
 */

import type { ComponentProfile } from '../../types/hardware.js';

// ---------------------------------------------------------------------------
// Nordic nRF24L01+ — 2.4 GHz SPI transceiver (radio module)
// ---------------------------------------------------------------------------

/** nRF24 R_REGISTER command: 000A AAAA. */
function nrfReadRegister(reg: number): number {
  return 0x00 | (reg & 0x1f);
}

export const NRF24L01_PROFILE: ComponentProfile = {
  id: 'nrf24l01',
  manufacturer: 'Nordic Semiconductor',
  partNumber: 'nRF24L01+',
  aliases: ['nrf24', 'nrf24l01p', 'nrf24l01+pa+lna'],
  description: '2.4 GHz ISM band transceiver with an embedded Enhanced ShockBurst baseband protocol engine, controlled over SPI.',

  interfaces: [
    {
      kind: 'SPI',
      defaultClockHz: 4000000,
      spiMode: 0,
      signals: ['SCK', 'MISO', 'MOSI', 'CSN', 'CE', 'IRQ'],
      note: 'SPI mode 0, MSB first, up to 10 MHz. CE is separate from CSN and controls radio state, not the bus.',
    },
  ],

  identification: [
    {
      id: 'nrf24.status-register',
      description: 'STATUS byte returned during the command phase has bit 7 clear (reserved, always 0)',
      weight: 0.35,
      match: { kind: 'PROBE_RESPONSE', probeId: 'nrf24.read_config', pattern: '0? ??' },
      reference: 'nRF24L01+ Product Specification v1.0 §9.1',
    },
    {
      id: 'nrf24.setup-aw-reset',
      description: 'SETUP_AW (0x03) reads back 0x03, the documented reset value (5-byte addresses)',
      weight: 0.5,
      match: { kind: 'PROBE_RESPONSE', probeId: 'nrf24.read_setup_aw', pattern: '?? 03' },
      reference: 'nRF24L01+ Product Specification v1.0 §9.1',
    },
    {
      id: 'nrf24.rf-setup-reset',
      description: 'RF_SETUP (0x06) reads back the documented reset value 0x0E',
      weight: 0.45,
      match: { kind: 'PROBE_RESPONSE', probeId: 'nrf24.read_rf_setup', pattern: '?? 0E' },
      reference: 'nRF24L01+ Product Specification v1.0 §9.1',
    },
  ],

  registers: [
    {
      address: 0x00,
      name: 'CONFIG',
      description: 'Interrupt masks, CRC configuration, power state and RX/TX role',
      width: 8,
      access: 'RW',
      resetValue: 0x08,
      fields: [
        { name: 'PRIM_RX', bitOffset: 0, bitWidth: 1, enumerations: { '0': 'PTX (transmitter)', '1': 'PRX (receiver)' } },
        { name: 'PWR_UP', bitOffset: 1, bitWidth: 1, enumerations: { '0': 'Power down', '1': 'Power up' } },
        { name: 'CRCO', bitOffset: 2, bitWidth: 1, enumerations: { '0': '1 byte CRC', '1': '2 byte CRC' } },
        { name: 'EN_CRC', bitOffset: 3, bitWidth: 1, description: 'CRC enabled' },
        { name: 'MASK_MAX_RT', bitOffset: 4, bitWidth: 1 },
        { name: 'MASK_TX_DS', bitOffset: 5, bitWidth: 1 },
        { name: 'MASK_RX_DR', bitOffset: 6, bitWidth: 1 },
      ],
      safeToRead: true,
      readProbeId: 'nrf24.read_config',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
    {
      address: 0x03,
      name: 'SETUP_AW',
      description: 'Address field width for RX/TX pipes',
      width: 8,
      access: 'RW',
      resetValue: 0x03,
      fields: [{ name: 'AW', bitOffset: 0, bitWidth: 2, enumerations: { '0': 'Illegal', '1': '3 bytes', '2': '4 bytes', '3': '5 bytes' } }],
      safeToRead: true,
      readProbeId: 'nrf24.read_setup_aw',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
    {
      address: 0x05,
      name: 'RF_CH',
      description: 'RF channel frequency: 2400 MHz + RF_CH',
      width: 8,
      access: 'RW',
      resetValue: 0x02,
      fields: [{ name: 'RF_CH', bitOffset: 0, bitWidth: 7, description: 'Channel offset in MHz above 2400 MHz' }],
      safeToRead: true,
      readProbeId: 'nrf24.read_rf_ch',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
    {
      address: 0x06,
      name: 'RF_SETUP',
      description: 'Data rate, output power and LNA gain',
      width: 8,
      access: 'RW',
      resetValue: 0x0e,
      fields: [
        { name: 'LNA_HCURR', bitOffset: 0, bitWidth: 1, description: 'Legacy LNA gain bit (nRF24L01 only)' },
        { name: 'RF_PWR', bitOffset: 1, bitWidth: 2, enumerations: { '0': '-18 dBm', '1': '-12 dBm', '2': '-6 dBm', '3': '0 dBm' } },
        { name: 'RF_DR_HIGH', bitOffset: 3, bitWidth: 1, enumerations: { '0': '1 Mbps', '1': '2 Mbps' } },
        { name: 'PLL_LOCK', bitOffset: 4, bitWidth: 1, description: 'Test-only PLL lock force' },
        { name: 'RF_DR_LOW', bitOffset: 5, bitWidth: 1, description: 'Set with RF_DR_HIGH clear for 250 kbps (nRF24L01+ only)' },
        { name: 'CONT_WAVE', bitOffset: 7, bitWidth: 1, description: 'Continuous carrier transmit (test mode)' },
      ],
      safeToRead: true,
      readProbeId: 'nrf24.read_rf_setup',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
    {
      address: 0x07,
      name: 'STATUS',
      description: 'Interrupt flags, RX FIFO pipe number and TX FIFO full flag',
      width: 8,
      access: 'RW',
      resetValue: 0x0e,
      fields: [
        { name: 'TX_FULL', bitOffset: 0, bitWidth: 1 },
        { name: 'RX_P_NO', bitOffset: 1, bitWidth: 3, enumerations: { '7': 'RX FIFO empty' } },
        { name: 'MAX_RT', bitOffset: 4, bitWidth: 1, description: 'Maximum retransmits reached' },
        { name: 'TX_DS', bitOffset: 5, bitWidth: 1, description: 'Data sent' },
        { name: 'RX_DR', bitOffset: 6, bitWidth: 1, description: 'Data ready in RX FIFO' },
      ],
      safeToRead: true,
      readProbeId: 'nrf24.read_status',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
    {
      address: 0x17,
      name: 'FIFO_STATUS',
      description: 'TX and RX FIFO fill state',
      width: 8,
      access: 'R',
      resetValue: 0x11,
      fields: [
        { name: 'RX_EMPTY', bitOffset: 0, bitWidth: 1 },
        { name: 'RX_FULL', bitOffset: 1, bitWidth: 1 },
        { name: 'TX_EMPTY', bitOffset: 4, bitWidth: 1 },
        { name: 'TX_FULL', bitOffset: 5, bitWidth: 1 },
        { name: 'TX_REUSE', bitOffset: 6, bitWidth: 1 },
      ],
      safeToRead: true,
      readProbeId: 'nrf24.read_fifo_status',
      reference: 'nRF24L01+ PS v1.0 §9.1',
    },
  ],

  protocols: [
    { name: 'nRF24 SPI command set', description: 'R_REGISTER (000A AAAA), W_REGISTER (001A AAAA), NOP (0xFF). STATUS is returned during every command byte.', signatures: ['FF'] },
    { name: 'Enhanced ShockBurst', description: 'Automatic packet assembly, ACK and retransmission handled in hardware.' },
  ],

  modes: [
    { name: 'Power Down', description: 'Lowest current, register access retained' },
    { name: 'Standby-I', description: 'Crystal running, ready to transmit or receive' },
    { name: 'RX Mode', description: 'PRIM_RX set and CE high' },
    { name: 'TX Mode', description: 'PRIM_RX clear, payload loaded and CE pulsed' },
  ],

  capabilities: [
    { name: 'interface.spi', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['nrf24.read_config'] },
    { name: 'diagnostic.register_read', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, evidenceProbes: ['nrf24.read_config', 'nrf24.read_status'] },
    { name: 'protocol.enhanced_shockburst', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'Hardware auto-ACK and auto-retransmit' },
    { name: 'feature.data_rate_250kbps', category: 'FEATURE', documented: true, softwareSupported: true, description: 'nRF24L01+ only — distinguishes the plus variant from the original' },
    { name: 'feature.data_rate_2mbps', category: 'FEATURE', documented: true, softwareSupported: true },
    { name: 'feature.six_rx_pipes', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Six concurrently addressable receive pipes' },
    { name: 'feature.dynamic_payload_length', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Requires the FEATURE register to be enabled by the host' },
    { name: 'feature.ack_payload', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Payload attached to the acknowledgement packet' },
    { name: 'feature.carrier_detect', category: 'FEATURE', documented: true, softwareSupported: false, description: 'RPD/CD received power detector' },
    { name: 'power.power_down_mode', category: 'POWER', documented: true, softwareSupported: true },
    { name: 'measurement.rf_output_power', category: 'MEASUREMENT', documented: true, softwareSupported: false, description: 'Four selectable output power levels' },
  ],

  safeProbes: [
    {
      id: 'nrf24.read_config',
      name: 'R_REGISTER CONFIG (0x00)',
      description: 'Reads the CONFIG register; the STATUS byte is returned during the command phase.',
      interface: 'SPI',
      justification: 'R_REGISTER is a read command. No register content and no radio state changes.',
      writes: true,
      writeJustification: 'SPI is inherently full-duplex: reading a register requires clocking out the R_REGISTER command byte. Only read opcodes are used.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [nrfReadRegister(0x00)], readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 2 },
      yields: ['STATUS byte', 'CONFIG register'],
      minDepth: 'BASIC',
      reference: 'nRF24L01+ PS v1.0 §8.3.1',
    },
    {
      id: 'nrf24.read_status',
      name: 'NOP (STATUS readback)',
      description: 'Clocks a NOP to read the STATUS register with no other effect.',
      interface: 'SPI',
      justification: 'NOP is the documented no-effect command; it exists precisely to read STATUS safely.',
      writes: true,
      writeJustification: 'The NOP opcode must be clocked out to receive STATUS. NOP alters nothing.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [0xff], mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 1 },
      yields: ['STATUS register'],
      minDepth: 'BASIC',
      reference: 'nRF24L01+ PS v1.0 §8.3.1',
    },
    {
      id: 'nrf24.read_setup_aw',
      name: 'R_REGISTER SETUP_AW (0x03)',
      description: 'Reads the address width configuration.',
      interface: 'SPI',
      justification: 'Read command with no side effects.',
      writes: true,
      writeJustification: 'R_REGISTER opcode must be clocked out to perform the read.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [nrfReadRegister(0x03)], readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 2 },
      yields: ['address width'],
      minDepth: 'STANDARD',
    },
    {
      id: 'nrf24.read_rf_ch',
      name: 'R_REGISTER RF_CH (0x05)',
      description: 'Reads the configured RF channel.',
      interface: 'SPI',
      justification: 'Read command with no side effects. Does not key the transmitter.',
      writes: true,
      writeJustification: 'R_REGISTER opcode must be clocked out to perform the read.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [nrfReadRegister(0x05)], readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 2 },
      yields: ['RF channel'],
      minDepth: 'STANDARD',
    },
    {
      id: 'nrf24.read_rf_setup',
      name: 'R_REGISTER RF_SETUP (0x06)',
      description: 'Reads data rate and output power configuration.',
      interface: 'SPI',
      justification: 'Read command with no side effects. Does not enable the PA or key the transmitter.',
      writes: true,
      writeJustification: 'R_REGISTER opcode must be clocked out to perform the read.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [nrfReadRegister(0x06)], readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 2 },
      yields: ['data rate', 'output power'],
      minDepth: 'STANDARD',
    },
    {
      id: 'nrf24.read_fifo_status',
      name: 'R_REGISTER FIFO_STATUS (0x17)',
      description: 'Reads TX/RX FIFO fill state.',
      interface: 'SPI',
      justification: 'Read-only status register; reading does not pop the FIFO.',
      writes: true,
      writeJustification: 'R_REGISTER opcode must be clocked out to perform the read.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: [nrfReadRegister(0x17)], readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 2 },
      yields: ['FIFO occupancy'],
      minDepth: 'DEEP',
    },
  ],

  functionalTests: [
    { id: 'nrf24.test.register_read', name: 'CONFIG register readback', capability: 'diagnostic.register_read', objective: 'Confirm the radio answers an R_REGISTER command.', procedure: ['Clock out R_REGISTER(0x00).', 'Assert two bytes were returned and the response is not all 0x00 or all 0xFF.'], expectedResult: 'STATUS byte followed by the CONFIG value.', probes: ['nrf24.read_config'], expectMinBytes: 2, minDepth: 'BASIC' },
    { id: 'nrf24.test.status_nop', name: 'STATUS via NOP', capability: 'interface.spi', objective: 'Confirm the SPI link is functional using the no-effect NOP command.', procedure: ['Clock out 0xFF.', 'Assert one byte was returned.'], expectedResult: 'One STATUS byte.', probes: ['nrf24.read_status'], expectMinBytes: 1, minDepth: 'BASIC' },
    { id: 'nrf24.test.rf_setup', name: 'RF configuration readback', capability: 'feature.data_rate_2mbps', objective: 'Confirm RF_SETUP is readable so data rate configuration can be observed.', procedure: ['Read RF_SETUP.'], expectedResult: 'STATUS byte followed by RF_SETUP; 0x0E after reset.', probes: ['nrf24.read_rf_setup'], expectMinBytes: 2, minDepth: 'STANDARD' },
  ],

  benchmarks: [
    { id: 'nrf24.bench.register_latency', name: 'Register read latency', metric: 'RESPONSE_LATENCY', probeId: 'nrf24.read_config', iterations: 30, unit: 'ms' },
    { id: 'nrf24.bench.status_poll_rate', name: 'STATUS polling rate', metric: 'POLLING_RATE', probeId: 'nrf24.read_status', iterations: 50, unit: 'reads/s' },
    { id: 'nrf24.bench.register_consistency', name: 'Register read consistency', metric: 'READ_CONSISTENCY', probeId: 'nrf24.read_rf_setup', iterations: 20, unit: 'agreement ratio' },
  ],

  limitations: [
    'The nRF24L01+ has no device ID register. Identification rests on reset values and register-layout consistency, which is weaker evidence than a dedicated ID.',
    'Distinguishing nRF24L01+ from the original nRF24L01 requires writing RF_SETUP to test 250 kbps support, which this profile does not do.',
    'Many clones (Si24R1 and similar) respond identically to every read probe.',
    'Radio transmission is never exercised: no probe keys the transmitter or enables the power amplifier.',
    'CE must be low for register access; the interrogation does not control CE, so results depend on the wiring holding it low or the host driving it.',
  ],

  documentation: [{ title: 'nRF24L01+ Single Chip 2.4GHz Transceiver Product Specification', section: 'v1.0' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// Microchip MCP2515 — SPI CAN controller
// ---------------------------------------------------------------------------

/** MCP2515 READ instruction is 0x03 followed by the register address. */
function mcp2515Read(register: number): number[] {
  return [0x03, register & 0xff];
}

export const MCP2515_PROFILE: ComponentProfile = {
  id: 'mcp2515',
  manufacturer: 'Microchip Technology',
  partNumber: 'MCP2515',
  aliases: ['mcp2515-i/p', 'can-bus-shield'],
  description: 'Stand-alone CAN 2.0B controller with an SPI host interface, three transmit and two receive buffers, and six acceptance filters.',

  interfaces: [
    { kind: 'SPI', defaultClockHz: 1000000, spiMode: 0, signals: ['SCK', 'MISO', 'MOSI', 'CS', 'INT', 'RESET'], note: 'SPI mode 0,0 or 1,1 at up to 10 MHz.' },
    { kind: 'CAN', note: 'CAN 2.0B at up to 1 Mbit/s through an external transceiver such as the TJA1050.' },
  ],

  identification: [
    {
      id: 'mcp2515.canstat-mode',
      description: 'CANSTAT (0x0E) reports a valid operation mode in bits 7:5, 0x80 (configuration mode) after reset',
      weight: 0.6,
      match: { kind: 'PROBE_RESPONSE', probeId: 'mcp2515.read_canstat', pattern: '8?' },
      reference: 'MCP2515 datasheet DS20001801 §10.0',
    },
    {
      id: 'mcp2515.canctrl-reset',
      description: 'CANCTRL (0x0F) reads back 0x87, the documented reset value',
      weight: 0.5,
      match: { kind: 'PROBE_RESPONSE', probeId: 'mcp2515.read_canctrl', pattern: '87' },
      reference: 'MCP2515 datasheet DS20001801 §10.0',
    },
  ],

  registers: [
    {
      address: 0x0e,
      name: 'CANSTAT',
      description: 'Operation mode and interrupt flag code',
      width: 8,
      access: 'R',
      resetValue: 0x80,
      fields: [
        { name: 'ICOD', bitOffset: 1, bitWidth: 3, description: 'Interrupt flag code', enumerations: { '0': 'No interrupt', '1': 'Error', '2': 'Wake-up', '3': 'TXB0', '4': 'TXB1', '5': 'TXB2', '6': 'RXB0', '7': 'RXB1' } },
        { name: 'OPMOD', bitOffset: 5, bitWidth: 3, description: 'Current operation mode', enumerations: { '0': 'Normal', '1': 'Sleep', '2': 'Loopback', '3': 'Listen-only', '4': 'Configuration' } },
      ],
      safeToRead: true,
      readProbeId: 'mcp2515.read_canstat',
      reference: 'DS20001801 §10.0',
    },
    {
      address: 0x0f,
      name: 'CANCTRL',
      description: 'Requested operation mode, clock output and one-shot control',
      width: 8,
      access: 'RW',
      resetValue: 0x87,
      fields: [
        { name: 'CLKPRE', bitOffset: 0, bitWidth: 2, enumerations: { '0': 'fCLKOUT = System/1', '1': '/2', '2': '/4', '3': '/8' } },
        { name: 'CLKEN', bitOffset: 2, bitWidth: 1, description: 'CLKOUT pin enabled' },
        { name: 'OSM', bitOffset: 3, bitWidth: 1, description: 'One-shot mode' },
        { name: 'ABAT', bitOffset: 4, bitWidth: 1, description: 'Abort all pending transmissions' },
        { name: 'REQOP', bitOffset: 5, bitWidth: 3, enumerations: { '0': 'Normal', '1': 'Sleep', '2': 'Loopback', '3': 'Listen-only', '4': 'Configuration' } },
      ],
      safeToRead: true,
      readProbeId: 'mcp2515.read_canctrl',
      reference: 'DS20001801 §10.0',
    },
    {
      address: 0x2c,
      name: 'CANINTF',
      description: 'Interrupt flags',
      width: 8,
      access: 'RW',
      resetValue: 0x00,
      fields: [
        { name: 'RX0IF', bitOffset: 0, bitWidth: 1 },
        { name: 'RX1IF', bitOffset: 1, bitWidth: 1 },
        { name: 'TX0IF', bitOffset: 2, bitWidth: 1 },
        { name: 'ERRIF', bitOffset: 5, bitWidth: 1 },
        { name: 'WAKIF', bitOffset: 6, bitWidth: 1 },
        { name: 'MERRF', bitOffset: 7, bitWidth: 1 },
      ],
      safeToRead: true,
      readProbeId: 'mcp2515.read_canintf',
      reference: 'DS20001801 §12.0',
    },
    {
      address: 0x1c,
      name: 'TEC',
      description: 'Transmit error counter',
      width: 8,
      access: 'R',
      resetValue: 0x00,
      fields: [{ name: 'TEC', bitOffset: 0, bitWidth: 8 }],
      safeToRead: true,
      readProbeId: 'mcp2515.read_error_counters',
      responseOffset: 2,
      reference: 'DS20001801 §6.0',
    },
  ],

  protocols: [
    { name: 'MCP2515 SPI instruction set', description: 'RESET 0xC0, READ 0x03, WRITE 0x02, READ STATUS 0xA0, RX STATUS 0xB0, BIT MODIFY 0x05.' },
    { name: 'CAN 2.0B', description: 'Standard and extended identifiers at up to 1 Mbit/s.' },
  ],

  modes: [
    { name: 'Configuration', description: 'Entered automatically after reset; bit timing writable' },
    { name: 'Normal', description: 'Full participation on the bus' },
    { name: 'Listen-only', description: 'Receives without acknowledging — non-intrusive bus monitoring' },
    { name: 'Loopback', description: 'Internal self-test without driving the bus' },
    { name: 'Sleep', description: 'Low-power with wake-on-bus-activity' },
  ],

  capabilities: [
    { name: 'interface.spi', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['mcp2515.read_canstat'] },
    { name: 'diagnostic.register_read', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, evidenceProbes: ['mcp2515.read_canstat'] },
    { name: 'protocol.can_2_0b', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'Standard and extended CAN frames' },
    { name: 'mode.listen_only', category: 'MODE', documented: true, softwareSupported: true, description: 'Passive bus monitoring without acknowledgement' },
    { name: 'mode.loopback', category: 'MODE', documented: true, softwareSupported: true },
    { name: 'feature.acceptance_filters', category: 'FEATURE', documented: true, softwareSupported: true, description: 'Six acceptance filters and two masks' },
    { name: 'feature.error_counters', category: 'FEATURE', documented: true, softwareSupported: true, evidenceProbes: ['mcp2515.read_error_counters'] },
    { name: 'feature.one_shot_transmit', category: 'FEATURE', documented: true, softwareSupported: false },
    { name: 'feature.clkout', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Programmable clock output' },
    { name: 'power.sleep_mode', category: 'POWER', documented: true, softwareSupported: false },
  ],

  safeProbes: [
    {
      id: 'mcp2515.read_canstat',
      name: 'READ CANSTAT (0x0E)',
      description: 'Reads the operation mode and interrupt code.',
      interface: 'SPI',
      justification: 'READ instruction with no side effects. Bus mode is not changed.',
      writes: true,
      writeJustification: 'The READ opcode and register address must be clocked out. Only read opcodes are used — never RESET (0xC0) or WRITE (0x02).',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: mcp2515Read(0x0e), readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 3 },
      yields: ['operation mode'],
      minDepth: 'BASIC',
      reference: 'DS20001801 §12.3',
    },
    {
      id: 'mcp2515.read_canctrl',
      name: 'READ CANCTRL (0x0F)',
      description: 'Reads the requested mode and clock configuration.',
      interface: 'SPI',
      justification: 'READ instruction with no side effects.',
      writes: true,
      writeJustification: 'READ opcode and register address must be clocked out.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: mcp2515Read(0x0f), readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 3 },
      yields: ['requested mode', 'clock prescaler'],
      minDepth: 'BASIC',
    },
    {
      id: 'mcp2515.read_canintf',
      name: 'READ CANINTF (0x2C)',
      description: 'Reads the interrupt flag register.',
      interface: 'SPI',
      justification: 'READ instruction; flags are not cleared by reading.',
      writes: true,
      writeJustification: 'READ opcode and register address must be clocked out.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: mcp2515Read(0x2c), readLength: 1, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 3 },
      yields: ['pending interrupts'],
      minDepth: 'STANDARD',
    },
    {
      id: 'mcp2515.read_error_counters',
      name: 'READ TEC/REC (0x1C-0x1D)',
      description: 'Sequentially reads the transmit and receive error counters.',
      interface: 'SPI',
      justification: 'READ instruction; error counters are read-only and unaffected by reading.',
      writes: true,
      writeJustification: 'READ opcode and register address must be clocked out.',
      reversible: true,
      operations: [{ op: 'SPI_TRANSFER', tx: mcp2515Read(0x1c), readLength: 2, mode: 0, clockHz: 1000000 }],
      expect: { minBytes: 4 },
      yields: ['transmit error count', 'receive error count'],
      minDepth: 'DEEP',
    },
  ],

  functionalTests: [
    { id: 'mcp2515.test.mode_read', name: 'Operation mode readback', capability: 'diagnostic.register_read', objective: 'Confirm CANSTAT is readable and reports a mode.', procedure: ['Clock READ 0x0E.', 'Assert a non-degenerate response.'], expectedResult: 'CANSTAT value; 0x80 (configuration mode) after reset.', probes: ['mcp2515.read_canstat'], expectMinBytes: 3, minDepth: 'BASIC' },
    { id: 'mcp2515.test.error_counters', name: 'Error counter readback', capability: 'feature.error_counters', objective: 'Confirm TEC and REC can be read.', procedure: ['Sequentially read 0x1C and 0x1D.'], expectedResult: 'Two counter bytes.', probes: ['mcp2515.read_error_counters'], expectMinBytes: 4, minDepth: 'DEEP' },
  ],

  benchmarks: [
    { id: 'mcp2515.bench.register_latency', name: 'Register read latency', metric: 'RESPONSE_LATENCY', probeId: 'mcp2515.read_canstat', iterations: 30, unit: 'ms' },
    { id: 'mcp2515.bench.error_rate', name: 'Register read error rate', metric: 'ERROR_RATE', probeId: 'mcp2515.read_canstat', iterations: 50, unit: 'errors/attempt' },
  ],

  limitations: [
    'The MCP2515 has no device ID register; identification relies on documented reset values.',
    'No probe issues RESET (0xC0), so a device left in a non-default mode by earlier firmware will not match the reset-value identification rules.',
    'CAN bus participation cannot be verified without an external transceiver and a second node.',
    'Bit timing registers are only writable in configuration mode; interrogation never writes them.',
  ],

  documentation: [{ title: 'MCP2515 Stand-Alone CAN Controller with SPI Interface', section: 'DS20001801' }],
  confidence: 'DOCUMENTED',
};

// ---------------------------------------------------------------------------
// u-blox NEO-6M — UART GPS receiver
// ---------------------------------------------------------------------------

export const NEO6M_PROFILE: ComponentProfile = {
  id: 'neo-6m',
  manufacturer: 'u-blox',
  partNumber: 'NEO-6M',
  aliases: ['neo6m', 'gy-neo6mv2', 'ublox-neo-6'],
  description: '50-channel GPS receiver module emitting NMEA 0183 sentences over UART, with the binary UBX protocol available in parallel.',

  interfaces: [
    { kind: 'UART', defaultBaud: 9600, signals: ['TX', 'RX', 'PPS'], note: 'Factory default 9600 8N1. NMEA output begins automatically at power-up with no host command.' },
    { kind: 'I2C', addresses: [0x42], note: 'DDC (I2C-compatible) interface, present on the die but not bonded out on most NEO-6M breakout boards.' },
  ],

  identification: [
    {
      id: 'neo6m.nmea-gp-talker',
      description: 'Emits NMEA sentences with the GP talker ID',
      weight: 0.5,
      match: { kind: 'UART_PATTERN', pattern: '\\$GP(GGA|RMC|GSA|GSV|GLL|VTG)', regex: true },
      reference: 'NMEA 0183 v4.10 / u-blox 6 Receiver Description',
    },
    {
      id: 'neo6m.nmea-framing',
      description: 'Sentences start with 0x24 ("$") and end with CR LF',
      weight: 0.3,
      match: { kind: 'UART_PATTERN', pattern: '\\$[A-Z]{5},', regex: true },
    },
    {
      id: 'neo6m.ubx-sync',
      description: 'Binary UBX frames begin with the sync bytes B5 62',
      weight: 0.4,
      match: { kind: 'PROBE_RESPONSE', probeId: 'neo6m.listen', pattern: 'B5 62' },
      reference: 'u-blox 6 Receiver Description §UBX Protocol',
    },
  ],

  registers: [],

  protocols: [
    { name: 'NMEA 0183', description: 'ASCII sentences: $<talker><type>,<fields>*<checksum><CR><LF>', signatures: ['24 47 50'], reference: 'NMEA 0183 v4.10' },
    { name: 'UBX', description: 'u-blox binary protocol framed by sync chars 0xB5 0x62 followed by class, id, length and a Fletcher checksum.', signatures: ['B5 62'], reference: 'u-blox 6 Receiver Description' },
  ],

  modes: [
    { name: 'Continuous', description: 'Default full-power tracking' },
    { name: 'Power Save Mode', description: 'Duty-cycled tracking', entryNote: 'Requires a UBX-CFG-RXM command; interrogation sends no configuration.' },
    { name: 'Cyclic tracking', description: 'Periodic position updates at reduced power' },
  ],

  capabilities: [
    { name: 'interface.uart', category: 'INTERFACE', documented: true, softwareSupported: true, evidenceProbes: ['neo6m.listen'] },
    { name: 'protocol.nmea0183', category: 'PROTOCOL', documented: true, softwareSupported: true, evidenceProbes: ['neo6m.listen'] },
    { name: 'protocol.ubx', category: 'PROTOCOL', documented: true, softwareSupported: false, description: 'u-blox binary configuration and navigation protocol' },
    { name: 'measurement.position_fix', category: 'MEASUREMENT', documented: true, softwareSupported: true, description: 'GPS position, velocity and time' },
    { name: 'measurement.satellite_status', category: 'MEASUREMENT', documented: true, softwareSupported: true, description: 'Satellites in view and used, reported via GSV/GSA' },
    { name: 'feature.pps_output', category: 'FEATURE', documented: true, softwareSupported: false, description: 'One pulse-per-second timing output' },
    { name: 'feature.configurable_baud', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Baud rate configurable via UBX-CFG-PRT' },
    { name: 'feature.sbas', category: 'FEATURE', documented: true, softwareSupported: false, description: 'Satellite-based augmentation (WAAS/EGNOS)' },
    { name: 'power.power_save_mode', category: 'POWER', documented: true, softwareSupported: false },
  ],

  safeProbes: [
    {
      id: 'neo6m.listen',
      name: 'Passive NMEA capture',
      description: 'Listens on the module TX line for three seconds without transmitting anything.',
      interface: 'UART',
      justification:
        'Entirely passive. Nothing is transmitted to the module, so its configuration and ' +
        'navigation state cannot be affected. This is the correct first step for an unknown ' +
        'UART device.',
      writes: false,
      reversible: true,
      operations: [{ op: 'UART_LISTEN', durationMs: 3000, baud: 9600 }],
      expect: { minBytes: 16 },
      yields: ['NMEA sentences', 'talker ID', 'fix status', 'satellite count', 'effective baud confirmation'],
      minDepth: 'BASIC',
    },
    {
      id: 'neo6m.listen_extended',
      name: 'Extended passive capture',
      description: 'Ten-second passive capture covering a full NMEA sentence cycle.',
      interface: 'UART',
      justification: 'Passive listening only. Longer window captures the complete sentence rotation including GSV.',
      writes: false,
      reversible: true,
      operations: [{ op: 'UART_LISTEN', durationMs: 10000, baud: 9600 }],
      expect: { minBytes: 64 },
      yields: ['full NMEA sentence set', 'update rate'],
      minDepth: 'DEEP',
    },
  ],

  functionalTests: [
    { id: 'neo6m.test.nmea_output', name: 'NMEA output', capability: 'protocol.nmea0183', objective: 'Confirm the module emits NMEA sentences unprompted.', procedure: ['Listen passively for 3 seconds at 9600 baud.', 'Assert at least 16 bytes arrived.'], expectedResult: 'ASCII NMEA sentences beginning with "$".', probes: ['neo6m.listen'], expectMinBytes: 16, minDepth: 'BASIC' },
    { id: 'neo6m.test.uart_link', name: 'UART link', capability: 'interface.uart', objective: 'Confirm the UART link carries data at the configured baud rate.', procedure: ['Listen passively.', 'Assert bytes were received.'], expectedResult: 'Non-empty capture.', probes: ['neo6m.listen'], expectMinBytes: 1, minDepth: 'BASIC' },
    { id: 'neo6m.test.satellite_reporting', name: 'Satellite status reporting', capability: 'measurement.satellite_status', objective: 'Confirm GSV/GSA sentences appear in an extended capture.', procedure: ['Listen passively for 10 seconds.', 'Assert a substantial capture was collected.'], expectedResult: 'Capture containing GSA and GSV sentences.', probes: ['neo6m.listen_extended'], expectMinBytes: 64, minDepth: 'DEEP' },
  ],

  benchmarks: [
    { id: 'neo6m.bench.throughput', name: 'NMEA output throughput', metric: 'THROUGHPUT', probeId: 'neo6m.listen', iterations: 5, unit: 'bytes/s' },
    { id: 'neo6m.bench.stability', name: 'Output stability across captures', metric: 'STABILITY', probeId: 'neo6m.listen', iterations: 5, unit: 'agreement ratio' },
  ],

  limitations: [
    'A cold receiver without antenna or sky view emits valid NMEA sentences carrying no fix. Presence of NMEA proves the link, not positioning.',
    'The module and several u-blox generations share the NMEA output format; NMEA alone does not identify the NEO-6M specifically.',
    'Confirming the exact firmware version needs a UBX-MON-VER poll, which this profile does not send in order to stay passive.',
    'Clone modules using MediaTek chipsets emit similar NMEA and can be mistaken for u-blox parts on NMEA evidence alone.',
    'The DDC/I2C interface is not bonded out on typical NEO-6M breakout boards.',
  ],

  documentation: [
    { title: 'u-blox 6 Receiver Description Including Protocol Specification', section: 'GPS.G6-SW-10018' },
    { title: 'NEO-6 Data Sheet', section: 'GPS.G6-HW-09005' },
    { title: 'NMEA 0183 Standard', section: 'v4.10' },
  ],

  confidence: 'DOCUMENTED',
};
