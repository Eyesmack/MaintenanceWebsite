// Bump this by hand whenever you change status.js/index.html, so the footer
// tells you which version of the page a visitor (or you) is actually seeing.
const STATUS_PAGE_VERSION = 'v1.17.2';

// Captured once, before status.js ever changes it, so index.html's
// <title> stays the single source of truth for the page's base title.
const BASE_TITLE = document.title;

// Matches the hex values behind Bootstrap's bg-success/bg-warning/bg-danger,
// so the favicon dot's colors stay consistent with the card badges.
const FAVICON_COLORS = { operational: '#198754', partial: '#ffc107', down: '#dc3545' };
let faviconDataUrlCache = {};

// loadApps, GITHUB_REPO, GITHUB_PROXY_BASE, MONITORING_START_DATE,
// getTimeZoneOffsetMinutes, parseZonedDateTime, extractMaintenanceWindow,
// fetchAppIssues, timestampText, shortTimestampText, issueCommentsCache,
// fetchIssueComments, preloadIssueComments, fingerprintRecentIssues,
// renderIssueAccordion, and renderUptimeStrip now live in common.js
// (loaded before this file), shared with history.js and/or app.js.

const UPTIME_TIMEFRAMES = {
  '24h': { label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: '7 Days', ms: 7 * 24 * 60 * 60 * 1000 },
  '1m': { label: '1 Month', ms: 30 * 24 * 60 * 60 * 1000 },
  '1y': { label: '1 Year', ms: 365 * 24 * 60 * 60 * 1000 },
  all: { label: 'All Time', ms: null },
};

// The history bar's length is fixed and independent of the Uptime %
// selector above (same convention most status pages use).
const UPTIME_HISTORY_DAYS = 30;

// Matches the workflow's hourly sampling cadence for latency-history.json.
const LATENCY_HISTORY_HOURS = 24;

function setBadge(col, online, hasIssue, inMaintenance) {
  const badge = col.querySelector('[data-badge]');
  if (inMaintenance) {
    badge.textContent = 'Maintenance';
    badge.className = 'badge rounded-pill bg-info';
    return;
  }
  badge.textContent = online ? 'Online' : 'Offline';
  const badgeClass = online && hasIssue ? 'bg-warning' : online ? 'bg-success' : 'bg-danger';
  badge.className = `badge rounded-pill ${badgeClass}`;
}

