# ESP32 Control Panel

A local web UI over the same hardware modules the MCP server uses. Point-and-click access
to inventory, interface discovery, I²C scanning and passive UART capture, with a live
monitor for streaming devices.

```
node gui/server.mjs
node gui/server.mjs --toolkit "D:\path\to\FirmwareToolkit"   # enables port auto-detection
node gui/server.mjs --allow-drive                            # permits operations that drive a pin
node gui/server.mjs --port 8080
```

Then open <http://127.0.0.1:7332>.

Requires `npm run build` first — the server imports from `dist/`.

## It shares the MCP server's implementation

`gui/server.mjs` is a transport, not a second implementation. Every operation calls the
same exported function the MCP tool calls (`dist/tools/hardware.js`, `execute.js`,
`component.js`, `serial.js`), so the panel and the agent cannot drift into disagreeing
about what the hardware said. Adding bus logic here would be a mistake — add it to
`src/hardware/` and expose it in both.

## Safety

The board is a general-purpose instrument: it will drive any pin a request names. A GUI
turns that from a considered call into a click, so the defaults are deliberately timid.

- **Loopback only.** The server binds `127.0.0.1`. This drives physical hardware; it has
  no business accepting connections from the network.
- **Drive operations are refused unless `--allow-drive` was passed.** The flag is read once
  at startup and never from a request, so the browser cannot talk the server into it.
  `spi.discover` counts as driving — it asserts CS and clocks SCLK.
- **UART capture is pinned to `PASSIVE` server-side.** The mode is not taken from the
  request. Transmitting on a bus whose wiring you cannot see is a drive operation.
- **Physically invalid operations are refused by the tools, not by this page.** GPIO6–11
  are wired to SPI flash and GPIO34–39 are input-only; a request naming one is rejected
  before anything reaches the serial link. The panel reports `executed: false` and whether
  a request was sent to the agent, because "refused" and "failed" are different outcomes.

Verified: `GPIO_WRITE` on pin 6 returns `PIN_RESERVED` with `executed: false` and
`agentRequest: null` — nothing was transmitted.

## Panels

| Panel | Notes |
|---|---|
| **Observe** | Inventory, interfaces, pin map, port detection. Read-only. |
| **I²C** | Address scan. Reports "nothing responded", never "the bus is empty". |
| **UART monitor** | One-shot or live passive capture, plus component identification. |
| **Drive pins** | Locked unless `--allow-drive`. Confirms before setting a level. |

## Live monitor

The agent caps each capture at **512 bytes**, so the live view is a series of short
captures streamed over SSE rather than one long read — a full GSV set from a GPS module
alone runs to four sentences. Server-Sent Events were chosen over WebSockets because the
data only flows one way and SSE needs no dependency.

## Reading the output honestly

The panel surfaces the confidence and source the tools attach, and it is worth keeping:

- `FIRMWARE_REPORT` — measured on the running chip.
- `ESP32_CATALOG` — datasheet figures for the family. **Not measured on this unit.**

Port detection's `isESP32` is a heuristic over the host's port description, which is why
the UI names the bridge that matched (`WCH CH34x`) rather than showing a bare yes. A CH340
could have any board behind it.

## Without FirmwareToolkit

Only port *auto-detection* needs it — it shells out to the toolkit's port manager.
Everything else takes an explicit port, so the panel stays fully usable: the port field is
free text, and it will tell you detection is unavailable rather than showing an empty list
that looks like "no board attached".
