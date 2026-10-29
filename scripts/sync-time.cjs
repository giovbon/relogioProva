#!/usr/bin/env node
'use strict';

/**
 * Captura a hora oficial e grava public/time.json.
 * Executado no build do GitHub Pages (e manualmente via `npm run sync`).
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchSourceTime } = require('../lib/hora');

const SOURCE_URL = process.env.SOURCE_URL || 'https://www.horariodebrasilia.org/';
const OUTPUT = path.join(__dirname, '..', 'public', 'time.json');

(async () => {
  try {
    const result = await fetchSourceTime({ url: SOURCE_URL, timeoutMs: 15_000 });
    const payload = {
      siteEpochMs: result.siteEpochMs,
      siteTime: result.siteTime,
      siteDate: result.siteDate,
      capturedAt: result.capturedAt,
      offsetMs: Math.round(result.offsetMs),
      detail: result.detail,
      source: 'horariodebrasilia.org',
      updatedAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
    await fs.writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`time.json atualizado — ${result.siteTime} (${result.detail})`);
  } catch (error) {
    // Não quebra o deploy: mantém o snapshot anterior (se existir).
    console.error(`::warning::Falha ao capturar a hora oficial: ${error.message}`);
    process.exitCode = 0;
  }
})();
