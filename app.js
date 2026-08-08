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
// MONITORING_START_DATE via getRollingWindow below.
const OVERALL_UPTIME_WINDOWS = [
  { id: 'app-uptime-24h', ms: 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'app-uptime-90d', ms: 90 * 24 * 60 * 60 * 1000 },
];

let allAppNames = [];
let targetApp = null;
let baseTitle = null; // e.g. "Notflix | Status | Isaac Mason", set once targetApp is known

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
// window clamped to MONITORING_START_DATE, exactly like status.js's "All
// Time" timeframe (getUptimeWindow) — without this, a window would
// currently extend before monitoring began, inflating the percentage.
function getRollingWindow(windowMs, now) {
  const rollingStart = new Date(now.getTime() - windowMs);
  const monitoringStart = new Date(MONITORING_START_DATE);
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
  renderUptimeStrip(container, issues, APP_UPTIME_HISTORY_DAYS, new Date(MONITORING_START_DATE), new Date());
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
  updateFaviconAndTitle(state);

  const appRecentIssues = recentIssues.filter(({ apps }) => apps.includes(targetApp));
  updateAppRecentUpdates(appRecentIssues);

  document.getElementById('last-updated').textContent = `Last updated: ${formatTimestamp(new Date())}`;
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
  const apps = await loadApps();
  allAppNames = Object.keys(apps);
  targetApp = getRequestedAppName(apps);

  document.getElementById('app-loading').classList.add('d-none');

  if (!targetApp) {
    renderNotFound(); // No GitHub proxy fetch — nothing to look up.
    return;
  }

  baseTitle = `${targetApp} | Status | Isaac Mason`;
  document.title = baseTitle;
  document.getElementById('app-name').textContent = targetApp;
  document.getElementById('app-found').classList.remove('d-none');

  await scheduleAppRefresh();
}

init();
