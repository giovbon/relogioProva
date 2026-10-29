'use strict';

/**
 * Utilitários de leitura da hora oficial de Brasília.
 * Compartilhado entre o servidor (modo ao vivo) e o script de build (GitHub Pages).
 */

const BR_OFFSET_MS = -3 * 60 * 60 * 1000; // UTC-3, sem horário de verão desde 2019
const MONTHS = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const MONTH_INDEX = Object.fromEntries(MONTHS.map((name, index) => [name, index]));
const WEEKDAYS = [
  'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
  'quinta-feira', 'sexta-feira', 'sábado',
];

const pad = (value) => String(value).padStart(2, '0');
const normalize = (value) => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

/** Converte um epoch em componentes do relógio de Brasília. */
function brasiliaParts(epochMs) {
  const date = new Date(epochMs + BR_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
    seconds: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

function formatDateLabel(epochMs) {
  const wall = brasiliaParts(epochMs);
  const label = `${WEEKDAYS[wall.weekday]}, ${wall.day} de ${MONTHS[wall.month]} de ${wall.year}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Extrai o relógio e a data exibidos no HTML da fonte.
 * @returns {{ siteEpochMs: number, siteTime: string, siteDate: string|null } | null}
 */
function parseSourceClock(html) {
  const clock = html.match(/id=["']relogio["'][^>]*>\s*(\d{1,2}):(\d{2}):(\d{2})\s*</i);
  if (!clock) return null;

  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const seconds = Number(clock[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  let year;
  let month;
  let day;
  let siteDate = null;

  const dateMatch = html.match(/id=["']dia-topo["'][^>]*>\s*([^<]+?)\s*</i);
  if (dateMatch) {
    const parts = dateMatch[1].match(/(\d{1,2})\s+de\s+([^\s,]+)\s+de\s+(\d{4})/i);
    if (parts) {
      const monthIndex = MONTH_INDEX[normalize(parts[2])];
      if (monthIndex !== undefined) {
        day = Number(parts[1]);
        month = monthIndex;
        year = Number(parts[3]);
        siteDate = dateMatch[1].trim();
      }
    }
  }

  // Se a data não vier no HTML, assume o dia atual em Brasília.
  if (year === undefined) {
    const today = brasiliaParts(Date.now());
    year = today.year;
    month = today.month;
    day = today.day;
  }

  const wallMs = Date.UTC(year, month, day, hours, minutes, seconds);
  return {
    siteEpochMs: wallMs - BR_OFFSET_MS,
    siteTime: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
    siteDate,
  };
}

/**
 * Consulta a fonte e devolve a hora oficial com o instante da captura.
 * O instante é o ponto médio da requisição, reduzindo o erro de rede.
 */
async function fetchSourceTime({ url, timeoutMs = 10_000 } = {}) {
  const t0 = Date.now();
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; RelogioDaProva/1.0)',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5',
      'cache-control': 'no-cache',
    },
  });
  const t1 = Date.now();

  if (!response.ok) throw new Error(`origem respondeu HTTP ${response.status}`);
  const html = await response.text();

  const midpoint = (t0 + t1) / 2;
  const headerMs = Date.parse(response.headers.get('date') || '');
  const parsed = parseSourceClock(html);

  let siteEpochMs = parsed ? parsed.siteEpochMs : Number.NaN;
  let detail = 'html';

  if (!Number.isFinite(siteEpochMs)) {
    siteEpochMs = headerMs;
    detail = 'http-date';
  }
  if (!Number.isFinite(siteEpochMs)) {
    throw new Error('não foi possível ler a hora na origem');
  }
  // Se o relógio do HTML divergir do cabeçalho Date, confia no cabeçalho.
  if (Number.isFinite(headerMs) && Math.abs(siteEpochMs - headerMs) > 5_000) {
    siteEpochMs = headerMs;
    detail = 'http-date';
  }

  const offsetMs = siteEpochMs - midpoint;
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 12 * 60 * 60 * 1000) {
    throw new Error('hora da origem parece inválida');
  }

  return {
    siteEpochMs,
    siteTime: parsed?.siteTime || null,
    siteDate: parsed?.siteDate || formatDateLabel(siteEpochMs),
    capturedAt: new Date(midpoint).toISOString(),
    offsetMs,
    detail,
    source: url,
  };
}

module.exports = {
  BR_OFFSET_MS,
  MONTHS,
  WEEKDAYS,
  brasiliaParts,
  formatDateLabel,
  parseSourceClock,
  fetchSourceTime,
  pad,
};
