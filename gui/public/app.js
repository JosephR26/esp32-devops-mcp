'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

let meta = { allowDrive: false, actions: {} };
let stream = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind ?? '';
}

async function call(action, params = {}) {
  setStatus(`${action}…`);
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: $('port').value || undefined, ...params }),
  });
  const body = await res.json();
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
  if (!field) return '';
  const v = field?.value ?? field;
  if (v === null || v === undefined) return '';
  const src = field?.source && field.source !== 'NONE' ? field.source.replace(/_/g, ' ').toLowerCase() : '';
  return `<div class="tile"><div class="k">${label}</div><div class="v">${
    Array.isArray(v) ? v.join(', ') : v
  }</div>${src ? `<div class="src">${src}</div>` : ''}</div>`;
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
    $('port-options').innerHTML = ports
      .map((p) => `<option value="${p.port}">${p.isESP32 ? (p.bridge ?? 'USB serial') : 'no USB-serial bridge'}</option>`)
      .join('');

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
  const html = [
    tile('Chip', c.model), tile('Revision', c.revision), tile('Cores', c.cores),
    tile('CPU MHz', c.cpuFrequencyMHz), tile('MAC', c.macAddress),
    tile('Flash bytes', c.flashSizeBytes), tile('Agent', f.agentVersion),
    tile('Framework', f.framework), tile('Reset reason', c.resetReason),
  ].filter(Boolean).join('');
  const box = $('device-summary');
  box.innerHTML = html;
  box.hidden = !html;
}

// ── i2c ────────────────────────────────────────────────
async function runI2cScan() {
  const scan = await call('i2c.scan', {
    sda: Number($('i2c-sda').value),
    scl: Number($('i2c-scl').value),
    frequencyHz: Number($('i2c-freq').value),
    repeats: Number($('i2c-repeats').value),
  });
  show('out-i2c', scan);

  const responding = scan.responding ?? [];
  const grid = (scan.results ?? [])
    .map((r) => `<span class="addr ${r.state === 'RESPONDS' ? 'hit' : ''}" title="${r.state}">${r.hex}</span>`)
    .join('');

  $('i2c-result').innerHTML = responding.length
    ? `<span class="ok">${responding.length} device(s) responded</span> in ${scan.scanDurationMs} ms
       <div class="addr-grid">${grid}</div>`
    : `<span class="warn">Nothing responded.</span> That is not the same as an empty bus —
       check pull-ups, wiring, power and the SDA/SCL assignment before concluding anything.
       <div class="addr-grid">${grid}</div>`;
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
  const candidates = (capture.protocolCandidates ?? [])
    .map((c) => `${c.partNumber} <span class="muted">(${c.confidence})</span>`)
    .join(', ');
  const warn = (capture.warnings ?? []).length
    ? `<div class="warn">${capture.warnings.join(' ')}</div>` : '';
  $('uart-meta').innerHTML =
    `${capture.totalBytes} bytes` +
    (candidates ? ` · likely: ${candidates}` : '') + warn;
}

async function uartOnce() {
  const capture = await call('uart.capture', {
    rx: Number($('uart-rx').value),
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

  const params = new URLSearchParams({
    port: $('port').value,
    rx: $('uart-rx').value,
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
    rx: Number($('uart-rx').value),
    baud: Number($('uart-baud').value),
    depth: 'STANDARD',
  });
  show('out-identify', result);
  const id = result.identified;
  $('uart-meta').innerHTML = id
    ? `Identified <strong>${id.partNumber}</strong> (${id.manufacturer ?? 'unknown maker'}) —
       <span class="ok">${id.confidence}</span>, score ${id.score?.toFixed?.(2) ?? '?'}
       ${result.ambiguous ? '<span class="warn">· ambiguous</span>' : ''}
       ${id.contradictedRules?.length ? `<div class="warn">${id.contradictedRules.length} rule(s) contradicted by the evidence</div>` : ''}`
    : '<span class="warn">No component matched with usable confidence.</span>';
}

// ── drive ──────────────────────────────────────────────
async function driveWrite() {
  const pin = Number($('drive-pin').value);
  if (!confirm(`Set GPIO${pin} to ${$('drive-level').value === '1' ? 'HIGH' : 'LOW'}?\n\nThis changes the physical state of the pin.`)) return;
  try {
    const result = await call('hardware.execute', {
      operations: [{ op: 'GPIO_WRITE', pin, level: Number($('drive-level').value) }],
    });
    renderDrive(result);
  } catch (error) {
    $('drive-result').innerHTML = `<span class="err">${error.message}</span>`;
  }
}

async function driveRead() {
  try {
    const result = await call('hardware.execute', {
      operations: [{ op: 'GPIO_READ', pins: [Number($('drive-pin').value)] }],
    });
    renderDrive(result);
  } catch (error) {
    $('drive-result').innerHTML = `<span class="err">${error.message}</span>`;
  }
}

function renderDrive(result) {
  const outcome = result.operations?.[0];
  const rejections = outcome?.rejections ?? [];

  if (rejections.length) {
    // A refusal is a successful outcome, not an error: it means the guard caught a
    // physically invalid request. `executed: false` is the part that matters — the
    // request never reached the board.
    $('drive-result').innerHTML =
      `<span class="err">Refused before transmission.</span> ` +
      rejections.map((r) => `<strong>${r.kind}</strong> — ${r.detail}${r.remedy ? ` <em>${r.remedy}</em>` : ''}`).join('; ') +
      `<div class="muted">executed: ${outcome.executed} · sent to agent: ${outcome.agentRequest ? 'yes' : 'no'}</div>`;
    return;
  }

  const value = outcome?.samples?.length ? `samples: ${outcome.samples.join(', ')}`
    : outcome?.data ? JSON.stringify(outcome.data)
    : 'no data returned';
  $('drive-result').innerHTML =
    `<span class="ok">Executed</span> in ${outcome?.durationMs ?? '?'} ms — ${value}` +
    (outcome?.warnings?.length ? `<div class="warn">${outcome.warnings.join(' ')}</div>` : '');
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

$('refresh-ports').addEventListener('click', loadPorts);
$('i2c-scan').addEventListener('click', () => runI2cScan().catch(() => {}));
$('uart-once').addEventListener('click', () => uartOnce().catch(() => {}));
$('uart-stream').addEventListener('click', toggleStream);
$('uart-identify').addEventListener('click', () => identify().catch(() => {}));
$('drive-write').addEventListener('click', driveWrite);
$('drive-read').addEventListener('click', driveRead);

(async function init() {
  meta = await (await fetch('/api/meta')).json();
  const badge = $('drive-badge');
  badge.textContent = meta.allowDrive ? 'drive enabled' : 'drive locked';
  badge.classList.toggle('on', meta.allowDrive);
  $('drive-locked').hidden = meta.allowDrive;
  $('drive-controls').hidden = !meta.allowDrive;
  await loadPorts();
})();
