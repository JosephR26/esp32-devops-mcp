#!/usr/bin/env node
/**
 * Local control panel for the ESP32 interrogation tools.
 *
 * This server is a thin transport over the SAME modules the MCP server uses —
 * dist/tools/*. It deliberately contains no bus logic of its own. Two codepaths
 * talking to one board is how they drift and start disagreeing about what the
 * hardware said.
 *
 * Run:  node gui/server.mjs [--port 7332] [--allow-drive]
 *
 * Safety posture:
 *   - Binds to 127.0.0.1 only. This drives physical hardware; it has no business
 *     accepting connections from the network.
 *   - Operations that DRIVE a pin are refused unless --allow-drive was passed.
 *     The browser cannot talk the server into it, because the flag is read once
 *     at startup and never from a request.
 *   - UART capture is forced to PASSIVE. Transmitting is a drive operation.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const DIST = pathToFileURL(join(HERE, '..', 'dist')).href;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(value('--port', 7332));
const ALLOW_DRIVE = flag('--allow-drive');

// Port *detection* shells out to FirmwareToolkit; everything else takes an explicit
// port and does not need it. Set before the tool modules are imported so their lazy
// path resolution sees it.
const TOOLKIT = value('--toolkit', process.env.FIRMWARE_TOOLKIT_PATH);
if (TOOLKIT) process.env.FIRMWARE_TOOLKIT_PATH = TOOLKIT;

const { hardwareInventory, interfaceDiscovery, i2cScan, uartDiscovery, spiDiscovery } =
  await import(`${DIST}/tools/hardware.js`);
const { detectESP32Ports, listSerialPorts } = await import(`${DIST}/tools/serial.js`);
const { pinCapabilityReport, hardwareExecute } = await import(`${DIST}/tools/execute.js`);
const { componentIdentify } = await import(`${DIST}/tools/component.js`);

/**
 * The action registry.
 *
 * `drives` marks an action that can put a pin into a driven state. It is the
 * single place that distinction lives, so the UI and the guard cannot disagree
 * about which is which.
 */
const ACTIONS = {
  'ports.detect': { drives: false, run: () => detectESP32Ports() },
  'ports.list': { drives: false, run: () => listSerialPorts() },
  'device.inventory': { drives: false, run: (p) => hardwareInventory({ port: p.port }) },
  'device.interfaces': { drives: false, run: (p) => interfaceDiscovery({ port: p.port }) },
  'device.pins': { drives: false, run: (p) => pinCapabilityReport({ port: p.port, filter: p.filter }) },

  // A bus scan asserts the bus but addresses no pin the caller did not name, and
  // reads nothing back beyond an ACK. Treated as observation, not drive.
  'i2c.scan': {
    drives: false,
    run: (p) => i2cScan({
      port: p.port,
      sda: p.sda,
      scl: p.scl,
      frequencyHz: p.frequencyHz,
      repeats: p.repeats ?? 3,
      fingerprint: p.fingerprint ?? true,
    }),
  },

  // mode is pinned to PASSIVE here, not taken from the request: transmitting on a
  // bus whose wiring we cannot see is a drive operation.
  'uart.capture': {
    drives: false,
    run: (p) => uartDiscovery({
      port: p.port,
      rx: p.rx,
      baud: p.baud ?? 9600,
      durationMs: Math.min(p.durationMs ?? 3000, 10000),
      mode: 'PASSIVE',
      scanBauds: p.scanBauds ?? false,
    }),
  },

  'spi.discover': {
    drives: true, // asserts CS and clocks SCLK — this moves pins
    run: (p) => spiDiscovery({
      port: p.port, cs: p.cs, mosi: p.mosi, miso: p.miso, sclk: p.sclk,
      mode: p.mode, clockHz: p.clockHz, profiles: p.profiles,
    }),
  },

  'component.identify': {
    drives: false,
    run: (p) => componentIdentify({
      port: p.port, interface: p.interface ?? 'UART',
      rx: p.rx, address: p.address, sda: p.sda, scl: p.scl,
      baud: p.baud, depth: p.depth ?? 'STANDARD', markings: p.markings,
    }),
  },

  'hardware.execute': {
    drives: true,
    run: (p) => hardwareExecute({
      port: p.port, operations: p.operations, defaults: p.defaults,
      repetitions: p.repetitions ?? 1, stopOnError: p.stopOnError ?? false,
    }),
  },
};

