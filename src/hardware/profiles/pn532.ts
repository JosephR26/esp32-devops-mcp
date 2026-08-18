/**
 * NXP PN532 — NFC/RFID controller.
 *
 * This is a component profile, not a special case: the interrogation engine has
 * no PN532-specific code. Everything below is data the generic engine consumes.
 *
 * Primary reference: NXP UM0701-02 "PN532 User Manual" and the PN532/C1
 * datasheet. Bitfield layouts for the contactless interface unit (CIU) registers
 * follow NXP's CIU documentation and are DOCUMENTED evidence only — they have
 * not been verified against silicon by this system.
 */

import type { ComponentProfile } from '../../types/hardware.js';

/**
 * PN532 normal information frame carrying GetFirmwareVersion (TFI 0xD4, cmd 0x02).
 *
 *   00 00 FF   preamble + start code
 *   02         LEN  (TFI + command byte)
 *   FE         LCS  (0x100 - LEN)
 *   D4 02      TFI (host->PN532) + GetFirmwareVersion
 *   2A         DCS  (0x100 - (0xD4 + 0x02))
 *   00         postamble
 */
const GET_FIRMWARE_VERSION_FRAME = [0x00, 0x00, 0xff, 0x02, 0xfe, 0xd4, 0x02, 0x2a, 0x00];

/** GetGeneralStatus (TFI 0xD4, cmd 0x04): LEN=02, LCS=FE, DCS=0x100-(D4+04)=0x28. */
const GET_GENERAL_STATUS_FRAME = [0x00, 0x00, 0xff, 0x02, 0xfe, 0xd4, 0x04, 0x28, 0x00];

/** ReadRegister (TFI 0xD4, cmd 0x06) for a single 16-bit CIU address. */
function readRegisterFrame(address: number): number[] {
  const hi = (address >> 8) & 0xff;
  const lo = address & 0xff;
  const len = 4; // TFI + cmd + ADDRH + ADDRL
  const lcs = (0x100 - len) & 0xff;
  const dcs = (0x100 - ((0xd4 + 0x06 + hi + lo) & 0xff)) & 0xff;
  return [0x00, 0x00, 0xff, len, lcs, 0xd4, 0x06, hi, lo, dcs, 0x00];
}

const I2C_ADDRESS = 0x24;