// Shows the most recent open issue's title for this app (if any),
// regardless of reachability, so planned-maintenance notices still
// show even while the app is still online. Falls back to the
// reachability message otherwise.
function setMessage(col, online, issues) {
  const message = col.querySelector('[data-message]');
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

function getOverallState(onlineFlags) {
  const onlineCount = onlineFlags.filter(Boolean).length;
  if (onlineCount === onlineFlags.length) return 'operational';
  if (onlineCount === 0) return 'down';
  return 'partial';
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

// The favicon dot always reflects the current state (a steady "still
// green" signal), but the title is only prefixed for non-operational
// states — reserved for "something needs your attention".
function updateFaviconAndTitle(state) {
  document.getElementById('favicon').href = buildFaviconDataUrl(FAVICON_COLORS[state]);
  const prefix = state === 'down' ? 'Full Outage | ' : state === 'partial' ? 'Partial Outage | ' : '';
  document.title = `${prefix}${BASE_TITLE}`;
}

function updateHeading(state) {
  const heading = document.getElementById('status-heading');
  const subheading = document.getElementById('status-subheading');

  if (state === 'operational') {
    heading.textContent = 'All Systems Operational';
    subheading.textContent = 'Everything is up and running normally.';
  } else if (state === 'down') {
    heading.textContent = "We'll be right back";
    subheading.textContent = "Everything appears to be down. I'm looking into it — thanks for your patience!";
  } else {
    heading.textContent = 'Partial Outage';
    subheading.textContent = 'Some services are currently unreachable. Check the status below for details.';
  }
}

// Builds one status card per entry in apps.json, so adding or removing
// an app there is all it takes to add or remove it from the page.
function createStatusCard(app) {
  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.app = app;

  const card = document.createElement('div');
  card.className = 'card sub-card h-100 text-center';
  const body = document.createElement('div');
  body.className = 'card-body pb-0';

  const title = document.createElement('h5');
  title.className = 'card-title text';
  const nameLink = document.createElement('a');
  nameLink.href = `app?app=${encodeURIComponent(app)}`;
  nameLink.className = 'app-name-link';
  nameLink.textContent = app;
  title.append(nameLink, ' ');
  const badge = document.createElement('span');
  badge.className = 'badge rounded-pill bg-secondary';
  badge.dataset.badge = '';
  badge.textContent = 'Checking…';
  title.appendChild(badge);

  const message = document.createElement('p');
  message.className = 'card-text text';
  message.dataset.message = '';

  const uptimeRow = document.createElement('div');
  uptimeRow.className = 'd-flex justify-content-between align-items-center gap-2 mt-2';

  const uptimeText = document.createElement('p');
  uptimeText.className = 'card-text text small mb-0';
  uptimeText.dataset.uptime = '';
  uptimeText.textContent = 'Calculating…';

  uptimeRow.append(uptimeText);

  const uptimeHistoryLabel = document.createElement('p');
  uptimeHistoryLabel.className = 'small text mb-1 mt-2';
  uptimeHistoryLabel.textContent = 'Uptime History (Last 30 Days)';

  const uptimeHistory = document.createElement('div');
  uptimeHistory.className = 'd-flex gap-1';
  uptimeHistory.style.height = '18px';
  uptimeHistory.dataset.uptimeHistory = '';

  // Hidden until this app has at least one recorded sample — the hourly
  // workflow run that populates latency-history.json won't have landed
  // yet right after this ships, so there's nothing to chart initially.
  const latencySection = document.createElement('div');
  latencySection.dataset.latencySection = '';
  latencySection.className = 'd-none';

  const latencyLabel = document.createElement('p');
  latencyLabel.className = 'small text mb-1 mt-2';
  latencyLabel.textContent = 'Response Time (Last 24 Hours)';

  const latencyHistory = document.createElement('div');
  latencyHistory.className = 'd-flex gap-1 align-items-end';
  latencyHistory.style.height = '18px';
  latencyHistory.dataset.latencyHistory = '';

  latencySection.append(latencyLabel, latencyHistory);

  body.append(title, message);

  // A card-footer (not just another card-body child) so it sits pinned to
  // the bottom of the card regardless of how tall the message above it
  // is — .card is already a flex column and .card-body already grows to
  // fill the remaining space, so a following .card-footer naturally lands
  // at the bottom. Same pattern already used for the page's own footer.
  const cardFooter = document.createElement('div');
  cardFooter.className = 'card-footer border-top-0 pt-0';
  cardFooter.append(uptimeRow, uptimeHistoryLabel, uptimeHistory, latencySection);

  card.append(body, cardFooter);
  col.appendChild(card);
  return col;
}

function renderStatusCards(apps) {
  const container = document.getElementById('status-cards');
  container.innerHTML = '';
  const cols = {};
  for (const app of Object.keys(apps)) {
    const col = createStatusCard(app);
    container.appendChild(col);
    cols[app] = col;
  }
  return cols;
}

// One shared timeframe selector for every card, instead of one per card —
// the same options apply uniformly to all apps, so there's no need to
// repeat the control five times.
function createUptimeTimeframeSelector() {
  const row = document.getElementById('uptime-timeframe-row');
  if (!row) return;

  const label = document.createElement('label');
  label.htmlFor = 'uptime-timeframe-select';
  label.className = 'small text mb-0';
  label.textContent = 'Uptime% Timeframe:';

  const select = document.createElement('select');
  select.id = 'uptime-timeframe-select';
  select.className = 'form-select form-select-sm';
  select.style.width = 'auto';
  for (const [key, { label: optionLabel }] of Object.entries(UPTIME_TIMEFRAMES)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = optionLabel;
    if (key === '7d') option.selected = true;
    select.appendChild(option);
  }

  row.append(label, select);
}

// Caches the full (open + closed) matched issue list so the "Last 5 /
// Last 10" selector can re-render instantly without re-fetching.
let cachedRecentIssues = [];

// Per-app down-event history, cached so the uptime timeframe selector can
// recompute instantly without re-fetching.
let cachedDownEventsByApp = {};

// Per-app response-time samples from latency-history.json.
let cachedLatencyByApp = {};

// All app names, cached so the shared timeframe selector's change handler
// can update every card — Object.keys(cachedDownEventsByApp) alone isn't
// reliable for this since an app with zero matched issues ever never gets
// a key in that map at all.
let cachedAppNames = [];

// apps.json's result — only app names are used client-side now (see
// refreshAppStatus), but the map is kept around rather than re-fetched.
let cachedApps = {};

// { appName: colElement }, from renderStatusCards() — kept so the refresh
// loop can update the existing card DOM in place instead of rebuilding it
// every cycle (the app list never changes at runtime).
let cachedCols = {};

// Fingerprint of the last-rendered Recent Updates issue list, so the
// refresh loop only rebuilds that accordion (which would collapse any
// expanded item) when something actually changed.
let cachedRecentIssuesFingerprint = null;

function renderUptime(app) {
  const select = document.getElementById('uptime-timeframe-select');
  const text = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime]`);
  if (!select || !text) return;

  const timeframeKey = select.value;
  const { label } = UPTIME_TIMEFRAMES[timeframeKey];
  const [windowStart, windowEnd] = getUptimeWindow(timeframeKey, new Date());
  const percent = calculateUptimePercent(cachedDownEventsByApp[app] || [], windowStart, windowEnd);
  text.textContent = `${percent.toFixed(2)}% uptime (${label})`;
}

// One listener on the single shared selector, rather than one per card —
// recomputes every app from the cached issue history, no re-fetch.
function initUptimeTimeframeSelector() {
  document.getElementById('uptime-timeframe-select')?.addEventListener('change', () => {
    cachedAppNames.forEach((app) => renderUptime(app));
  });
}

// Fixed-length day-by-day history strip, independent of the timeframe
// selector above — see common.js's renderUptimeStrip for the shared loop.
function renderUptimeHistory(app) {
  const container = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime-history]`);
  if (!container) return;
  renderUptimeStrip(container, cachedDownEventsByApp[app] || [], UPTIME_HISTORY_DAYS, new Date(MONITORING_START_DATE), new Date());
}