/**
 * One serial port, one operation at a time.
 *
 * The MCP server never needed this: Claude issues tool calls sequentially. A GUI
 * does not — two buttons clicked in quick succession race for the same port, and
 * the loser gets `PermissionError(13, 'Access is denied.')` from Windows.
 *
 * That failure is quiet rather than loud: the interrogation tools degrade to
 * datasheet-only answers and still report success, warning that the agent firmware
 * may be missing. So a collision does not look like a collision — it looks like a
 * board that needs reflashing. Serialising here removes the whole class of it.
 */
const portQueues = new Map();

function withPortLock(port, task) {
  const key = port ?? '<default>';
  const previous = portQueues.get(key) ?? Promise.resolve();

  // Run after the previous task however it settled — otherwise one failure wedges
  // the queue for that port permanently.
  const result = previous.then(task, task);

  // The queue tracks completion only, never results, so nothing is retained.
  const settled = result.then(() => {}, () => {});
  portQueues.set(key, settled);
  settled.finally(() => {
    if (portQueues.get(key) === settled) portQueues.delete(key);
  });

  return result;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Contain the path inside PUBLIC_DIR — normalise, then verify the prefix.
  const target = normalize(join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/** SSE stream: repeated short captures, because the agent caps each at 512 bytes. */
async function streamUart(req, res, params) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  let live = true;
  req.on('close', () => { live = false; });

  const send = (event, data) => {
    if (!live) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { streaming: true, note: 'Repeated passive captures. Each is capped by the agent at 512 bytes.' });

  while (live) {
    try {
      // Through the same lock as one-shot actions: a live stream must not hold the
      // port against a button press, nor collide with one.
      const capture = await withPortLock(params.port, () => uartDiscovery({
        port: params.port,
        rx: Number(params.rx),
        baud: Number(params.baud ?? 9600),
        durationMs: 1500,
        mode: 'PASSIVE',
      }));
      if (!live) break;
      send('capture', {
        at: capture.raw?.[0]?.timestamp ?? null,
        totalBytes: capture.totalBytes,
        ascii: capture.ascii ?? '',
        protocolCandidates: capture.protocolCandidates ?? [],
        warnings: capture.warnings ?? [],
      });
    } catch (error) {
      send('error', { message: error?.message ?? String(error) });
      break;
    }
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/meta') {
    return sendJson(res, 200, {
      allowDrive: ALLOW_DRIVE,
      actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, { drives: v.drives }])),
    });
  }

  if (url.pathname === '/api/uart/stream') {
    if (!url.searchParams.get('rx')) return sendJson(res, 400, { error: 'rx is required' });
    return streamUart(req, res, Object.fromEntries(url.searchParams));
  }

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length);
    const action = ACTIONS[name];
    if (!action) return sendJson(res, 404, { error: `unknown action: ${name}` });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required' });

    if (action.drives && !ALLOW_DRIVE) {
      return sendJson(res, 403, {
        error: `"${name}" can drive a pin, and this server was started without --allow-drive.`,
        remedy: 'Restart with --allow-drive if you intend to drive pins.',
      });
    }

    try {
      const params = await readBody(req);
      const started = Date.now();
      let ranAt = started;
      const result = await withPortLock(params.port, () => {
        ranAt = Date.now();
        return action.run(params);
      });
      return sendJson(res, 200, {
        ok: true,
        action: name,
        elapsedMs: Date.now() - started,
        // Time spent waiting for the port, so a queued request can be told from a slow one.
        queuedMs: ranAt - started,
        result,
      });
    } catch (error) {
      return sendJson(res, 500, { ok: false, action: name, error: error?.message ?? String(error) });
    }
  }

  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ESP32 control panel  →  http://127.0.0.1:${PORT}`);
  console.log(`  drive operations: ${ALLOW_DRIVE ? 'ENABLED (--allow-drive)' : 'refused (pass --allow-drive to enable)'}`);
  console.log(`  toolkit: ${TOOLKIT ?? 'not set — port auto-detection unavailable, type the port instead'}`);
  console.log('  bound to loopback only');
});
