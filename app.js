// app.js — renders one app's detail page (app.html?app=<name>), driven by
// the `app` query param matched against apps.json's keys. Mirrors
// status.js's live-refresh architecture (refreshAppStatus/scheduleRefresh)
// scoped to one fixed set of elements instead of one card per app.
// The Recent Events accordion and the uptime history strip are shared
// with status.js via common.js's renderIssueAccordion/renderUptimeStrip —
// they were byte-identical, unlike history.js's renderIncidentItem, which
// is a genuinely different layout and stays page-local by design. The
// header/favicon/uptime-stat/latency-stat rendering below stays page-local
// too — different DOM targets and different stat sets than status.js's
// per-card versions.

const APP_UPTIME_HISTORY_DAYS = 90;
const LATENCY_HISTORY_DAYS = 90;
const REFRESH_INTERVAL_MS = 60 * 1000;

// Matches FAVICON_COLORS' keys to this page's actual 3-state model
// (operational/maintenance/down) rather than status.js's operational/
// partial/down — this page has no "partial" concept (there's only ever
// one app), 'maintenance' is the exact analogue.
const FAVICON_COLORS = { operational: '#198754', maintenance: '#ffc107', down: '#dc3545' };
let faviconDataUrlCache = {};

const STATE_TEXT = { operational: 'operational', down: 'down', maintenance: 'under maintenance' };
const STATE_COLOR_CLASS = { operational: 'text-success', down: 'text-danger', maintenance: 'text-warning' };

