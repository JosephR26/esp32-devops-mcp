/**
 * Bus discovery: inventory, interface discovery, I2C scan, SPI discovery and
 * UART discovery — all against mocked hardware.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  hardwareInventory,
  i2cScan,
  interfaceDiscovery,
  spiDiscovery,
  uartDiscovery,
} from '../src/tools/hardware.js';
import { resetTransportFactory, setTransportFactory } from '../src/hardware/transport.js';
import {
  BUS_ERROR_HANDLERS,
  EMPTY_BUS_HANDLERS,
  MockTransport,
  NEO6M_UART_HANDLERS,
  NRF24_SPI_HANDLERS,
  PN532_I2C_HANDLERS,
  SILENT_UART_HANDLERS,
  SPI_FLOATING_HANDLERS,
  UNSTABLE_DEVICE_HANDLERS,
  absentAgentTransport,
  malformedTransport,
  timeoutTransport,
  type MockHandler,
} from './helpers/mock-hardware.js';

function useMock(handlers: Record<string, MockHandler>): MockTransport {
  const transport = new MockTransport({ handlers });
  setTransportFactory(() => transport);
  return transport;
}

afterEach(() => resetTransportFactory());

describe('esp32_hardware_inventory', () => {
  it('reports live chip facts from the agent and labels catalog data as DOCUMENTED', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareInventory({ port: '/dev/ttyUSB0' });

    assert.equal(report.success, true);
    assert.equal(report.chip.family.value, 'ESP32');
    assert.equal(report.chip.family.source, 'FIRMWARE_REPORT');
    assert.equal(report.chip.cores.value, 2);
    assert.equal(report.chip.macAddress.value, '24:6F:28:AA:BB:CC');
    assert.equal(report.chip.flashSizeBytes.value, 4194304);
    assert.equal(report.chip.resetReason.value, 'POWERON');
    assert.equal(report.firmware.sdkVersion.value, 'v4.4.6');
    assert.equal(report.firmware.agentVersion.value, '1.0.0');

    // Peripheral counts come from the datasheet, not from measurement.
    assert.equal(report.peripherals.i2cControllers.value, 2);
    assert.equal(report.peripherals.i2cControllers.source, 'ESP32_CATALOG');
    assert.equal(report.peripherals.i2cControllers.confidence, 'DOCUMENTED');
    assert.equal(report.peripherals.dacChannels.value, 2);
  });

  it('returns UNKNOWN rather than guessing when the agent is absent', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await hardwareInventory({ port: '/dev/ttyUSB0' });

    assert.equal(report.chip.family.known, false);
    assert.equal(report.chip.family.value, null);
    assert.equal(report.chip.macAddress.known, false);
    assert.equal(report.peripherals.i2cControllers.known, false);
    assert.ok(report.warnings.some((w) => /interrogation-agent/.test(w)));
  });

  it('records which data sources answered', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareInventory({ port: '/dev/ttyUSB0' });

    const agent = report.sources.find((s) => s.name === 'interrogation-agent')!;
    const catalog = report.sources.find((s) => s.name === 'esp32-catalog')!;
    assert.equal(agent.available, true);
    assert.equal(catalog.available, true);
  });

  it('marks Wi-Fi and Bluetooth OBSERVED only from silicon feature bits', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await hardwareInventory({ port: '/dev/ttyUSB0' });

    const wifi = report.capabilities.capabilities.find((c) => c.name === 'radio.wifi')!;
    assert.equal(wifi.documented, true);
    assert.equal(wifi.observed, true, 'CHIP_FEATURE_WIFI_BGN was reported');
    assert.equal(wifi.status, 'OBSERVED');

    const psram = report.capabilities.capabilities.find((c) => c.name === 'memory.psram')!;
    assert.equal(psram.documented, true, 'ESP32 supports PSRAM per the datasheet');
    assert.equal(psram.observed, false, 'this unit reports 0 bytes of PSRAM');
    assert.equal(psram.status, 'UNTESTED');
  });

  it('rejects an invalid project path without touching hardware', async () => {
    const report = await hardwareInventory({ projectPath: 'bad<path>' });
    assert.equal(report.success, false);
    assert.match(report.error!, /Invalid project path/);
  });
});

describe('esp32_interface_discovery', () => {
  it('lists controllers with datasheet-sourced availability and reported default pins', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await interfaceDiscovery({ port: '/dev/ttyUSB0' });

    assert.equal(report.success, true);
    const i2c = report.interfaces.find((i) => i.controller === 'I2C0')!;
    assert.equal(i2c.available.value, true);
    assert.equal(i2c.available.source, 'ESP32_CATALOG');
    assert.equal(i2c.pins.find((p) => p.signal === 'SDA')!.gpio, 21);
    assert.equal(i2c.pins.find((p) => p.signal === 'SCL')!.gpio, 22);
  });

  it('flags UART0 as reserved for the agent link', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await interfaceDiscovery({ port: '/dev/ttyUSB0' });

    const uart0 = report.interfaces.find((i) => i.controller === 'UART0')!;
    assert.ok(uart0.conflicts.some((c) => /must not be reassigned/.test(c)));
  });

  it('states that no GPIO was driven', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await interfaceDiscovery({ port: '/dev/ttyUSB0' });
    assert.ok(report.notes.some((n) => /no pin was driven/i.test(n)));
  });

  it('filters to the requested interfaces', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await interfaceDiscovery({ port: '/dev/ttyUSB0', interfaces: ['I2C'] });
    assert.ok(report.interfaces.every((i) => i.kind === 'I2C'));
  });

  it('reports UNKNOWN availability when the chip family cannot be determined', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await interfaceDiscovery({ port: '/dev/ttyUSB0' });
    assert.equal(report.chip.known, false);
    assert.ok(report.interfaces.every((i) => i.available.known === false));
  });
});

describe('esp32_i2c_scan', () => {
  it('finds a responding device and reports hex, decimal, ACK and timing', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0' });

    assert.equal(report.success, true);
    assert.equal(report.responding.length, 1);
    const device = report.responding[0];
    assert.equal(device.address, 0x24);
    assert.equal(device.hex, '0x24');
    assert.equal(device.decimal, 36);
    assert.equal(device.state, 'RESPONDS');
    assert.equal(device.ack, true);
    assert.equal(device.responseTimeMs.value, 0.12);
    assert.ok(report.scanDurationMs >= 0);
  });

  it('offers address matches only as low-confidence, address-only hints', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0' });

    const hints = report.responding[0].possibleMatches;
    assert.ok(hints.length >= 1);
    assert.ok(hints.every((h) => h.addressOnly === true));
    assert.ok(hints.every((h) => h.confidence === 'LOW'));
    assert.ok(hints.some((h) => h.componentId === 'pn532'));
  });

  it('safely fingerprints a responder with a plain read', async () => {
    const transport = useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', fingerprint: true });

    assert.ok(report.responding[0].fingerprint);
    assert.ok(report.responding[0].fingerprint!.raw.length > 0);
    // A plain read carries no write payload — nothing can be interpreted as a command.
    const reads = transport.calls.filter((c) => c.op === 'i2c.read');
    assert.ok(reads.length > 0);
    assert.ok(reads.every((c) => c.params.write === undefined));
  });

  it('distinguishes NO_RESPONSE from a device being absent, and says so', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0' });

    assert.equal(report.success, true);
    assert.equal(report.responding.length, 0);
    assert.ok(report.results.every((r) => r.state === 'NO_RESPONSE' || r.state === 'RESERVED_SKIPPED'));
    assert.ok(
      report.warnings.some((w) => /does not establish that the bus is empty/.test(w)),
      'silence must not be reported as proof of absence'
    );
  });

  it('classifies an intermittent ACK as UNSTABLE', async () => {
    useMock(UNSTABLE_DEVICE_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', fingerprint: false, repeats: 3 });

    const device = report.results.find((r) => r.address === 0x3c)!;
    assert.equal(device.state, 'UNSTABLE');
    assert.equal(device.ackCount, 1);
    assert.equal(device.probeCount, 3);
  });

  it('classifies stable ACK with inconsistent data as ADDRESS_CONFLICT', async () => {
    useMock({
      ...UNSTABLE_DEVICE_HANDLERS,
      'i2c.scan': (params) => {
        const repeats = Number(params.repeats ?? 3);
        return {
          data: {
            addresses: [{ address: 0x3c, ackCount: repeats, probeCount: repeats, busErrors: 0 }],
            scanDurationMs: 40,
          },
        };
      },
    });
    const report = await i2cScan({ port: '/dev/ttyUSB0', fingerprint: true });

    const device = report.results.find((r) => r.address === 0x3c)!;
    assert.equal(device.state, 'ADDRESS_CONFLICT');
    assert.ok(device.errors.some((e) => /two.*devices/i.test(e)));
  });

  it('reports bus errors separately from silence', async () => {
    useMock(BUS_ERROR_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', startAddress: 0x20, endAddress: 0x20 });

    const device = report.results.find((r) => r.address === 0x20)!;
    assert.equal(device.state, 'BUS_ERROR');
    assert.equal(report.busErrors.length, 1);
    assert.match(report.busErrors[0], /pull-ups/);
  });

  it('skips I2C-reserved addresses instead of reporting them as devices', async () => {
    useMock(EMPTY_BUS_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', startAddress: 0x00, endAddress: 0x7f });

    assert.equal(report.results.find((r) => r.address === 0x00)!.state, 'RESERVED_SKIPPED');
    assert.equal(report.results.find((r) => r.address === 0x7f)!.state, 'RESERVED_SKIPPED');
    assert.equal(report.results.find((r) => r.address === 0x40)!.state, 'NO_RESPONSE');
  });

  it('rejects an out-of-range frequency', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', frequencyHz: 5_000_000 });
    assert.equal(report.success, false);
    assert.match(report.errors[0], /frequency out of range/i);
  });

  it('rejects an inverted address range', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', startAddress: 0x50, endAddress: 0x10 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /startAddress must not exceed endAddress/);
  });

  it('refuses to configure a reserved SPI-flash pin', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', sda: 6, scl: 22 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /GPIO6 is reserved/);
  });

  it('rejects the same pin assigned to SDA and SCL', async () => {
    useMock(PN532_I2C_HANDLERS);
    const report = await i2cScan({ port: '/dev/ttyUSB0', sda: 21, scl: 21 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /assigned to both/);
  });

  it('fails cleanly when the agent is absent', async () => {
    setTransportFactory(() => absentAgentTransport());
    const report = await i2cScan({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.ok(report.errors.some((e) => /agent/i.test(e)));
  });

  it('fails cleanly on a timeout and keeps the raw capture', async () => {
    setTransportFactory(() => timeoutTransport());
    const report = await i2cScan({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.ok(report.error);
  });

  it('fails cleanly on a malformed response', async () => {
    setTransportFactory(() => malformedTransport());
    const report = await i2cScan({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /malformed/i);
    assert.ok(report.raw.length > 0, 'raw capture is retained even when parsing failed');
  });
});

describe('esp32_spi_discovery', () => {
  it('requires an explicit chip-select pin', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /chip-select \(cs\) pin is required/);
  });

  it('runs named probe profiles and captures raw bytes', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      sclk: 18,
      miso: 19,
      mosi: 23,
      profiles: ['IDLE_READ'],
    });

    assert.equal(report.success, true);
    assert.equal(report.probes.length, 1);
    assert.equal(report.probes[0].probeId, 'IDLE_READ');
    assert.ok(report.probes[0].rx.length > 0);
    assert.ok(report.probes[0].rxHex.length > 0);
    assert.ok(report.raw.length > 0);
  });

  it('rejects an unknown preset name but points at the arbitrary-bytes path', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      profiles: ['NOT_A_PRESET'],
    });

    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /Unknown SPI preset/);
    assert.match(report.errors.join(' '), /pass them directly as `tx`/);
  });

  it('clocks arbitrary bytes with no preset and no component profile', async () => {
    const transport = useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      sclk: 18,
      miso: 19,
      mosi: 23,
      tx: [0xde, 0xad, 0xbe, 0xef],
    });

    assert.equal(report.success, true);
    const arbitrary = report.probes.find((p) => p.probeId === 'ARBITRARY')!;
    assert.ok(arbitrary, 'the caller-supplied transfer ran');
    assert.deepEqual(arbitrary.tx, [0xde, 0xad, 0xbe, 0xef]);

    const sent = transport.calls.find((c) => c.op === 'spi.transfer')!;
    assert.deepEqual(sent.params.tx, [0xde, 0xad, 0xbe, 0xef], 'bytes passed through unaltered');
  });

  it('does not run presets when explicit tx bytes are supplied', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      sclk: 18,
      miso: 19,
      mosi: 23,
      tx: [0x01],
    });

    assert.equal(report.probes.length, 1);
    assert.equal(report.probes[0].probeId, 'ARBITRARY');
  });

  it('flags an all-0xFF response as degenerate rather than as data', async () => {
    useMock(SPI_FLOATING_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      sclk: 18,
      miso: 19,
      mosi: 23,
    });

    assert.ok(report.probes.every((p) => p.degenerate));
    assert.equal(report.confidence, 'LOW');
    assert.ok(report.warnings.some((w) => /unconnected MISO/.test(w)));
    assert.equal(report.identification, null, 'no identification from a floating line');
  });

  it('runs a named component profile SPI probes and identifies the part', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({
      port: '/dev/ttyUSB0',
      cs: 5,
      sclk: 18,
      miso: 19,
      mosi: 23,
      component: 'nrf24l01',
      profiles: [],
    });

    assert.equal(report.success, true);
    assert.ok(report.probes.some((p) => p.probeId.startsWith('nrf24.')));
    assert.ok(report.identification);
    assert.equal(report.identification!.identified?.componentId, 'nrf24l01');
  });

  it('rejects an invalid SPI mode', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({ port: '/dev/ttyUSB0', cs: 5, mode: 7 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /Invalid SPI mode/);
  });

  it('refuses an input-only pin for an output signal', async () => {
    useMock(NRF24_SPI_HANDLERS);
    const report = await spiDiscovery({ port: '/dev/ttyUSB0', cs: 34, sclk: 18, mosi: 23, miso: 19 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /input-only/);
  });
});

describe('esp32_uart_discovery', () => {
  it('requires an rx pin', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /rx pin is required/);
  });

  it('captures a passive stream with hex, ASCII, packets and timing', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, baud: 9600 });

    assert.equal(report.success, true);
    assert.equal(report.mode, 'PASSIVE');
    assert.ok(report.totalBytes > 0);
    assert.ok(report.hex.length > 0);
    assert.ok(report.ascii!.includes('$GPGGA'));
    assert.ok(report.packets.length > 0);
    assert.equal(report.packets[0].printable, true);
  });

  it('recognises NMEA framing as a protocol candidate', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16 });
    assert.ok(report.protocolCandidates.some((c) => c.componentId === 'protocol:nmea0183'));
  });

  it('identifies the NEO-6M from the capture', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, component: 'neo-6m' });
    assert.ok(report.protocolCandidates.some((c) => c.componentId === 'neo-6m'));
  });

  it('never transmits in PASSIVE mode', async () => {
    const transport = useMock(NEO6M_UART_HANDLERS);
    await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, tx: 17 });
    assert.equal(transport.countOf('uart.writeRead'), 0);
  });

  it('refuses ACTIVE mode only when given nothing to send', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, mode: 'ACTIVE' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /ACTIVE mode needs something to send/);
  });

  it('transmits arbitrary bytes in ACTIVE mode with no component profile', async () => {
    const transport = useMock({
      ...NEO6M_UART_HANDLERS,
      'uart.writeRead': () => ({ data: { bytes: [0x4f, 0x4b], durationUs: 900, complete: true } }),
    });

    const report = await uartDiscovery({
      port: '/dev/ttyUSB0',
      rx: 16,
      tx: 17,
      mode: 'ACTIVE',
      transmit: [0x41, 0x54, 0x0d],
    });

    assert.equal(report.success, true);
    const sent = transport.calls.find((c) => c.op === 'uart.writeRead')!;
    assert.deepEqual(sent.params.write, [0x41, 0x54, 0x0d], 'bytes passed through unaltered');
  });

  it('does not treat silence as proof of an idle bus', async () => {
    useMock(SILENT_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16 });

    assert.equal(report.totalBytes, 0);
    assert.equal(report.confidence, 'UNKNOWN');
    assert.ok(report.warnings.some((w) => /does not establish silence/.test(w)));
  });

  it('scans candidate baud rates passively', async () => {
    const transport = useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, scanBauds: true });

    assert.ok(report.baudClues.length > 1);
    assert.ok(transport.countOf('uart.listen') > 1);
    assert.equal(transport.countOf('uart.writeRead'), 0, 'baud scanning stays passive');
  });

  it('rejects hardware flow control, which the agent does not implement', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, flowControl: 'rtscts' });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /flow control is not supported/i);
  });

  it('rejects UART0, which carries the agent link', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, controller: 0 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /UART0 carries the interrogation agent link/);
  });

  it('rejects an out-of-range baud rate', async () => {
    useMock(NEO6M_UART_HANDLERS);
    const report = await uartDiscovery({ port: '/dev/ttyUSB0', rx: 16, baud: 99 });
    assert.equal(report.success, false);
    assert.match(report.errors.join(' '), /Baud out of range/);
  });
});
