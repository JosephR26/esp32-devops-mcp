'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let meta = { allowDrive: false, actions: {} };
let stream = null;

// ── DOM construction ───────────────────────────────────
//
// Everything rendered here is built with textContent and createElement, never
// innerHTML. This page displays data from DEVICES WE DO NOT TRUST — that is the
// whole purpose of the tool — and it can also drive pins when the server is started
// with --allow-drive. Script injected via a crafted USB product string or a device's
// output would therefore be able to call /api/hardware.execute. Untrusted input is
// the normal case here, not an edge case.

/** Build an element. `text` is set via textContent, so markup in it is inert. */
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = String(options.title);
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Replace an element's contents with the supplied nodes. */
function render(target, ...nodes) {
  const node = typeof target === 'string' ? $(target) : target;
  node.replaceChildren(...nodes.filter(Boolean));
  return node;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

/**
 * Read a numeric field, refusing anything that is not a finite number.
 *
 * `Number('')` is NaN, and sending NaN to a hardware operation produces a confusing
 * failure at the far end of a serial link rather than an obvious one here.
 */
function num(id, label) {
  const raw = $(id).value.trim();
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) {
    throw new Error(`${label} needs a number (got ${raw === '' ? 'an empty field' : `"${raw}"`})`);
  }
  return value;
}

async function call(action, params = {}) {
  setStatus(`${action}…`);
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: $('port').value || undefined, ...params }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    setStatus(`${action}: server returned a non-JSON response`, 'err');
    throw new Error('server returned a non-JSON response');
  }

  if (!res.ok || body.ok === false) {
    setStatus(body.error ?? `${action} failed`, 'err');
    throw new Error(body.error ?? 'request failed');
  }

  // Distinguish a slow call from one that queued behind another port user.
  const queued = body.queuedMs > 50 ? ` (waited ${body.queuedMs} ms for the port)` : '';
  setStatus(`${action} · ${body.elapsedMs} ms${queued}`, 'ok');
  return body.result;
}

const show = (id, data) => { $(id).textContent = JSON.stringify(data, null, 2); };

/** Confidence-carrying fields render with their source, because that is the point. */
function tile(label, field) {
  if (!field) return null;
  const v = field?.value ?? field;
  if (v === null || v === undefined) return null;
  const src = field?.source && field.source !== 'NONE'
    ? field.source.replace(/_/g, ' ').toLowerCase()
    : '';
  return el('div', { class: 'tile' }, [
    el('div', { class: 'k', text: label }),
    el('div', { class: 'v', text: Array.isArray(v) ? v.join(', ') : v }),
    src ? el('div', { class: 'src', text: src }) : null,
  ].filter(Boolean));
}

// ── ports ──────────────────────────────────────────────
async function loadPorts() {
  try {
    const result = await call('ports.detect');
    const ports = result.ports ?? [];

    // Detection needs FirmwareToolkit. Without it the panel still works — you just
    // type the port — so report the gap rather than showing an empty list that looks
    // like "no board attached".
    if (result.error) {
      setStatus('port auto-detection unavailable — type the port (e.g. COM3)', 'warn');
      $('link-dot').className = 'dot';
      return;
    }

    // isESP32 is a heuristic over the host description, so name the bridge that
    // matched rather than presenting a bare yes.
    render('port-options', ...ports.map((p) => {
      const option = el('option', {
        text: p.isESP32 ? (p.bridge ?? 'USB serial') : 'no USB-serial bridge',
      });
      option.value = p.port;
      return option;
    }));

    const firstEsp = ports.find((p) => p.isESP32);
    if (!$('port').value && firstEsp) $('port').value = firstEsp.port;
    $('link-dot').className = `dot ${firstEsp ? 'live' : 'bad'}`;
  } catch {
    $('link-dot').className = 'dot bad';
  }
}

// ── observe ────────────────────────────────────────────
async function runInventory() {
  const inv = await call('device.inventory');
  show('out-inventory', inv);

  const c = inv.chip ?? {};
  const f = inv.firmware ?? {};
  const tiles = [
    tile('Chip', c.model), tile('Revision', c.revision), tile('Cores', c.cores),
    tile('CPU MHz', c.cpuFrequencyMHz), tile('MAC', c.macAddress),
    tile('Flash bytes', c.flashSizeBytes), tile('Agent', f.agentVersion),
    tile('Framework', f.framework), tile('Reset reason', c.resetReason),
  ].filter(Boolean);

  const box = render('device-summary', ...tiles);
  box.hidden = tiles.length === 0;

  // `success: false` means the agent was never reached — the report holds datasheet
  // values only. Say so rather than presenting documentation as measurement.
  if (inv.success === false) {
    setStatus('inventory returned datasheet values only — the agent was not reached', 'warn');
  }
}

