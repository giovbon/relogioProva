'use strict';

/**
 * Relógio da Prova — modo ao vivo (opcional)
 * ------------------------------------------------------------
 * Serve o front-end e expõe /api/time com a hora sincronizada
 * diretamente com horariodebrasilia.org (cache de 5 min).
 *
 * No GitHub Pages o site funciona sem este servidor, usando o
 * snapshot public/time.json gerado pelo GitHub Action.
 *
 * Variáveis de ambiente:
 *   PORT, HOST, SOURCE_URL, SYNC_TTL_MS, FETCH_TIMEOUT_MS
 */

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { brasiliaParts, formatDateLabel, fetchSourceTime, pad } = require('./lib/hora');

const PORT = toInt(process.env.PORT, 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SOURCE_URL = process.env.SOURCE_URL || 'https://www.horariodebrasilia.org/';
const SYNC_TTL_MS = clamp(toInt(process.env.SYNC_TTL_MS, 5 * 60_000), 30_000, 30 * 60_000);
const FETCH_TIMEOUT_MS = clamp(toInt(process.env.FETCH_TIMEOUT_MS, 8_000), 1_000, 30_000);
const MAX_STALE_MS = 30 * 60_000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* Sincronização                                                       */
/* ------------------------------------------------------------------ */

let cache = null; // { offsetMs, syncedAt, detail }
let inflight = null;

async function getTime() {
  if (cache && Date.now() - cache.syncedAt < SYNC_TTL_MS) {
    return snapshot(cache.offsetMs, {
      source: 'horariodebrasilia.org',
      syncedAt: cache.syncedAt,
      detail: cache.detail,
    });
  }

  try {
    if (!inflight) {
      inflight = fetchSourceTime({ url: SOURCE_URL, timeoutMs: FETCH_TIMEOUT_MS }).finally(() => {
        inflight = null;
      });
    }
    const result = await inflight;
    cache = { offsetMs: result.offsetMs, syncedAt: Date.now(), detail: result.detail };

    return snapshot(cache.offsetMs, {
      source: 'horariodebrasilia.org',
      syncedAt: cache.syncedAt,
      detail: cache.detail,
    });
  } catch (error) {
    if (cache && Date.now() - cache.syncedAt < MAX_STALE_MS) {
      return snapshot(cache.offsetMs, {
        source: 'horariodebrasilia.org',
        syncedAt: cache.syncedAt,
        detail: cache.detail,
        stale: true,
        warning: `Não foi possível atualizar a hora oficial (${error.message}). Usando a última sincronização.`,
      });
    }
    return snapshot(0, {
      source: 'relógio local',
      detail: 'fallback',
      warning: `Sem acesso a horariodebrasilia.org (${error.message}). Exibindo o relógio local do servidor.`,
    });
  }
}

function snapshot(offsetMs, meta) {
  const epochMs = Math.round(Date.now() + offsetMs);
  const wall = brasiliaParts(epochMs);
  const date = formatDateLabel(epochMs);

  return {
    ok: true,
    epochMs,
    time: `${pad(wall.hours)}:${pad(wall.minutes)}:${pad(wall.seconds)}`,
    date,
    timezone: 'America/Sao_Paulo',
    utcOffset: '-03:00',
    source: meta.source,
    detail: meta.detail || null,
    syncedAt: meta.syncedAt ? new Date(meta.syncedAt).toISOString() : null,
    ageMs: meta.syncedAt ? Date.now() - meta.syncedAt : null,
    stale: Boolean(meta.stale),
    accuracyMs: 1_000,
    warning: meta.warning || null,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (request, response) => {
  const startedAt = process.hrtime.bigint();

  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/api/time') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response);
      const data = await getTime();
      return sendJson(response, 200, data, request.method === 'HEAD');
    }

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response);
      return sendJson(response, 200, {
        ok: true,
        uptimeSeconds: Math.round(process.uptime()),
        source: cache ? 'horariodebrasilia.org' : 'não sincronizado',
        lastSync: cache ? new Date(cache.syncedAt).toISOString() : null,
      }, request.method === 'HEAD');
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(response);
    return await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error('[erro]', error);
    if (!response.headersSent) sendText(response, 500, 'Erro interno do servidor.');
    else response.end();
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`${request.method} ${request.url} -> ${response.statusCode} (${elapsedMs.toFixed(1)}ms)`);
  }
});

async function serveStatic(request, response, rawPathname) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return sendText(response, 400, 'Requisição inválida.');
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname.includes('\0')) return sendText(response, 404, 'Não encontrado.');

  const filePath = path.join(PUBLIC_DIR, pathname);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return sendText(response, 403, 'Acesso negado.');
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendText(response, 404, 'Não encontrado.');
  }
  if (!stat.isFile()) return sendText(response, 404, 'Não encontrado.');

  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag });
    return response.end();
  }

  const data = await fsp.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const type = MIME[extension] || 'application/octet-stream';

  response.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (request.method === 'HEAD') return response.end();
  response.end(data);
}

function sendJson(response, status, payload, headOnly) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  if (headOnly) return response.end();
  response.end(body);
}

function sendText(response, status, message) {
  const body = Buffer.from(message, 'utf8');
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function methodNotAllowed(response) {
  response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Método não permitido.');
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  console.log(`Relógio da Prova ouvindo em http://${HOST}:${PORT}`);
  console.log(`Fonte da hora: ${SOURCE_URL}`);
  getTime().catch((error) => console.warn('[aviso] sincronização inicial falhou:', error.message));
});

function shutdown(signal) {
  console.log(`\n${signal} recebido, encerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