export const PN532_PROFILE: ComponentProfile = {
  id: 'pn532',
  manufacturer: 'NXP Semiconductors',
  partNumber: 'PN532',
  aliases: ['pn532/c1', 'pn5321', 'elechouse-pn532', 'nfc-shield'],
  description:
    'Highly integrated 13.56 MHz NFC/RFID controller supporting reader/writer, ' +
    'card emulation and peer-to-peer modes over I2C, SPI or HSU.',

  interfaces: [
    {
      kind: 'I2C',
      addresses: [I2C_ADDRESS],
      defaultClockHz: 100000,
      signals: ['SDA', 'SCL', 'IRQ', 'RSTO'],
      note:
        '7-bit address 0x24, fixed. I2C reads are prefixed by a one-byte ready ' +
        'status (0x01 = data available).',
    },
    {
      kind: 'SPI',
      defaultClockHz: 1000000,
      spiMode: 0,
      signals: ['SCK', 'MISO', 'MOSI', 'SS'],
      note:
        'SPI on the PN532 is LSB-first, mode 0. Frames are prefixed with a data ' +
        'direction byte (0x01 write, 0x03 read, 0x02 status).',
    },
    {
      kind: 'UART',
      defaultBaud: 115200,
      signals: ['TX', 'RX'],
      note: 'HSU mode. Default 115200 8N1; the host may raise it after handshake.',
    },
  ],

  identification: [
    {
      id: 'pn532.i2c-address',
      description: 'Responds at I2C address 0x24',
      weight: 0.2,
      match: { kind: 'I2C_ADDRESS', addresses: [I2C_ADDRESS] },
      reference: 'UM0701-02 §6.2.4',
    },
    {
      id: 'pn532.firmware-version-signature',
      description:
        'GetFirmwareVersion response carries D5 03 followed by IC code 0x32 (PN532)',
      weight: 0.8,
      necessary: true,
      match: { kind: 'PROBE_RESPONSE', probeId: 'pn532.firmware_version', pattern: 'D5 03 32' },
      reference: 'UM0701-02 §7.2.2 GetFirmwareVersion',
    },
    {
      id: 'pn532.ack-frame',
      description: 'Emits the documented ACK frame 00 00 FF 00 FF 00 before responding',
      weight: 0.4,
      match: { kind: 'PROBE_RESPONSE', probeId: 'pn532.firmware_version', pattern: '00 00 FF 00 FF 00' },
      reference: 'UM0701-02 §6.2.1.6 ACK frame',
    },
    {
      id: 'pn532.marking',
      description: 'Board or chip marking names the PN532',
      weight: 0.3,
      match: { kind: 'MARKING', patterns: ['pn532', 'pn5321', 'nfc'] },
    },
  ],

  registers: [
    {
      address: 0x6338,
      name: 'CIU_Status2',
      description: 'Contactless interface unit status: modem state and crypto flag',
      width: 8,
      access: 'R',
      fields: [
        {
          name: 'ModemState',
          bitOffset: 0,
          bitWidth: 3,
          description: 'Current state of the CIU modem state machine',
          enumerations: {
            '0': 'Idle',
            '1': 'Wait for StartSend',
            '2': 'TxWait',
            '3': 'Transmitting',
            '4': 'RxWait',
            '5': 'Wait for data',
            '6': 'Receiving',
          },
        },
        {
          name: 'MFCrypto1On',
          bitOffset: 3,
          bitWidth: 1,
          description: 'MIFARE Crypto1 unit is active (set by a successful authentication)',
          enumerations: { '0': 'Inactive', '1': 'Active' },
        },
      ],
      safeToRead: true,
      readProbeId: 'pn532.read_status2',
      reference: 'UM0701-02 §8.6.2 ReadRegister; NXP CIU register map',
    },
    {
      address: 0x6302,
      name: 'CIU_TxMode',
      description: 'Transmit data rate and framing configuration',
      width: 8,
      access: 'R',
      fields: [
        {
          name: 'TxSpeed',
          bitOffset: 4,
          bitWidth: 3,
          description: 'Transmit bit rate',
          enumerations: { '0': '106 kbit/s', '1': '212 kbit/s', '2': '424 kbit/s', '3': '848 kbit/s' },
        },
        { name: 'InvMod', bitOffset: 3, bitWidth: 1, description: 'Modulation inverted' },
        { name: 'TxCRCEn', bitOffset: 7, bitWidth: 1, description: 'CRC generated on transmit' },
      ],
      safeToRead: true,
      readProbeId: 'pn532.read_txmode',
      reference: 'UM0701-02 §8.6.2; NXP CIU register map',
    },
    {
      address: 0x6303,
      name: 'CIU_RxMode',
      description: 'Receive data rate and framing configuration',
      width: 8,
      access: 'R',
      fields: [
        {
          name: 'RxSpeed',
          bitOffset: 4,
          bitWidth: 3,
          description: 'Receive bit rate',
          enumerations: { '0': '106 kbit/s', '1': '212 kbit/s', '2': '424 kbit/s', '3': '848 kbit/s' },
        },
        { name: 'RxMultiple', bitOffset: 2, bitWidth: 1, description: 'Multiple frame reception' },
        { name: 'RxNoErr', bitOffset: 3, bitWidth: 1, description: 'Invalid frames are discarded' },
        { name: 'RxCRCEn', bitOffset: 7, bitWidth: 1, description: 'CRC checked on receive' },
      ],
      safeToRead: true,
      readProbeId: 'pn532.read_rxmode',
      reference: 'UM0701-02 §8.6.2; NXP CIU register map',
    },
  ],

  protocols: [
    {
      name: 'PN532 normal information frame',
      description:
        'Preamble 00 00 FF, LEN, LCS, TFI, payload, DCS, postamble. TFI 0xD4 = host to ' +
        'PN532, 0xD5 = PN532 to host.',
      signatures: ['00 00 FF', 'D4', 'D5'],
      reference: 'UM0701-02 §6.2.1.1',
    },
    { name: 'ISO/IEC 14443 Type A', reference: 'PN532 datasheet §5' },
    { name: 'ISO/IEC 14443 Type B', reference: 'PN532 datasheet §5' },
    { name: 'FeliCa (JIS X 6319-4)', reference: 'PN532 datasheet §5' },
    { name: 'MIFARE Classic (Crypto1)', reference: 'PN532 datasheet §5' },
    { name: 'ISO/IEC 18092 NFCIP-1 peer-to-peer', reference: 'PN532 datasheet §5' },
  ],

  modes: [
    { name: 'Reader/Writer', description: 'Polls and communicates with passive targets', reference: 'UM0701-02 §7.3' },
    { name: 'Card Emulation', description: 'Presents as an ISO14443-4 target', reference: 'UM0701-02 §7.3' },
    { name: 'Peer-to-Peer (NFCIP-1)', description: 'Initiator or target DEP exchange', reference: 'UM0701-02 §7.3' },
    { name: 'Low VBAT power-down', description: 'Entered with PowerDown (D4 16)', entryNote: 'Requires an explicit host command; not exercised by interrogation.', reference: 'UM0701-02 §7.2.11' },
  ],

  capabilities: [
    { name: 'interface.i2c', category: 'INTERFACE', documented: true, softwareSupported: true, description: 'I2C slave at 0x24', evidenceProbes: ['pn532.firmware_version'], reference: 'UM0701-02 §6.2.4' },
    { name: 'interface.spi', category: 'INTERFACE', documented: true, softwareSupported: true, description: 'SPI slave, LSB-first mode 0', reference: 'UM0701-02 §6.2.5' },
    { name: 'interface.hsu', category: 'INTERFACE', documented: true, softwareSupported: true, description: 'High-speed UART', reference: 'UM0701-02 §6.2.3' },
    { name: 'identification.firmware_version', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, description: 'GetFirmwareVersion reports IC, version, revision and supported modes', evidenceProbes: ['pn532.firmware_version'], reference: 'UM0701-02 §7.2.2' },
    { name: 'diagnostic.general_status', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, description: 'GetGeneralStatus reports error code, field presence and target status', evidenceProbes: ['pn532.general_status'], reference: 'UM0701-02 §7.2.3' },
    { name: 'diagnostic.register_read', category: 'DIAGNOSTIC', documented: true, softwareSupported: true, description: 'ReadRegister exposes CIU internal registers', evidenceProbes: ['pn532.read_status2'], reference: 'UM0701-02 §7.2.4' },
    { name: 'protocol.iso14443a', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'ISO14443 Type A reader/writer' },
    { name: 'protocol.iso14443b', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'ISO14443 Type B reader/writer' },
    { name: 'protocol.felica', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'FeliCa 212/424 kbit/s' },
    { name: 'protocol.mifare_classic', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'MIFARE Classic with Crypto1 authentication' },
    { name: 'protocol.nfcip1_p2p', category: 'PROTOCOL', documented: true, softwareSupported: true, description: 'NFCIP-1 peer-to-peer DEP' },
    { name: 'mode.card_emulation', category: 'MODE', documented: true, softwareSupported: false, description: 'Target/card emulation mode' },
    { name: 'power.low_vbat', category: 'POWER', documented: true, softwareSupported: false, description: 'Low-VBAT power-down mode with wake-on-IRQ' },
    { name: 'feature.rf_field_control', category: 'FEATURE', documented: true, softwareSupported: true, description: 'RFConfiguration controls RF field, retries and timings' },
  ],

  safeProbes: [
    {
      id: 'pn532.firmware_version',
      name: 'GetFirmwareVersion',
      description:
        'Sends the documented GetFirmwareVersion command and reads the ACK frame ' +
        'followed by the response frame.',
      interface: 'I2C',
      justification:
        'GetFirmwareVersion is a pure query. It reads identity data and changes no ' +
        'configuration, no RF field state and no stored data.',
      writes: true,
      writeJustification:
        'The PN532 is a command-protocol device with no addressable register file over ' +
        'I2C. Obtaining identity requires transmitting the documented command frame. ' +
        'The command itself is read-only in effect and is reversible by doing nothing.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: I2C_ADDRESS, write: GET_FIRMWARE_VERSION_FRAME, readLength: 8, delayMs: 10 },
        { op: 'DELAY', ms: 20 },
        { op: 'I2C_READ', address: I2C_ADDRESS, length: 16 },
      ],
      expect: { pattern: 'D5 03', minBytes: 8 },
      yields: ['IC code', 'firmware version', 'firmware revision', 'supported protocol mask'],
      minDepth: 'BASIC',
      reference: 'UM0701-02 §7.2.2',
    },
    {
      id: 'pn532.general_status',
      name: 'GetGeneralStatus',
      description: 'Reads last error code, external RF field presence and target status.',
      interface: 'I2C',
      justification: 'Status query only — reports state without altering it.',
      writes: true,
      writeJustification:
        'Required command frame for a status query on a command-protocol device. No ' +
        'configuration is modified.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: I2C_ADDRESS, write: GET_GENERAL_STATUS_FRAME, readLength: 8, delayMs: 10 },
        { op: 'DELAY', ms: 20 },
        { op: 'I2C_READ', address: I2C_ADDRESS, length: 20 },
      ],
      expect: { pattern: 'D5 05', minBytes: 8 },
      yields: ['last error', 'external field detected', 'number of targets'],
      minDepth: 'STANDARD',
      reference: 'UM0701-02 §7.2.3',
    },
    {
      id: 'pn532.read_status2',
      name: 'ReadRegister CIU_Status2 (0x6338)',
      description: 'Reads one documented CIU status register through ReadRegister.',
      interface: 'I2C',
      justification: 'ReadRegister is a read primitive; the target register has no read side effects.',
      writes: true,
      writeJustification: 'ReadRegister requires the command frame naming the register address.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: I2C_ADDRESS, write: readRegisterFrame(0x6338), readLength: 8, delayMs: 10 },
        { op: 'DELAY', ms: 20 },
        { op: 'I2C_READ', address: I2C_ADDRESS, length: 16 },
      ],
      expect: { pattern: 'D5 07', minBytes: 8 },
      yields: ['CIU_Status2 value'],
      minDepth: 'DEEP',
      reference: 'UM0701-02 §7.2.4',
    },
    {
      id: 'pn532.read_txmode',
      name: 'ReadRegister CIU_TxMode (0x6302)',
      description: 'Reads the transmit framing/rate configuration register.',
      interface: 'I2C',
      justification: 'Configuration inspection only; the register has no read side effects.',
      writes: true,
      writeJustification: 'ReadRegister requires the command frame naming the register address.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: I2C_ADDRESS, write: readRegisterFrame(0x6302), readLength: 8, delayMs: 10 },
        { op: 'DELAY', ms: 20 },
        { op: 'I2C_READ', address: I2C_ADDRESS, length: 16 },
      ],
      expect: { pattern: 'D5 07', minBytes: 8 },
      yields: ['CIU_TxMode value'],
      minDepth: 'DEEP',
      reference: 'UM0701-02 §7.2.4',
    },
    {
      id: 'pn532.read_rxmode',
      name: 'ReadRegister CIU_RxMode (0x6303)',
      description: 'Reads the receive framing/rate configuration register.',
      interface: 'I2C',
      justification: 'Configuration inspection only; the register has no read side effects.',
      writes: true,
      writeJustification: 'ReadRegister requires the command frame naming the register address.',
      reversible: true,
      operations: [
        { op: 'I2C_WRITE_READ', address: I2C_ADDRESS, write: readRegisterFrame(0x6303), readLength: 8, delayMs: 10 },
        { op: 'DELAY', ms: 20 },
        { op: 'I2C_READ', address: I2C_ADDRESS, length: 16 },
      ],
      expect: { pattern: 'D5 07', minBytes: 8 },
      yields: ['CIU_RxMode value'],
      minDepth: 'DEEP',
      reference: 'UM0701-02 §7.2.4',
    },
    {
      id: 'pn532.presence',
      name: 'Address presence check',
      description: 'Reads the I2C ready-status byte without issuing a command.',
      interface: 'I2C',
      justification: 'Pure read of the status byte. Emits no command and changes nothing.',
      writes: false,
      reversible: true,
      operations: [{ op: 'I2C_READ', address: I2C_ADDRESS, length: 1 }],
      expect: { minBytes: 1 },
      yields: ['bus presence', 'ready status byte'],
      minDepth: 'BASIC',
      reference: 'UM0701-02 §6.2.4',
    },
  ],

  functionalTests: [
    {
      id: 'pn532.test.identity',
      name: 'Identity readback',
      capability: 'identification.firmware_version',
      objective: 'Confirm the device returns the documented GetFirmwareVersion response frame.',
      procedure: [
        'Send the GetFirmwareVersion command frame over I2C.',
        'Read the ACK frame.',
        'Read the response frame.',
        'Assert the response carries TFI 0xD5, command 0x03 and IC code 0x32.',
      ],
      expectedResult: 'Response contains D5 03 32 followed by version, revision and support bytes.',
      probes: ['pn532.firmware_version'],
      expectPattern: 'D5 03 32',
      expectMinBytes: 8,
      minDepth: 'BASIC',
      reference: 'UM0701-02 §7.2.2',
    },
    {
      id: 'pn532.test.communication',
      name: 'Bus communication',
      capability: 'interface.i2c',
      objective: 'Confirm the device acknowledges its I2C address and returns a status byte.',
      procedure: ['Read one byte from address 0x24.', 'Assert at least one byte was received.'],
      expectedResult: 'One status byte is returned without a bus error.',
      probes: ['pn532.presence'],
      expectMinBytes: 1,
      minDepth: 'BASIC',
    },
    {
      id: 'pn532.test.status_report',
      name: 'General status reporting',
      capability: 'diagnostic.general_status',
      objective: 'Confirm GetGeneralStatus returns a well-formed response frame.',
      procedure: ['Send GetGeneralStatus.', 'Read the response.', 'Assert TFI 0xD5 command 0x05.'],
      expectedResult: 'Response contains D5 05 followed by error code and target information.',
      probes: ['pn532.general_status'],
      expectPattern: 'D5 05',
      minDepth: 'STANDARD',
      reference: 'UM0701-02 §7.2.3',
    },
    {
      id: 'pn532.test.register_read',
      name: 'CIU register readback',
      capability: 'diagnostic.register_read',
      objective: 'Confirm ReadRegister returns a value for a documented CIU register.',
      procedure: ['Issue ReadRegister for 0x6338.', 'Assert a D5 07 response frame is returned.'],
      expectedResult: 'Response contains D5 07 followed by the register value.',
      probes: ['pn532.read_status2'],
      expectPattern: 'D5 07',
      minDepth: 'DEEP',
      reference: 'UM0701-02 §7.2.4',
    },
    {
      id: 'pn532.test.consistency',
      name: 'Identity response consistency',
      capability: 'identification.firmware_version',
      objective: 'Confirm repeated identity queries return an identical response.',
      procedure: ['Issue GetFirmwareVersion.', 'Compare against the first recorded response.'],
      expectedResult: 'Byte-identical response across repetitions.',
      probes: ['pn532.firmware_version'],
      expectPattern: 'D5 03 32',
      minDepth: 'FORENSIC',
    },
  ],

  benchmarks: [
    {
      id: 'pn532.bench.identity_latency',
      name: 'GetFirmwareVersion round-trip latency',
      metric: 'RESPONSE_LATENCY',
      probeId: 'pn532.firmware_version',
      iterations: 20,
      unit: 'ms',
      reference: 'No datasheet figure — command latency is not specified.',
    },
    {
      id: 'pn532.bench.status_poll_rate',
      name: 'Status byte polling rate',
      metric: 'POLLING_RATE',
      probeId: 'pn532.presence',
      iterations: 50,
      unit: 'reads/s',
    },
    {
      id: 'pn532.bench.identity_consistency',
      name: 'Identity response consistency',
      metric: 'READ_CONSISTENCY',
      probeId: 'pn532.firmware_version',
      iterations: 15,
      unit: 'agreement ratio',
    },
  ],

  limitations: [
    // ── Interface and addressing ──────────────────────────────────────────────
    'The PN532 has no flat register file over I2C — all access is through the command protocol.',
    'CIU register bitfield layouts are taken from NXP CIU documentation and are DOCUMENTED, not verified against this silicon.',
    'I2C reads are prefixed by a ready-status byte; frame offsets in raw captures shift by one accordingly.',
    'Interface selection is set by hardware DIP switches or strapping on most breakout boards and cannot be read back over the bus.',
    'Card emulation and peer-to-peer modes are not exercised by interrogation — they require an RF counterpart.',

    // ── Framing, established against physical hardware ────────────────────────
    // Each of these produces a symptom that reads as a fault in something else,
    // which is why they are recorded here rather than left to be rediscovered.
    'A command is answered in TWO parts: an ACK frame first, then the response once ready. A single read returns the ACK plus stale bytes and decodes as nonsense.',
    'The read buffer retains the PREVIOUS response. Bytes following a short frame are residue, not part of the current frame, and they decode plausibly enough to be mistaken for data. Trust the declared frame length.',
    'A command already in flight is aborted by writing a bare ACK frame: 00 00 FF 00 FF 00.',
    'SAMConfiguration should be issued after power-up before polling; some boards will not activate a target without it.',
    'Size reads generously. An ISO14443-4 activation carrying an ATS ran to 34 bytes on real hardware, and a 28-byte read truncated it mid-ATS.',

    // ── Polling behaviour ─────────────────────────────────────────────────────
    'InListPassiveTarget defaults to MxRtyPassiveActivation = 0xFF, meaning retry forever. With no target in the field the command never returns and the ready byte stays 0x00 — indistinguishable from a broken device.',
    'Cap retries with RFConfiguration item 0x05 before polling, so "no target" comes back as NbTg=0 — a result rather than a hang.',

    // ── SPI, established over a long evening ──────────────────────────────────
    // Recorded so the next person spends ten seconds rather than repeating all of it.
    'SPI mode is UNRELIABLE on breakout clones. If SPI is silent on a clone, prefer I2C rather than pursuing it — the board that never modulated MISO in any SPI configuration worked over I2C first time.',
    'That SPI verdict was reached by elimination, not assumption: continuity probed pin-to-pad, interface-select switches confirmed with a meter and all four positions tried, CS settling delays added, mode 0 and LSB-first per the datasheet, and RSTO measured driven high so the chip was awake and out of reset.',
    'The host SPI path was proven independently by a loopback that echoed perfectly, which is what made every earlier negative result mean anything. Establish that positive control BEFORE concluding anything from silence.',
    'The PN532 uses LSB-FIRST bit order on SPI, unlike almost every other SPI device. Getting this wrong produces plausible-looking garbage rather than an obvious failure.',
    'SPI framing is prefixed by a direction byte: 0x01 data write, 0x02 status read, 0x03 data read. The status byte returns 0x01 when the device is ready.',

    // ── RF band ───────────────────────────────────────────────────────────────
    'The PN532 operates at 13.56 MHz ONLY. Low-frequency credentials (125 kHz EM4100, HID Prox and similar — most door-entry and building fobs) are in a different band and cannot be detected at any range.',
    'A poll returning NbTg=0 with a low-frequency fob present is correct behaviour, not a failure. No amount of repositioning will change it.',
  ],

  documentation: [
    { title: 'PN532 User Manual', section: 'UM0701-02', note: 'Command set, framing, register access' },
    { title: 'PN532/C1 Datasheet', note: 'Electrical characteristics and supported protocols' },
    { title: 'ISO/IEC 14443', note: 'Contactless proximity card protocol' },
  ],

  confidence: 'DOCUMENTED',
};