// Bar height (not color) encodes relative latency — unlike uptime, a
// slower response isn't inherently "bad" (some self-hosted apps are just
// normally slower), so there's no invented good/bad threshold here, just
// a sparkline scaled against the max value currently in view. Hidden
// entirely until this app has at least one recorded sample.
function renderLatencyHistory(app) {
  const col = document.querySelector(`#status-cards [data-app="${app}"]`);
  if (!col) return;
  const section = col.querySelector('[data-latency-section]');
  const container = col.querySelector('[data-latency-history]');

  const samples = (cachedLatencyByApp[app] || []).slice(-LATENCY_HISTORY_HOURS);
  if (!samples.length) {
    section.classList.add('d-none');
    return;
  }

  container.innerHTML = '';
  const maxMs = Math.max(...samples.map((s) => s.ms), 1);
  for (const sample of samples) {
    const bar = document.createElement('div');
    bar.className = 'flex-fill rounded-1 bg-info';
    bar.style.height = `${Math.max(8, Math.round((sample.ms / maxMs) * 100))}%`;
    bar.setAttribute('data-bs-toggle', 'tooltip');
    bar.title = `${formatTimestamp(sample.t)} — ${sample.ms}ms`;
    container.appendChild(bar);
  }

  container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
  section.classList.remove('d-none');
}

// formatTimestamp, formatDuration, and calculateUptimePercent now live in
// common.js (loaded before this file), shared with history.js.

function getUptimeWindow(timeframeKey, now) {
  const timeframe = UPTIME_TIMEFRAMES[timeframeKey];
  const start = timeframeKey === 'all'
    ? new Date(MONITORING_START_DATE)
    : new Date(now.getTime() - timeframe.ms);
  return [start, now];
}

// Re-slices the cached full issue list by the selected count and hands
// off to the shared accordion renderer (common.js) — count/slicing is the
// only status.js-specific piece here; see cachedRecentIssues above.
function renderRecentUpdates(count) {
  renderIssueAccordion(cachedRecentIssues.slice(0, count));
}