// ── i2c ────────────────────────────────────────────────
async function runI2cScan() {
  const scan = await call('i2c.scan', {
    sda: num('i2c-sda', 'SDA'),
    scl: num('i2c-scl', 'SCL'),
    frequencyHz: num('i2c-freq', 'Frequency'),
    repeats: num('i2c-repeats', 'Repeats'),
  });
  show('out-i2c', scan);

  const responding = scan.responding ?? [];
  const grid = el('div', { class: 'addr-grid' }, (scan.results ?? []).map((r) =>
    el('span', {
      class: `addr ${r.state === 'RESPONDS' ? 'hit' : ''}`,
      text: r.hex,
      title: r.state,
    })
  ));

  render('i2c-result', responding.length
    ? el('span', { class: 'ok', text: `${responding.length} device(s) responded` })
    : el('span', { class: 'warn', text: 'Nothing responded.' }),
    document.createTextNode(responding.length
      ? ` in ${scan.scanDurationMs} ms`
      : ' That is not the same as an empty bus — check pull-ups, wiring, power and the SDA/SCL assignment before concluding anything.'),
    grid);
}

// ── uart ───────────────────────────────────────────────
function appendLog(text, { boundary = false } = {}) {
  const log = $('uart-log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  // Each capture is cut off at the agent's 512-byte cap, and successive captures are
  // NOT contiguous — there is a real gap between them. Concatenating them directly
  // welds a truncated tail onto the next head and produces a line that never existed
  // on the wire. Force a break at every capture boundary.
  if (boundary && log.textContent && !log.textContent.endsWith('\n')) {
    log.textContent += '\n';
  }

  log.textContent += text;

  // Keep the buffer bounded; this can run for a long time.
  if (log.textContent.length > 40000) log.textContent = log.textContent.slice(-30000);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function renderUartMeta(capture) {
  const parts = [el('span', { text: `${capture.totalBytes} bytes` })];

  const candidates = capture.protocolCandidates ?? [];
  if (candidates.length) {
    parts.push(document.createTextNode(' · likely: '));
    candidates.forEach((c, i) => {
      if (i) parts.push(document.createTextNode(', '));
      parts.push(el('span', { text: c.partNumber }));
      parts.push(el('span', { class: 'muted', text: ` (${c.confidence})` }));
    });
  }

  const warnings = capture.warnings ?? [];
  if (warnings.length) parts.push(el('div', { class: 'warn', text: warnings.join(' ') }));

  render('uart-meta', ...parts);
}

async function uartOnce() {
  const capture = await call('uart.capture', {
    rx: num('uart-rx', 'RX GPIO'),
    baud: Number($('uart-baud').value),
    durationMs: 3000,
  });
  renderUartMeta(capture);
  appendLog(capture.ascii ?? '', { boundary: true });
}

function toggleStream() {
  const button = $('uart-stream');
  if (stream) {
    stream.close();
    stream = null;
    button.textContent = 'Start live';
    button.classList.add('primary');
    setStatus('stream stopped');
    return;
  }

  let rx;
  try {
    rx = num('uart-rx', 'RX GPIO');
  } catch (error) {
    setStatus(error.message, 'err');
    return;
  }

  const params = new URLSearchParams({
    port: $('port').value,
    rx: String(rx),
    baud: $('uart-baud').value,
  });
  stream = new EventSource(`/api/uart/stream?${params}`);
  button.textContent = 'Stop live';
  button.classList.remove('primary');
  setStatus('streaming…', 'ok');

  stream.addEventListener('capture', (event) => {
    const capture = JSON.parse(event.data);
    renderUartMeta(capture);
    appendLog(capture.ascii ?? '', { boundary: true });
  });
  stream.addEventListener('error', (event) => {
    let message = 'stream error';
    try { message = JSON.parse(event.data).message; } catch { /* transport-level */ }
    setStatus(message, 'err');
  });
  stream.onerror = () => { setStatus('stream disconnected', 'err'); };
}

async function identify() {
  const result = await call('component.identify', {
    interface: 'UART',
    rx: num('uart-rx', 'RX GPIO'),
    baud: Number($('uart-baud').value),
    depth: 'STANDARD',
  });
  show('out-identify', result);

  const id = result.identified;
  if (!id) {
    render('uart-meta', el('span', { class: 'warn', text: 'No component matched with usable confidence.' }));
    return;
  }

  const parts = [
    document.createTextNode('Identified '),
    el('strong', { text: id.partNumber }),
    document.createTextNode(` (${id.manufacturer ?? 'unknown maker'}) — `),
    el('span', { class: 'ok', text: id.confidence }),
    document.createTextNode(`, score ${id.score?.toFixed?.(2) ?? '?'}`),
  ];
  if (result.ambiguous) parts.push(el('span', { class: 'warn', text: ' · ambiguous' }));
  if (id.contradictedRules?.length) {
    parts.push(el('div', {
      class: 'warn',
      text: `${id.contradictedRules.length} rule(s) contradicted by the evidence`,
    }));
  }
  render('uart-meta', ...parts);
}

// ── drive ──────────────────────────────────────────────
async function driveWrite() {
  let pin;
  try {
    pin = num('drive-pin', 'Pin');
  } catch (error) {
    render('drive-result', el('span', { class: 'err', text: error.message }));
    return;
  }

  const level = Number($('drive-level').value);
  if (!confirm(`Set GPIO${pin} to ${level === 1 ? 'HIGH' : 'LOW'}?\n\nThis changes the physical state of the pin.`)) return;

  try {
    renderDrive(await call('hardware.execute', {
      operations: [{ op: 'GPIO_WRITE', pin, level }],
    }));
  } catch (error) {
    render('drive-result', el('span', { class: 'err', text: error.message }));
  }
}

async function driveRead() {
  try {
    renderDrive(await call('hardware.execute', {
      operations: [{ op: 'GPIO_READ', pins: [num('drive-pin', 'Pin')] }],
    }));
  } catch (error) {
    render('drive-result', el('span', { class: 'err', text: error.message }));
  }
}

function renderDrive(result) {
  const outcome = result.operations?.[0];
  const rejections = outcome?.rejections ?? [];

  if (rejections.length) {
    // A refusal is a successful outcome, not an error: the guard caught a physically
    // invalid request. `executed: false` is the part that matters — it never reached
    // the board.
    const parts = [el('span', { class: 'err', text: 'Refused before transmission. ' })];
    rejections.forEach((r, i) => {
      if (i) parts.push(document.createTextNode('; '));
      parts.push(el('strong', { text: r.kind }));
      parts.push(document.createTextNode(` — ${r.detail}`));
      if (r.remedy) parts.push(el('em', { text: ` ${r.remedy}` }));
    });
    parts.push(el('div', {
      class: 'muted',
      text: `executed: ${outcome.executed} · sent to agent: ${outcome.agentRequest ? 'yes' : 'no'}`,
    }));
    render('drive-result', ...parts);
    return;
  }

  const value = outcome?.samples?.length ? `samples: ${outcome.samples.join(', ')}`
    : outcome?.data ? JSON.stringify(outcome.data)
    : 'no data returned';

  render('drive-result',
    el('span', { class: 'ok', text: 'Executed' }),
    document.createTextNode(` in ${outcome?.durationMs ?? '?'} ms — ${value}`),
    outcome?.warnings?.length ? el('div', { class: 'warn', text: outcome.warnings.join(' ') }) : null);
}

// ── wiring ─────────────────────────────────────────────
document.querySelectorAll('button[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    const target = button.dataset.target;
    const pre = target ? $(target) : null;
    const details = pre?.closest('details');
    const label = button.textContent;

    // Requests for one port are queued server-side, so a second click waits rather
    // than colliding. Say so, instead of leaving the button looking inert.
    button.disabled = true;
    button.textContent = 'working…';

    try {
      if (action === 'device.inventory') {
        await runInventory();
      } else {
        show(target, await call(action));
        // A click whose only effect is filling a collapsed panel reads as a dead
        // button. Open it so success is visible.
        if (details) details.open = true;
      }
    } catch (error) {
      // Never swallow this. A silent failure here is indistinguishable from a
      // broken button, which is exactly how it was reported.
      if (pre) {
        pre.textContent = `Failed: ${error.message}`;
        if (details) details.open = true;
      }
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
});

const guard = (fn) => () => fn().catch((error) => setStatus(error.message, 'err'));

$('refresh-ports').addEventListener('click', loadPorts);
$('i2c-scan').addEventListener('click', guard(runI2cScan));
$('uart-once').addEventListener('click', guard(uartOnce));
$('uart-stream').addEventListener('click', toggleStream);
$('uart-identify').addEventListener('click', guard(identify));
$('drive-write').addEventListener('click', driveWrite);
$('drive-read').addEventListener('click', driveRead);

(async function init() {
  // If this fails the panel cannot know whether driving is permitted. Fail closed:
  // assume it is not, and say why, rather than offering controls the server refuses.
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) throw new Error(`server returned ${res.status}`);
    meta = await res.json();
  } catch (error) {
    setStatus(`cannot reach the control panel server: ${error.message}`, 'err');
    $('link-dot').className = 'dot bad';
    meta = { allowDrive: false, actions: {} };
  }

  const badge = $('drive-badge');
  badge.textContent = meta.allowDrive ? 'drive enabled' : 'drive locked';
  badge.classList.toggle('on', meta.allowDrive);
  $('drive-locked').hidden = meta.allowDrive;
  $('drive-controls').hidden = !meta.allowDrive;

  await loadPorts();
})();
