/**
 * GET /api/projects/[id]/simulation/dashboard
 *
 * Hosted dashboard preview — a self-contained HTML page generated from the
 * device contract. No second Vite server. Works in the iframe on day one.
 *
 * Live serial still needs the Velxio half (or Web Serial on a downloaded zip);
 * this preview always shows the contract, last static shape, and connect UX.
 */

import type { NextRequest } from 'next/server';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { assertCanRead } from '@/lib/auth/project-access';
import { getProjectState } from '@/lib/mongodb/projects';
import { buildSimulationBundle } from '@/modules/simulation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!id?.trim()) {
    return new Response('Missing project id', { status: 400 });
  }

  try {
    const auth = await requireAuth(request);
    if (!auth) return new Response('Sign in required', { status: 401 });

    const project = await getProjectState(id.trim());
    if (!project) return new Response('Not found', { status: 404 });
    assertCanRead(project, auth);

    const bundle = buildSimulationBundle(project);
    const contract = bundle.software?.contract;
    if (!contract) {
      return new Response(emptyHtml(project.name, bundle.blocked.software ?? 'Firmware not ready yet.'), {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "frame-ancestors *",
        },
      });
    }

    const html = renderHostedDashboard(contract, project.id);
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors *",
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response('Dashboard failed to render', { status: 500 });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emptyHtml(name: string, reason: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(name)}</title>
<style>body{font:14px/1.5 system-ui;margin:24px;color:#1d1d1f;background:#fbfbfd}h1{font-size:18px}p{color:#6e6e73}</style>
</head><body><h1>${escapeHtml(name)}</h1><p>${escapeHtml(reason)}</p></body></html>`;
}

interface ContractLike {
  projectName: string;
  controller: string;
  baud: number;
  telemetryPrefix: string;
  telemetryIntervalMs: number;
  metrics: { field: string; label: string; unit: string; kind: string; precision?: number; source: string }[];
  commands: { character: string; label: string; meaning: string }[];
  caveats: string[];
  transport: string;
}

function renderHostedDashboard(contract: ContractLike, projectId: string): string {
  const metricsJson = JSON.stringify(contract.metrics);
  const commandsJson = JSON.stringify(contract.commands);
  const prefix = JSON.stringify(contract.telemetryPrefix);
  const interval = contract.telemetryIntervalMs;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(contract.projectName)} — hosted dashboard</title>
  <style>
    :root { --bg:#fbfbfd; --panel:#fff; --ink:#1d1d1f; --muted:#6e6e73; --line:#e3e3e8; --ok:#1b9e4b; --accent:#0071e3; --warn:#b26a00; }
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}
    .app{max-width:1080px;margin:0 auto;padding:20px}
    .bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:12px}
    h1{margin:0;font-size:18px} .sub{margin:4px 0 0;color:var(--muted);font-size:12px}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);display:inline-block}
    .dot.on{background:var(--ok)} .dot.wait{background:var(--warn)}
    .grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));margin-top:16px}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
    .card h3{margin:0 0 6px;font-size:12px;color:var(--muted);font-weight:500}
    .val{font-size:24px;font-weight:500;letter-spacing:-0.02em}
    .unit{font-size:12px;color:var(--muted);margin-left:4px}
    .cmds{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
    button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:7px;background:var(--panel);cursor:pointer}
    button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
    button:disabled{opacity:.45;cursor:not-allowed}
    .log{max-height:220px;overflow:auto;font:12px ui-monospace,monospace;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;margin-top:8px}
    .notice{margin-top:12px;padding:10px 12px;border-radius:8px;background:#fff9ec;border:1px solid #f0d9a8;font-size:13px}
    h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:24px 0 8px}
    .src{font-size:11px;color:var(--muted);margin-top:4px}
  </style>
</head>
<body>
  <div class="app">
    <header class="bar">
      <div>
        <h1>${escapeHtml(contract.projectName)}</h1>
        <p class="sub">${escapeHtml(contract.controller)} · hosted preview · ${contract.baud} baud · project ${escapeHtml(projectId)}</p>
      </div>
      <div>
        <span class="dot" id="dot"></span>
        <span class="sub" id="linkState">waiting for emulator serial…</span>
      </div>
    </header>
    <p class="notice" id="banner">
      This is Wireup's <strong>hosted</strong> dashboard — no local Vite server.
      Live readings appear when the Simulation half pushes serial bytes (Velxio hosted or local).
      Download the zip from the parent page for Web Serial against real hardware.
    </p>
    <h2>Readings</h2>
    <div class="grid" id="metrics"></div>
    <h2>Controls</h2>
    <div class="cmds" id="commands"></div>
    <h2>Board output</h2>
    <div class="log" id="log"><div class="sub">Nothing received yet.</div></div>
  </div>
  <script>
    const metrics = ${metricsJson};
    const commands = ${commandsJson};
    const PREFIX = ${prefix};
    const INTERVAL = ${interval};
    const telemetry = {};
    const metricsEl = document.getElementById('metrics');
    const commandsEl = document.getElementById('commands');
    const logEl = document.getElementById('log');
    const dot = document.getElementById('dot');
    const linkState = document.getElementById('linkState');
    let buffer = '';
    let connected = false;
    let logCount = 0;

    function renderMetrics() {
      metricsEl.innerHTML = metrics.map(m => {
        const raw = telemetry[m.field];
        const shown = raw === undefined || raw === null ? '—' : (typeof raw === 'number' && m.precision != null ? Number(raw).toFixed(m.precision) : String(raw));
        return '<article class="card"><h3>' + escape(m.label) + '</h3><div class="val">' + escape(shown) +
          (m.unit ? '<span class="unit">' + escape(m.unit) + '</span>' : '') +
          '</div><div class="src">' + escape(m.source || '') + '</div></article>';
      }).join('') || '<p class="sub">No metrics in the device contract.</p>';
    }

    function escape(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    commandsEl.innerHTML = commands.length ? commands.map(c =>
      '<button type="button" data-ch="' + escape(c.character) + '" title="' + escape(c.meaning) + '"><strong>' +
      escape(c.character) + '</strong> ' + escape(c.label) + '</button>'
    ).join('') : '<p class="sub">No command set — read-only dashboard.</p>';

    commandsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ch]');
      if (!btn || !connected) return;
      window.parent.postMessage({ type: 'wireup:dash-write', data: btn.getAttribute('data-ch') }, '*');
    });

    function setConnected(on, detail) {
      connected = on;
      dot.className = 'dot ' + (on ? 'on' : 'wait');
      linkState.textContent = on ? (detail || 'linked to emulator') : 'waiting for emulator serial…';
      commandsEl.querySelectorAll('button').forEach(b => { b.disabled = !on; });
    }

    function pushLog(line) {
      if (logCount === 0) logEl.innerHTML = '';
      logCount += 1;
      const row = document.createElement('div');
      row.textContent = line;
      logEl.appendChild(row);
      while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function handleChunk(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\\n/);
      buffer = parts.pop() || '';
      for (const raw of parts) {
        const line = raw.replace(/\\r$/, '').trim();
        if (!line) continue;
        pushLog(line);
        if (line.startsWith(PREFIX)) {
          try {
            const body = JSON.parse(line.slice(PREFIX.length).trim());
            if (body && typeof body === 'object') Object.assign(telemetry, body);
            renderMetrics();
          } catch (_) {}
        }
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'wireup:serial-data' && typeof msg.chunk === 'string') handleChunk(msg.chunk);
      if (msg.type === 'wireup:link-state') setConnected(!!msg.connected, typeof msg.detail === 'string' ? msg.detail : '');
    });

    // Hello to Wireup host (SimulationPanel relay).
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'wireup:dash-ready' }, '*');
    }
    renderMetrics();
    setConnected(false);
  </script>
</body>
</html>`;
}