// Skips rebuilding the accordion when nothing has changed since the last
// check — renderRecentUpdates() wipes and rebuilds it from scratch, which
// would collapse any item the user currently has expanded.
function updateRecentUpdates(recentIssues) {
  const fingerprint = fingerprintRecentIssues(recentIssues);
  if (fingerprint === cachedRecentIssuesFingerprint) return;
  cachedRecentIssuesFingerprint = fingerprint;
  cachedRecentIssues = recentIssues;
  issueCommentsCache.clear();
  renderRecentUpdates(Number(document.getElementById('recent-updates-count').value));
}

function initRecentUpdates() {
  const select = document.getElementById('recent-updates-count');
  select.addEventListener('change', () => renderRecentUpdates(Number(select.value)));
}

// Re-pulls GitHub issue data and updates the page in place — no client
// probe of the apps themselves anymore (the workflow already checks every
// app every ~1 minute server-side), and no rebuilding of #status-cards
// (the app list never changes at runtime; cachedCols reuses the same DOM).
async function refreshAppStatus() {
  const [{ issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp }, latencyByApp] =
    await Promise.all([fetchAppIssues(cachedAppNames), fetchLatencyHistory()]);

  cachedDownEventsByApp = downEventsByApp;
  cachedLatencyByApp = latencyByApp;

  // "Online" comes entirely from the workflow's own server-side checks (an
  // open auto-outage issue) or an announced maintenance window.
  const onlineByApp = Object.fromEntries(
    cachedAppNames.map((app) => [app, !hasOpenAutoOutage[app] && !inMaintenance[app]])
  );

  cachedAppNames.forEach((app) => {
    const online = onlineByApp[app];
    const issues = issuesByApp[app];
    setBadge(cachedCols[app], online, Boolean(issues && issues.length), Boolean(inMaintenance[app]));
    setMessage(cachedCols[app], online, issues);
    renderUptime(app);
    renderUptimeHistory(app);
    renderLatencyHistory(app);
  });

  const state = getOverallState(cachedAppNames.map((app) => onlineByApp[app]));
  updateHeading(state);
  updateFaviconAndTitle(state);
  updateRecentUpdates(recentIssues);

  document.getElementById('last-updated').textContent =
    `Last updated: ${formatTimestamp(new Date())} · ${STATUS_PAGE_VERSION}`;
}

const REFRESH_INTERVAL_MS = 60 * 1000;

// latency-history.json is committed by the workflow (see status-check.yml)
// once an hour — a plain same-origin static file, like apps.json, so this
// needs no Cloudflare Worker/GitHub API involvement and no rate-limit use.
async function fetchLatencyHistory() {
  try {
    const res = await fetch(`latency-history.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Re-fetches the page's own live status.js (cache-busted) and compares its
// STATUS_PAGE_VERSION to the one already running. Checking the live file
// itself, rather than the repo/API, means this only ever reloads once a
// new deploy is actually being served — no false positive during GitHub
// Pages' own build/propagation lag right after a push.
async function checkForNewVersion() {
  try {
    const res = await fetch(`status.js?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    const match = text.match(/const STATUS_PAGE_VERSION = '([^']+)'/);
    if (match && match[1] !== STATUS_PAGE_VERSION) {
      location.reload();
      return true;
    }
  } catch {
    // A fetch hiccup just means we try again next cycle.
  }
  return false;
}

// Reschedules only after the current refresh finishes, rather than a
// blind setInterval, so a slow tick can never overlap with the next one.
async function scheduleRefresh() {
  if (await checkForNewVersion()) return;
  await refreshAppStatus();
  setTimeout(scheduleRefresh, REFRESH_INTERVAL_MS);
}

async function init() {
  cachedApps = await loadApps();
  createUptimeTimeframeSelector();
  cachedCols = renderStatusCards(cachedApps);
  cachedAppNames = Object.keys(cachedApps);

  initUptimeTimeframeSelector();
  initRecentUpdates();

  document.getElementById('version-text').textContent = `${STATUS_PAGE_VERSION}`;

  await scheduleRefresh();
}

init();
