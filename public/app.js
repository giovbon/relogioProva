'use strict';

/**
 * Relógio da Prova — front-end
 * ------------------------------------------------------------
 * A hora exibida vem de horariodebrasilia.org:
 *  - modo "live":     /api/time (servidor Node, sincronização ao vivo)
 *  - modo "snapshot": time.json (GitHub Pages, capturado por um Action)
 *  - modo "local":    relógio do dispositivo (fallback)
 *
 * A prova é configurada em um modal (engrenagem) e fica salva no
 * navegador. O aviso de entrega usa o início da prova + permanência
 * mínima; a prova pode atravessar a meia-noite.
 */

(() => {
  const BR_OFFSET_MS = -3 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SYNC_INTERVAL_MS = 10 * 60 * 1000;
  const TICK_MS = 250;
  const STORAGE_KEY = 'relogio-da-prova/v1';
  const WARN_RATIO = 0.5;
  const DANGER_RATIO = 0.2;
  const MAX_MIN_STAY = 1440;

  const $ = (id) => document.getElementById(id);

  const ui = {
    body: document.body,
    clock: $('clock'),
    dateText: $('dateText'),
    badge: $('syncBadge'),
    badgeText: $('syncText'),
    sourceText: $('sourceText'),
    captureText: $('captureText'),
    warning: $('warning'),

    timerEmpty: $('timerEmpty'),
    timerContent: $('timerContent'),
    summaryStart: $('summaryStart'),
    summaryEnd: $('summaryEnd'),
    summaryMin: $('summaryMin'),
    summaryWhen: $('summaryWhen'),

    status: $('statusPill'),
    remaining: $('remaining'),
    remainingLabel: $('remainingLabel'),
    gate: $('gate'),
    gateTitle: $('gateTitle'),
    gateDetail: $('gateDetail'),
    progress: $('progress'),
    progressFill: $('progressFill'),
    durationText: $('durationText'),
    elapsedText: $('elapsedText'),
    pctText: $('pctText'),

    dialog: $('settingsDialog'),
    form: $('settingsForm'),
    startInput: $('startInput'),
    endInput: $('endInput'),
    minStayInput: $('minStayInput'),
    preview: $('settingsPreview'),
    formError: $('settingsError'),
    openSettingsBtn: $('openSettingsBtn'),
    openSettingsButtons: Array.from(document.querySelectorAll('[data-open-settings]')),
    closeSettings: $('closeSettings'),
    cancelSettings: $('cancelSettings'),
    clearSettings: $('clearSettings'),
    presetButtons: Array.from(document.querySelectorAll('[data-minutes]')),
  };

  const state = {
    anchor: null,          // { epochMs, perfMs } — referência de tempo
    mode: null,            // 'live' | 'snapshot' | 'local'
    capturedAt: null,
    siteTime: null,
    warning: null,
    lastSyncAt: 0,
    syncing: false,
    apiUnavailable: false,
    targets: null,         // { startMs, endMs, total, releaseMs }
    lastDateKey: '',
    lastBadgeKey: '',
    lastTitle: '',
    lastWarning: null,
    lastGateKey: '',
    bodyState: '',
  };

  let config = null;       // { start, end, minStay, date }

  const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  });

  const captureFormatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  /* ---------------------------------------------------------------- */
  /* Tempo                                                             */
  /* ---------------------------------------------------------------- */

  function siteNow() {
    if (!state.anchor) return Date.now();
    return state.anchor.epochMs + (performance.now() - state.anchor.perfMs);
  }

  function brParts(epochMs) {
    const date = new Date(epochMs + BR_OFFSET_MS);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
      seconds: date.getUTCSeconds(),
    };
  }

  const pad = (value) => String(value).padStart(2, '0');

  function formatHMS(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function formatShort(ms) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${pad(minutes)}min`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}min`;
  }

  // Para prazos: arredonda para o minuto mais próximo e evita "0min".
  function formatShortCountdown(ms) {
    if (ms < 60_000) return 'menos de 1min';
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${pad(minutes)}min`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}min`;
  }

  function formatMinutes(totalMinutes) {
    if (totalMinutes <= 0) return 'livre';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${pad(minutes)}min`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}min`;
  }

  function formatAge(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 5) return 'agora';
    if (seconds < 60) return `há ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `há ${minutes}min`;
    return `há ${Math.floor(minutes / 60)}h`;
  }

  function formatCaptured(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return captureFormatter.format(date).replace(',', ' ·');
  }

  function formatDate(epochMs) {
    const text = dateFormatter.format(new Date(epochMs));
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function formatShortDate(epochMs) {
    return shortDateFormatter.format(new Date(epochMs));
  }

  function formatClockHM(epochMs) {
    const wall = brParts(epochMs);
    return `${pad(wall.hours)}:${pad(wall.minutes)}`;
  }

  function startOfBrasiliaDay(epochMs) {
    const wall = brParts(epochMs);
    return Date.UTC(wall.year, wall.month, wall.day) - BR_OFFSET_MS;
  }

  function dayKeyOf(epochMs) {
    const wall = brParts(epochMs);
    return `${wall.year}-${pad(wall.month + 1)}-${pad(wall.day)}`;
  }

  function epochOfDayKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const epoch = Date.UTC(year, month, day) - BR_OFFSET_MS;
    return Number.isFinite(epoch) ? epoch : null;
  }

  function dayDiff(epochMs) {
    return Math.round((startOfBrasiliaDay(epochMs) - startOfBrasiliaDay(siteNow())) / DAY_MS);
  }

  function relativeDayPhrase(epochMs) {
    const diff = dayDiff(epochMs);
    if (diff === 0) return 'hoje';
    if (diff === 1) return 'amanhã';
    if (diff === -1) return 'ontem';
    return `em ${formatShortDate(epochMs)}`;
  }

  function summaryWhenText(epochMs) {
    const diff = dayDiff(epochMs);
    if (diff === 1) return `Prova amanhã · ${formatShortDate(epochMs)}`;
    if (diff > 1) return `Prova em ${formatShortDate(epochMs)}`;
    return `Prova de ${formatShortDate(epochMs)}`;
  }

  function renderSummaryWhen() {
    if (!state.targets) {
      ui.summaryWhen.hidden = true;
      return;
    }
    if (dayKeyOf(state.targets.startMs) === dayKeyOf(siteNow())) {
      ui.summaryWhen.hidden = true;
    } else {
      ui.summaryWhen.hidden = false;
      ui.summaryWhen.textContent = summaryWhenText(state.targets.startMs);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sincronização                                                     */
  /* ---------------------------------------------------------------- */

  async function resolveReference() {
    if (!state.apiUnavailable) {
      try {
        const response = await fetch(new URL('api/time', document.baseURI), {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });

        if (response.ok) {
          const data = await response.json();
          if (data && data.ok && Number.isFinite(data.epochMs)) {
            return {
              mode: 'live',
              epochMs: data.epochMs,
              source: data.source,
              siteTime: data.time || null,
              capturedAt: data.syncedAt || null,
              warning: data.warning || null,
            };
          }
        } else if (response.status === 404) {
          state.apiUnavailable = true; // Pages não tem API: usa o snapshot
        }
      } catch {
        // Sem API (ou offline): tenta o snapshot estático.
      }
    }

    const response = await fetch(`${new URL('time.json', document.baseURI).href}?v=${Date.now()}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`referência indisponível (HTTP ${response.status})`);

    const data = await response.json();
    const siteEpochMs = Number(data.siteEpochMs);
    if (!Number.isFinite(siteEpochMs)) throw new Error('referência inválida');

    // O snapshot é a referência oficial capturada pelo Action. Como o navegador
    // não tem uma fonte de tempo independente, o relógio local avança a partir
    // do horário do dispositivo (sem herdar o desvio da máquina que capturou).
    return {
      mode: 'snapshot',
      epochMs: Date.now(),
      source: data.source,
      siteTime: data.siteTime || null,
      capturedAt: data.capturedAt || null,
      warning: null,
    };
  }

  async function sync() {
    if (state.syncing) return;
    state.syncing = true;
    state.lastBadgeKey = '';
    renderBadge();

    const startedAt = performance.now();
    let reference = null;

    try {
      reference = await resolveReference();
      const rtt = performance.now() - startedAt;
      const epochAtReceipt = reference.mode === 'live'
        ? reference.epochMs + rtt / 2
        : reference.epochMs;

      state.anchor = { epochMs: epochAtReceipt, perfMs: performance.now() };
      state.mode = reference.mode;
      state.siteTime = reference.siteTime;
      state.capturedAt = reference.capturedAt;
      state.warning = reference.warning;
      state.lastSyncAt = Date.now();
      updateSource(reference);
    } catch (error) {
      const firstFailure = !state.mode;
      if (firstFailure) {
        state.anchor = { epochMs: Date.now(), perfMs: performance.now() };
        state.mode = 'local';
        updateSource({ mode: 'local' });
      }
      state.warning = firstFailure
        ? `Não foi possível obter a hora oficial (${error.message}). Usando o relógio deste dispositivo.`
        : `Não foi possível atualizar a hora oficial (${error.message}). Mantendo a última referência sincronizada.`;
    } finally {
      state.syncing = false;
      state.lastBadgeKey = '';
      renderBadge();
      renderWarning();
      tick();
    }
  }

  function updateSource(reference) {
    const mode = reference.mode || state.mode;
    if (mode === 'local') {
      ui.sourceText.textContent = 'Fonte: relógio do dispositivo';
      ui.captureText.textContent = '';
      return;
    }

    ui.sourceText.textContent = 'Fonte: horariodebrasilia.org';
    if (mode === 'live' && reference.siteTime) {
      ui.captureText.textContent = `sincronizado às ${reference.siteTime}`;
    } else if (mode === 'snapshot' && reference.capturedAt) {
      ui.captureText.textContent = `captura ${formatCaptured(reference.capturedAt)}`;
    } else {
      ui.captureText.textContent = '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Relógio                                                           */
  /* ---------------------------------------------------------------- */

  function renderClock(now) {
    const wall = brParts(now);
    ui.clock.textContent = `${pad(wall.hours)}:${pad(wall.minutes)}:${pad(wall.seconds)}`;

    const key = `${wall.year}-${wall.month}-${wall.day}`;
    if (key !== state.lastDateKey) {
      state.lastDateKey = key;
      ui.dateText.textContent = formatDate(now);
      renderSummaryWhen();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Contagem regressiva                                               */
  /* ---------------------------------------------------------------- */

  function renderCountdown(now) {
    const targets = state.targets;
    renderGate(now);

    if (!targets) {
      setState('idle');
      setText(ui.remaining, '--:--:--');
      setText(ui.remainingLabel, 'Informe o início e o fim da prova');
      setText(ui.status, 'Aguardando horários');
      setProgress(0);
      setStats(null, null, null);
      setTitle('Relógio da Prova');
      return;
    }

    const total = targets.endMs - targets.startMs;

    if (now < targets.startMs) {
      const untilStart = targets.startMs - now;
      setState('soon');
      setText(ui.remaining, formatHMS(untilStart));
      setText(ui.remainingLabel, 'para o início da prova');
      setText(ui.status, 'Ainda não começou');
      setProgress(0);
      setStats(total, 0, 100);
      setTitle(`${formatHMS(untilStart)} · começa em breve`);
      return;
    }

    if (now >= targets.endMs) {
      const ago = now - targets.endMs;
      setState('done');
      setText(ui.remaining, '00:00:00');
      setText(ui.remainingLabel, ago < 60_000 ? 'A prova terminou agora' : `A prova terminou ${formatAge(ago)}`);
      setText(ui.status, 'Tempo esgotado');
      setProgress(100);
      setStats(total, total, 0);
      setTitle('Tempo esgotado · prova encerrada');
      return;
    }

    const remaining = targets.endMs - now;
    const ratio = remaining / total;
    const elapsedRatio = 1 - ratio;
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const canDeliver = now >= targets.releaseMs;

    if (ratio > WARN_RATIO) {
      setState('ok');
      setText(ui.status, 'Tempo de sobra');
      setTitle(`${formatHMS(remaining)} · ${canDeliver ? 'já pode entregar' : 'tranquilo'}`);
    } else if (ratio > DANGER_RATIO) {
      setState('warn');
      setText(ui.status, 'Atenção · metade ou menos');
      setTitle(`${formatHMS(remaining)} · ${canDeliver ? 'já pode entregar' : 'atenção'}`);
    } else {
      setState('danger');
      setText(ui.status, 'Reta final · falta pouco');
      setTitle(`${formatHMS(remaining)} · ${canDeliver ? 'já pode entregar' : 'reta final'}`);
    }

    setText(ui.remaining, formatHMS(remaining));
    setText(ui.remainingLabel, 'para o fim da prova');
    setProgress(elapsedRatio * 100);
    setStats(total, now - targets.startMs, percent);
  }

  function renderGate(now) {
    if (!state.targets) {
      setGate('idle', 'Configure a prova', 'Defina os horários nas configurações.');
      return;
    }

    const targets = state.targets;

    if (now < targets.startMs) {
      setGate(
        'waiting',
        'Ainda não pode entregar',
        `A prova começa ${relativeDayPhrase(targets.startMs)} às ${config.start} · faltam ${formatShortCountdown(targets.startMs - now)}.`,
      );
      return;
    }

    if (now >= targets.endMs) {
      setGate('done', 'A prova terminou', 'O tempo da prova acabou.');
      return;
    }

    if (now >= targets.releaseMs) {
      const detail = config.minStay === 0
        ? 'Entrega liberada desde o início da prova.'
        : `Permanência mínima cumprida · liberado às ${formatClockHM(targets.releaseMs)}.`;
      setGate('released', 'Já pode entregar a prova', detail);
      return;
    }

    setGate(
      'locked',
      'Ainda não pode entregar',
      `Faltam ${formatShortCountdown(targets.releaseMs - now)} · liberado às ${formatClockHM(targets.releaseMs)}.`,
    );
  }

  function setGate(name, title, detail) {
    const key = `${name}|${title}|${detail}`;
    if (key === state.lastGateKey) return;
    state.lastGateKey = key;

    ui.gate.dataset.state = name;
    ui.gateTitle.textContent = title;
    ui.gateDetail.textContent = detail;
  }

  function setState(name) {
    if (state.bodyState === name) return;
    state.bodyState = name;
    ui.body.classList.remove('state-idle', 'state-soon', 'state-ok', 'state-warn', 'state-danger', 'state-done');
    ui.body.classList.add(`state-${name}`);
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, percent));
    ui.progressFill.style.width = `${value}%`;
    ui.progress.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  function setStats(durationMs, elapsedMs, percent) {
    ui.durationText.textContent = durationMs == null ? '—' : formatShort(durationMs);
    ui.elapsedText.textContent = elapsedMs == null ? '—' : formatShort(elapsedMs);
    ui.pctText.textContent = percent == null ? '—' : `${percent}%`;
  }

  function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function setTitle(value) {
    if (state.lastTitle === value) return;
    state.lastTitle = value;
    document.title = value;
  }

  /* ---------------------------------------------------------------- */
  /* Status da sincronização                                           */
  /* ---------------------------------------------------------------- */

  function renderBadge() {
    let cls = 'is-syncing';
    let text = 'conectando…';
    let title = 'Obtendo a hora oficial…';

    if (state.mode === 'live') {
      cls = 'is-live';
      text = `hora oficial · ${formatAge(Date.now() - state.lastSyncAt)}`;
      title = 'Sincronizado diretamente com horariodebrasilia.org';
    } else if (state.mode === 'snapshot') {
      cls = 'is-live';
      text = 'referência oficial';
      title = state.capturedAt
        ? `Hora oficial capturada em ${formatCaptured(state.capturedAt)}; o relógio avança com o dispositivo.`
        : 'Referência capturada de horariodebrasilia.org';
    } else if (state.mode === 'local') {
      cls = 'is-local';
      text = 'modo local';
      title = state.warning || 'Usando o relógio deste dispositivo';
    }

    const key = `${cls}|${text}|${title}`;
    if (key === state.lastBadgeKey) return;
    state.lastBadgeKey = key;

    ui.badge.className = `badge ${cls}`;
    ui.badge.title = title;
    ui.badgeText.textContent = text;
  }

  function renderWarning() {
    if (state.warning === state.lastWarning) return;
    state.lastWarning = state.warning;

    if (!state.warning) {
      ui.warning.hidden = true;
      ui.warning.textContent = '';
      return;
    }
    ui.warning.hidden = false;
    ui.warning.textContent = state.warning;
  }

  /* ---------------------------------------------------------------- */
  /* Configuração da prova                                             */
  /* ---------------------------------------------------------------- */

  function parseHHMM(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec((value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
  }

  function toHHMM(totalMinutes) {
    const minutes = ((totalMinutes % 1440) + 1440) % 1440;
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  function minutesBetween(startMin, endMin) {
    const diff = endMin - startMin;
    return diff > 0 ? diff : diff + 1440;
  }

  /**
   * Escolhe o dia da prova ao salvar: hoje, se a janela ainda não
   * terminou; amanhã, se início e fim já passaram hoje.
   */
  function resolveDateKey(startMin, endMin, now) {
    let dayStart = startOfBrasiliaDay(now);
    let startMs = dayStart + startMin * 60_000;
    let endMs = dayStart + endMin * 60_000;
    if (endMs <= startMs) endMs += DAY_MS;
    if (endMs <= now) {
      dayStart += DAY_MS;
      startMs += DAY_MS;
      endMs += DAY_MS;
    }
    return dayKeyOf(startMs);
  }

  function buildTargets(cfg) {
    const start = parseHHMM(cfg.start);
    const end = parseHHMM(cfg.end);
    const dayStart = epochOfDayKey(cfg.date) ?? startOfBrasiliaDay(siteNow());
    const startMin = start.hours * 60 + start.minutes;
    const endMin = end.hours * 60 + end.minutes;

    const startMs = dayStart + startMin * 60_000;
    let endMs = dayStart + endMin * 60_000;
    if (endMs <= startMs) endMs += DAY_MS;

    const total = endMs - startMs;
    const releaseMs = Math.min(startMs + cfg.minStay * 60_000, endMs);
    return { startMs, endMs, total, releaseMs };
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const start = parseHHMM(data.start);
      const end = parseHHMM(data.end);
      if (!start || !end) return null;

      const startMin = start.hours * 60 + start.minutes;
      const endMin = end.hours * 60 + end.minutes;
      if (startMin === endMin) return null;

      const duration = minutesBetween(startMin, endMin);
      const parsedMin = Number(data.minStay);
      const minStay = Number.isInteger(parsedMin) && parsedMin >= 0
        ? Math.min(parsedMin, duration, MAX_MIN_STAY)
        : 0;

      const date = epochOfDayKey(data.date)
        ? data.date
        : resolveDateKey(startMin, endMin, siteNow());

      return {
        start: toHHMM(startMin),
        end: toHHMM(endMin),
        minStay,
        date,
      };
    } catch {
      return null;
    }
  }

  function persistConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* modo privado / sem storage */
    }
  }

  function applyConfig() {
    if (!config) {
      state.targets = null;
      state.lastGateKey = '';
      ui.timerEmpty.hidden = false;
      ui.timerContent.hidden = true;
      ui.summaryWhen.hidden = true;
      tick();
      return;
    }

    if (!epochOfDayKey(config.date)) {
      const start = parseHHMM(config.start);
      const end = parseHHMM(config.end);
      config.date = resolveDateKey(
        start.hours * 60 + start.minutes,
        end.hours * 60 + end.minutes,
        siteNow(),
      );
    }

    state.targets = buildTargets(config);
    state.lastGateKey = '';

    ui.timerEmpty.hidden = true;
    ui.timerContent.hidden = false;
    ui.summaryStart.textContent = config.start;
    ui.summaryEnd.textContent = config.end;
    ui.summaryMin.textContent = config.minStay === 0 ? '0min' : formatMinutes(config.minStay);
    ui.summaryMin.title = config.minStay === 0
      ? 'Entrega liberada desde o início da prova'
      : `Liberação para entrega às ${formatClockHM(state.targets.releaseMs)}`;

    renderSummaryWhen();

    tick();
  }

  /* ---------------------------------------------------------------- */
  /* Modal de configurações                                            */
  /* ---------------------------------------------------------------- */

  function fillForm() {
    if (config) {
      ui.startInput.value = config.start;
      ui.endInput.value = config.end;
      ui.minStayInput.value = String(config.minStay);
    } else {
      const wall = brParts(siteNow());
      const nowMinutes = wall.hours * 60 + wall.minutes;
      ui.startInput.value = toHHMM(nowMinutes);
      ui.endInput.value = toHHMM(nowMinutes + 120);
      ui.minStayInput.value = '0';
    }
    updatePreview();
  }

  function openSettings() {
    if (!ui.dialog) return;
    fillForm();
    clearFormError();
    if (!ui.dialog.open) {
      ui.dialog.showModal();
      ui.body.classList.add('modal-open');
    }
    requestAnimationFrame(() => ui.startInput.focus({ preventScroll: true }));
  }

  function closeSettings() {
    if (ui.dialog && ui.dialog.open) ui.dialog.close();
    ui.body.classList.remove('modal-open');
  }

  function showFormError(message) {
    ui.formError.hidden = false;
    ui.formError.textContent = message;
  }

  function clearFormError() {
    ui.formError.hidden = true;
    ui.formError.textContent = '';
  }

  function readForm() {
    const start = parseHHMM(ui.startInput.value);
    const end = parseHHMM(ui.endInput.value);
    const rawMinStay = ui.minStayInput.value.trim();
    const minStay = rawMinStay === '' ? 0 : Number(rawMinStay);
    return { start, end, rawMinStay, minStay };
  }

  function validateForm() {
    const { start, end, rawMinStay, minStay } = readForm();

    if (!start) {
      return { ok: false, message: 'Informe o horário de início da prova.', focus: ui.startInput };
    }
    if (!end) {
      return { ok: false, message: 'Informe o horário de fim da prova.', focus: ui.endInput };
    }

    const startMin = start.hours * 60 + start.minutes;
    const endMin = end.hours * 60 + end.minutes;

    if (startMin === endMin) {
      return { ok: false, message: 'O início e o fim não podem ser iguais.', focus: ui.endInput };
    }

    if (rawMinStay !== '' && (!Number.isFinite(minStay) || !Number.isInteger(minStay))) {
      return { ok: false, message: 'Use um número inteiro de minutos para a permanência mínima.', focus: ui.minStayInput };
    }
    if (minStay < 0) {
      return { ok: false, message: 'A permanência mínima não pode ser negativa.', focus: ui.minStayInput };
    }
    if (minStay > MAX_MIN_STAY) {
      return { ok: false, message: `A permanência mínima vai até ${MAX_MIN_STAY} minutos (24h).`, focus: ui.minStayInput };
    }

    const duration = minutesBetween(startMin, endMin);
    if (minStay > duration) {
      return {
        ok: false,
        message: `A permanência mínima (${formatMinutes(minStay)}) não pode ser maior que a duração da prova (${formatMinutes(duration)}).`,
        focus: ui.minStayInput,
      };
    }

    return { ok: true, startMin, endMin, duration, minStay };
  }

  function updatePreview() {
    const { start, end, rawMinStay, minStay } = readForm();

    if (!start || !end) {
      ui.preview.textContent = 'Preencha o início e o fim para ver a duração e a liberação.';
      return;
    }

    const startMin = start.hours * 60 + start.minutes;
    const endMin = end.hours * 60 + end.minutes;
    if (startMin === endMin) {
      ui.preview.textContent = 'O início e o fim são iguais — ajuste um dos horários.';
      return;
    }

    const duration = minutesBetween(startMin, endMin);
    const crossesMidnight = endMin <= startMin;
    const valid = rawMinStay === ''
      || (Number.isFinite(minStay) && Number.isInteger(minStay) && minStay >= 0);
    const applied = valid ? Math.min(minStay, duration) : 0;

    const parts = [`Duração: ${formatMinutes(duration)}`];
    if (crossesMidnight) parts.push('atravessa a meia-noite');
    let text = `${parts.join(' · ')}.`;

    if (!valid) {
      text += ' A permanência mínima precisa ser um número inteiro de minutos.';
    } else if (minStay > duration) {
      text += ` A permanência mínima passa da duração (${formatMinutes(duration)}).`;
    } else if (applied === 0) {
      text += ' Entrega liberada desde o início.';
    } else if (applied >= duration) {
      text += ' A entrega é liberada no fim da prova.';
    } else {
      text += ` Liberação para entrega às ${toHHMM(startMin + applied)}.`;
    }

    ui.preview.textContent = text;
  }

  function handleSubmit(event) {
    event.preventDefault();

    const result = validateForm();
    if (!result.ok) {
      showFormError(result.message);
      if (result.focus) result.focus.focus();
      return;
    }

    clearFormError();

    config = {
      start: toHHMM(result.startMin),
      end: toHHMM(result.endMin),
      minStay: result.minStay,
      date: resolveDateKey(result.startMin, result.endMin, siteNow()),
    };

    persistConfig();
    applyConfig();
    closeSettings();
  }

  function clearConfig() {
    config = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignora */
    }
    applyConfig();
    closeSettings();
  }

  /* ---------------------------------------------------------------- */
  /* Eventos                                                           */
  /* ---------------------------------------------------------------- */

  function bindEvents() {
    ui.openSettingsBtn.addEventListener('click', openSettings);
    for (const button of ui.openSettingsButtons) {
      button.addEventListener('click', openSettings);
    }

    ui.closeSettings.addEventListener('click', closeSettings);
    ui.cancelSettings.addEventListener('click', closeSettings);
    ui.clearSettings.addEventListener('click', clearConfig);
    ui.form.addEventListener('submit', handleSubmit);

    ui.dialog.addEventListener('close', () => ui.body.classList.remove('modal-open'));
    ui.dialog.addEventListener('click', (event) => {
      if (event.target === ui.dialog) closeSettings();
    });

    for (const input of [ui.startInput, ui.endInput, ui.minStayInput]) {
      input.addEventListener('input', () => {
        clearFormError();
        updatePreview();
      });
    }

    for (const button of ui.presetButtons) {
      button.addEventListener('click', () => {
        const minutes = Number(button.dataset.minutes);
        if (!Number.isFinite(minutes)) return;

        const wall = brParts(siteNow());
        const nowMinutes = wall.hours * 60 + wall.minutes;
        ui.startInput.value = toHHMM(nowMinutes);
        ui.endInput.value = toHHMM(nowMinutes + minutes);
        clearFormError();
        updatePreview();
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tick();
      if (Date.now() - state.lastSyncAt > SYNC_INTERVAL_MS) sync();
    });

    window.addEventListener('online', () => sync());
  }

  /* ---------------------------------------------------------------- */
  /* Inicialização                                                     */
  /* ---------------------------------------------------------------- */

  function tick() {
    const now = siteNow();
    renderClock(now);
    renderCountdown(now);
    renderBadge();
  }

  function init() {
    config = loadSaved();

    bindEvents();
    applyConfig();
    tick();
    sync();

    setInterval(tick, TICK_MS);
    setInterval(sync, SYNC_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
