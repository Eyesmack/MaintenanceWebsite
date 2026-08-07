// app.js — renders one app's detail page (app.html?app=<name>), driven by
// the `app` query param matched against apps.json's keys. Mirrors
// status.js's live-refresh architecture (refreshAppStatus/scheduleRefresh)
// scoped to one fixed set of elements instead of one card per app.
// The Recent Updates accordion and the uptime history strip are shared
// with status.js via common.js's renderIssueAccordion/renderUptimeStrip —
// they were byte-identical, unlike history.js's renderIncidentItem, which
// is a genuinely different layout and stays page-local by design. The
// badge/message/favicon rendering below (setAppBadge, setAppMessage,
// updateFaviconAndTitle) stays page-local too — different DOM targets
// than status.js's per-card versions, and slated for its own redesign.

const APP_UPTIME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // matches status.js's UPTIME_TIMEFRAMES['1m']
const APP_UPTIME_HISTORY_DAYS = 90;
const REFRESH_INTERVAL_MS = 60 * 1000;

const FAVICON_COLORS = { operational: '#198754', partial: '#ffc107', down: '#dc3545' };
let faviconDataUrlCache = {};

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

// Same 3-state model as status.js's updateFaviconAndTitle (operational/
// partial/down) rather than inventing a 4th "maintenance" state — keeps
// the favicon meaning consistent between the two pages.
function updateFaviconAndTitle(online, inMaintenance) {
  const state = inMaintenance || !online ? (online ? 'partial' : 'down') : 'operational';
  document.getElementById('favicon').href = buildFaviconDataUrl(FAVICON_COLORS[state]);
  const prefix = state === 'down' ? 'Down | ' : state === 'partial' ? 'Attention | ' : '';
  document.title = `${prefix}${baseTitle}`;
}

// Verbatim logic from status.js's setBadge/setMessage (status.js:34-67),
// retargeted from a per-card `col.querySelector` to this page's single
// fixed elements — there's only ever one app on this page.
function setAppBadge(online, hasIssue, inMaintenance) {
  const badge = document.getElementById('app-badge');
  if (inMaintenance) {
    badge.textContent = 'Maintenance';
    badge.className = 'badge bg-info';
    return;
  }
  badge.textContent = online ? 'Online' : 'Offline';
  const badgeClass = online && hasIssue ? 'bg-warning' : online ? 'bg-success' : 'bg-danger';
  badge.className = `badge ${badgeClass}`;
}

function setAppMessage(online, issues) {
  const message = document.getElementById('app-message');
  message.textContent = '';
  if (issues && issues.length) {
    const link = document.createElement('a');
    link.href = issues[0].html_url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = issues[0].title;
    message.appendChild(link);
    return;
  }
  message.textContent = online
    ? 'This service has no known issues or planned maintenance.'
    : 'This service is currently unreachable according to automated checks.';
}

// Rolling 30 days, clamped to MONITORING_START_DATE exactly like
// status.js's "All Time" timeframe (getUptimeWindow, status.js:363-369) —
// without this, the window would currently extend before monitoring
// began, inflating the percentage the same way history.js's oldest
// monthly row did before that was fixed.
function getAppUptimeWindow(now) {
  const rollingStart = new Date(now.getTime() - APP_UPTIME_WINDOW_MS);
  const monitoringStart = new Date(MONITORING_START_DATE);
  const windowStart = rollingStart > monitoringStart ? rollingStart : monitoringStart;
  return [windowStart, now];
}

function renderAppUptimePercent(issues) {
  const [windowStart, windowEnd] = getAppUptimeWindow(new Date());
  const percent = calculateUptimePercent(issues, windowStart, windowEnd);
  document.getElementById('app-uptime-percent').textContent = `${percent.toFixed(2)}% uptime (1 Month)`;
}

// Adapted from status.js's renderUptimeHistory: same shared day-square
// strip (common.js's renderUptimeStrip), APP_UPTIME_HISTORY_DAYS instead
// of 30, targeting this page's single #app-uptime-history container.
function renderAppUptimeHistory(issues) {
  const container = document.getElementById('app-uptime-history');
  renderUptimeStrip(container, issues, APP_UPTIME_HISTORY_DAYS, new Date(MONITORING_START_DATE), new Date());
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
  const { issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp } =
    await fetchAppIssues(allAppNames);

  const issues = downEventsByApp[targetApp] || [];
  const openIssues = issuesByApp[targetApp];
  const online = !hasOpenAutoOutage[targetApp] && !inMaintenance[targetApp];
  const hasIssue = Boolean(openIssues && openIssues.length);
  const maintenance = Boolean(inMaintenance[targetApp]);

  setAppBadge(online, hasIssue, maintenance);
  setAppMessage(online, openIssues);
  renderAppUptimePercent(issues);
  renderAppUptimeHistory(issues);
  updateFaviconAndTitle(online, maintenance);

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