// Overall Uptime's 4 fixed windows, each independently clamped to
// targetApp's own monitoring-start date via getRollingWindow below.
const OVERALL_UPTIME_WINDOWS = [
  { id: 'app-uptime-24h', ms: 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

let allAppNames = [];
let targetApp = null;
let baseTitle = null; // e.g. "Notflix | Status | Isaac Mason", set once targetApp is known

// monitoring-start.json's result ({ appName: isoDate }) — fetched once at
// init() alongside apps.json, resolved for targetApp via common.js's
// getMonitoringStart.
let cachedMonitoringStartByApp = {};

// formatShortTime, lastUpdatedAt, secondsUntilRefresh, renderLastUpdatedCountdown,
// tickCountdown, and startCountdownTicker now live in common.js (loaded
// before this file), shared with status.js's header countdown.

// Exact, case-sensitive match against apps.json's keys — those preserve
// canonical capitalization (e.g. "Nginx Proxy Manager"), unlike
// fetchAppIssues' GitHub-label matching, which is separately
// case-insensitive for an unrelated reason (labels are lowercase-only).
// Returns null for missing/empty/unrecognized values, including an app
// since removed from apps.json, so init() can show "not found" without
// ever calling the GitHub proxy.
function getRequestedAppName(apps) {
  const raw = new URLSearchParams(location.search).get('app');
  if (!raw) return null;
  return Object.keys(apps).includes(raw) ? raw : null;
}

function buildFaviconDataUrl(color) {
  if (faviconDataUrlCache[color]) return faviconDataUrlCache[color];
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  faviconDataUrlCache[color] = canvas.toDataURL('image/png');
  return faviconDataUrlCache[color];
}

// Takes the already-computed 3-way state directly, rather than the old
// (online, inMaintenance) booleans — that pairing was buggy: online was
// *always* false whenever inMaintenance was true (online was computed
// upstream as !hasOpenAutoOutage && !inMaintenance), so the old
// `online ? 'partial' : 'down'` branch could never actually reach
// 'partial' during a real maintenance window. A single explicit state
// value removes the possibility of that kind of derived-boolean bug.
function updateFaviconAndTitle(state) {
  document.getElementById('favicon').href = buildFaviconDataUrl(FAVICON_COLORS[state]);
  const prefix = state === 'down' ? 'Down | ' : state === 'maintenance' ? 'Attention | ' : '';
  document.title = `${prefix}${baseTitle}`;
}

// Header replaces the old badge + message entirely: "<AppName> is
// <state>", state word colored via Bootstrap's text-success/-warning/
// -danger utilities (no new CSS) — same color families as the favicon.
function setAppState(state) {
  const stateSpan = document.getElementById('app-state');
  stateSpan.textContent = STATE_TEXT[state];
  stateSpan.className = STATE_COLOR_CLASS[state];
}

// Generalized version of the old getAppUptimeWindow: rolling `windowMs`
// window clamped to targetApp's own monitoring-start date, exactly like
// status.js's "All Time" timeframe (getUptimeWindow) — without this, a
// window would currently extend before monitoring began, inflating the
// percentage.
function getRollingWindow(windowMs, now) {
  const rollingStart = new Date(now.getTime() - windowMs);
  const monitoringStart = getMonitoringStart(targetApp, cachedMonitoringStartByApp);
  const windowStart = rollingStart > monitoringStart ? rollingStart : monitoringStart;
  return [windowStart, now];
}

// The Uptime box's headline percent — now a 90-day rolling window (was
// 30/"1 Month"), to match the "Last 90 Days" label beside it and the
// 90-day history strip directly below it in the same box.
function renderAppUptimePercent(issues) {
  const [windowStart, windowEnd] = getRollingWindow(APP_UPTIME_HISTORY_DAYS * 24 * 60 * 60 * 1000, new Date());
  const percent = calculateUptimePercent(issues, windowStart, windowEnd);
  document.getElementById('app-uptime-percent').textContent = `${percent.toFixed(2)}% uptime`;
}

// Adapted from status.js's renderUptimeHistory: same shared day-square
// strip (common.js's renderUptimeStrip), APP_UPTIME_HISTORY_DAYS instead
// of 30, targeting this page's single #app-uptime-history container.
function renderAppUptimeHistory(issues) {
  const container = document.getElementById('app-uptime-history');
  renderUptimeStrip(container, issues, APP_UPTIME_HISTORY_DAYS, getMonitoringStart(targetApp, cachedMonitoringStartByApp), new Date());
}

// Overall Uptime's 4 independent stat columns, each its own clamped
// rolling window (24h/7d/30d/90d) via getRollingWindow above.
function renderOverallUptime(issues) {
  const now = new Date();
  for (const { id, ms } of OVERALL_UPTIME_WINDOWS) {
    const [windowStart, windowEnd] = getRollingWindow(ms, now);
    const percent = calculateUptimePercent(issues, windowStart, windowEnd);
    document.getElementById(id).textContent = `${percent.toFixed(2)}%`;
  }
}

// Response Time's 3 stat columns: avg/max/min over the last
// LATENCY_HISTORY_DAYS days. latency-history.json is already pruned
// server-side to a 90-day rolling window, but this filters again
// client-side anyway — cheap insurance, same "don't fully trust upstream
// invariants" reasoning as MONITORING_START_DATE's own clamp elsewhere.
// A fresh app with no recorded samples yet (or none within the window)
// shows "No data" per stat instead of NaN/crashing.
function renderLatencyStats(samples) {
  const cutoff = Date.now() - LATENCY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const recent = (samples || []).filter((s) => new Date(s.t).getTime() >= cutoff);

  const avgEl = document.getElementById('app-latency-avg');
  const maxEl = document.getElementById('app-latency-max');
  const minEl = document.getElementById('app-latency-min');

  if (!recent.length) {
    avgEl.textContent = 'No data';
    maxEl.textContent = 'No data';
    minEl.textContent = 'No data';
    return;
  }

  const values = recent.map((s) => s.ms);
  const avg = values.reduce((sum, ms) => sum + ms, 0) / values.length;
  avgEl.textContent = `${Math.round(avg)}ms`;
  maxEl.textContent = `${Math.round(Math.max(...values))}ms`;
  minEl.textContent = `${Math.round(Math.min(...values))}ms`;
}

// One point per UTC calendar day, oldest first (left-to-right reading
// order) — null (not 0) for a day with no samples, so renderLatencyChart's
// spanGaps:false leaves a real gap instead of drawing a false dip to zero.
function bucketDailyAverage(samples, days) {
  const byDay = new Map();
  for (const s of samples || []) {
    const key = s.t.slice(0, 10); // YYYY-MM-DD (UTC, matches the 'Z'-suffixed timestamps already recorded)
    (byDay.get(key) || byDay.set(key, []).get(key)).push(s.ms);
  }

  const labels = [];
  const values = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = day.toISOString().slice(0, 10);
    const dayValues = byDay.get(key);
    labels.push(day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    values.push(dayValues ? Math.round(dayValues.reduce((a, b) => a + b, 0) / dayValues.length) : null);
  }
  return { labels, values };
}

// Hidden (with a "No data yet" message) until this app has at least one
// recorded sample within the window — a fresh app has nothing to chart.
function renderAppLatencyChart(samples) {
  const { labels, values } = bucketDailyAverage(samples, LATENCY_HISTORY_DAYS);
  const hasData = values.some((v) => v !== null);

  document.getElementById('latency-chart-wrap').classList.toggle('d-none', !hasData);
  document.getElementById('app-latency-empty').classList.toggle('d-none', hasData);

  // Monitoring only recently started recording latency, so for a while the
  // chart will show real data for less than the full 90-day span it's
  // scaled to — without this note, sparse-looking history reads as "no
  // traffic"/"an outage" rather than "history just hasn't accumulated yet".
  // Self-clears once real history actually reaches the full window.
  const note = document.getElementById('app-latency-note');
  if (hasData) {
    const earliest = samples.reduce((min, s) => (s.t < min ? s.t : min), samples[0].t);
    const daysCovered = (Date.now() - new Date(earliest).getTime()) / (24 * 60 * 60 * 1000);
    const spansFullWindow = daysCovered >= LATENCY_HISTORY_DAYS - 1; // rounding slack
    const earliestLabel = new Date(earliest).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    note.textContent = `Showing available data since ${earliestLabel} — not yet a full ${LATENCY_HISTORY_DAYS} days.`;
    note.classList.toggle('d-none', spansFullWindow);
  } else {
    note.classList.add('d-none');
  }

  if (!hasData) return;
  renderLatencyChart(document.getElementById('app-latency-chart'), labels, values, { compact: false });
}

let cachedFingerprint = null;

// Adapted from status.js's updateRecentUpdates: same fingerprint-diff
// skip, so an unchanged issue set doesn't rebuild the accordion (and
// doesn't clear issueCommentsCache) on every 60s tick. No page-local
// render wrapper needed here (unlike status.js) — there's no count/
// slicing step, so this calls common.js's renderIssueAccordion directly.
function updateAppRecentUpdates(recentIssues) {
  const fingerprint = fingerprintRecentIssues(recentIssues);
  if (fingerprint === cachedFingerprint) return;
  cachedFingerprint = fingerprint;
  issueCommentsCache.clear();
  renderIssueAccordion(recentIssues);
}

async function refreshAppPage() {
  const [{ recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp }, latencyByApp] =
    await Promise.all([fetchAppIssues(allAppNames), fetchLatencyHistory()]);

  const issues = downEventsByApp[targetApp] || [];

  // Maintenance takes precedence over an open auto-outage — same
  // precedence the old setAppBadge used — and is checked directly here,
  // once, rather than derived from an intermediate "online" boolean (see
  // updateFaviconAndTitle's comment above for why that mattered).
  const state = inMaintenance[targetApp] ? 'maintenance' : hasOpenAutoOutage[targetApp] ? 'down' : 'operational';

  setAppState(state);
  renderAppUptimePercent(issues);
  renderAppUptimeHistory(issues);
  renderOverallUptime(issues);
  renderLatencyStats(latencyByApp[targetApp]);
  renderAppLatencyChart(latencyByApp[targetApp]);
  updateFaviconAndTitle(state);

  const appRecentIssues = recentIssues.filter(({ apps }) => apps.includes(targetApp));
  updateAppRecentUpdates(appRecentIssues);

  lastUpdatedAt = new Date();
  secondsUntilRefresh = REFRESH_INTERVAL_MS / 1000;
  renderLastUpdatedCountdown('last-updated');
}

// No status.js-style checkForNewVersion self-reload check — this page has
// no version constant of its own (same as history.js). Out of scope here;
// picking up an app.js change just needs a manual page reload for now.
async function scheduleAppRefresh() {
  await refreshAppPage();
  setTimeout(scheduleAppRefresh, REFRESH_INTERVAL_MS);
}

function renderNotFound() {
  const raw = new URLSearchParams(location.search).get('app');
  document.getElementById('app-not-found-message').textContent = raw
    ? `No app named "${raw}" was found. It may have been renamed or removed.`
    : 'No app was specified.';
  document.getElementById('app-not-found').classList.remove('d-none');
}

async function init() {
  const [apps, monitoringStartByApp] = await Promise.all([loadApps(), fetchMonitoringStartDates()]);
  allAppNames = Object.keys(apps);
  targetApp = getRequestedAppName(apps);
  cachedMonitoringStartByApp = monitoringStartByApp;

  document.getElementById('app-loading').classList.add('d-none');
  document.getElementById('version-text').textContent = STATUS_PAGE_VERSION;

  if (!targetApp) {
    renderNotFound(); // No GitHub proxy fetch — nothing to look up.
    return;
  }

  baseTitle = `${targetApp} | Status | Isaac Mason`;
  document.title = baseTitle;
  document.getElementById('app-name').textContent = targetApp;
  document.getElementById('app-found').classList.remove('d-none');
  startCountdownTicker('last-updated');

  await scheduleAppRefresh();
}

init();
