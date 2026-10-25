// Captured once, before status.js ever changes it, so index.html's
// <title> stays the single source of truth for the page's base title.
const BASE_TITLE = document.title;

// Same values as style.css's --st-up/--st-warn/--st-down/--st-maint, so the
// favicon dot matches the hero and the service chips.
const FAVICON_COLORS = { operational: '#22c55e', partial: '#f59e0b', down: '#ef4444', maintenance: '#288ef9' };
let faviconDataUrlCache = {};

// loadApps, GITHUB_REPO, GITHUB_PROXY_BASE, MONITORING_START_DATE,
// getTimeZoneOffsetMinutes, parseZonedDateTime, extractMaintenanceWindow,
// fetchAppIssues, timestampText, shortTimestampText, issueCommentsCache,
// fetchIssueComments, preloadIssueComments, fingerprintRecentIssues,
// renderIssueAccordion, renderClosedIncidentCard, renderOpenIncidentCard,
// renderUptimeStrip, fetchLatencyHistory, renderLatencyChart,
// formatShortTime, lastUpdatedAt, secondsUntilRefresh,
// renderLastUpdatedCountdown, tickCountdown, startCountdownTicker,
// fetchMonitoringStartDates, getMonitoringStart, fetchIssueSummaries, and
// VERSION_NUMBER now live in common.js (loaded before this file),
// shared with history.js and/or app.js.

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

// The row's data-state colours its dot and chip together (style.css).
// "degraded" = reachable, but with an open notice filed against it.
function setBadge(col, online, hasIssue, inMaintenance) {
  const badge = col.querySelector('[data-badge]');
  let state;
  if (inMaintenance) {
    state = 'maintenance';
    badge.textContent = 'Maintenance';
  } else {
    state = !online ? 'down' : hasIssue ? 'degraded' : 'up';
    badge.textContent = online ? (hasIssue ? 'Notice' : 'Operational') : 'Offline';
  }
  col.dataset.state = state;
  badge.dataset.state = state;
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

  // A healthy service needs no message — the empty element hides itself.
  message.textContent = online ? '' : 'Unreachable according to automated checks.';
}

// Only real outages count towards partial/down — a service inside an
// announced maintenance window is expected to be away, so the page says
// "maintenance" rather than "everything appears to be down".
function getOverallState(appIds, hasOpenAutoOutage, inMaintenance) {
  const outageCount = appIds.filter((app) => hasOpenAutoOutage[app] && !inMaintenance[app]).length;
  if (outageCount && outageCount === appIds.length) return 'down';
  if (outageCount) return 'partial';
  if (appIds.some((app) => inMaintenance[app])) return 'maintenance';
  return 'operational';
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
  const prefix = { down: 'Full Outage | ', partial: 'Partial Outage | ', maintenance: 'Maintenance | ' }[state] || '';
  document.title = `${prefix}${BASE_TITLE}`;
}

// Hero copy and icon per overall state; the hero's data-state colours it.
const HERO = {
  operational: {
    data: 'up',
    title: 'All systems operational',
    sub: 'Everything is up and running normally.',
    icon: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  },
  partial: {
    data: 'degraded',
    title: 'Partial outage',
    sub: 'Some services are currently unreachable. Details are below.',
    icon: '<path d="M12 7v6"/><path d="M12 17h.01"/>',
  },
  down: {
    data: 'down',
    title: "We'll be right back",
    sub: "Everything appears to be down. I'm looking into it — thanks for your patience!",
    icon: '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>',
  },
  maintenance: {
    data: 'maintenance',
    title: 'Scheduled maintenance',
    sub: 'Planned work is underway, so some services may be slow or unavailable for a while.',
    icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"/>',
  },
};

function updateHeading(state) {
  const hero = HERO[state];
  document.getElementById('status-hero').dataset.state = hero.data;
  document.getElementById('status-hero-icon').innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${hero.icon}</svg>`;
  document.getElementById('status-heading').textContent = hero.title;
  document.getElementById('status-subheading').textContent = hero.sub;
}

// Builds one service row per entry in apps.json, so adding or removing an
// app there is all it takes to add or remove it from the page. `app` is the
// app's id (see common.js's loadApps) — the row is keyed by it, and only
// the visible link text uses the display name. The data-* hooks are what
// the refresh loop fills in; the layout itself is style.css's .st-service.
function createStatusCard(app) {
  const col = document.createElement('article');
  col.className = 'st-service';
  col.dataset.app = app;
  col.dataset.state = 'checking';

  const id = document.createElement('div');
  id.className = 'st-service-id';
  const dot = document.createElement('span');
  dot.className = 'st-dot';
  dot.setAttribute('aria-hidden', 'true');

  const text = document.createElement('div');
  text.className = 'min-w-0';
  const title = document.createElement('h3');
  title.className = 'st-service-name';
  const nameLink = document.createElement('a');
  nameLink.href = `app?app=${encodeURIComponent(app)}`;
  nameLink.textContent = getAppName(app);
  const badge = document.createElement('span');
  badge.className = 'st-chip';
  badge.dataset.badge = '';
  badge.dataset.state = 'checking';
  badge.textContent = 'Checking…';
  title.append(nameLink, badge);

  const message = document.createElement('p');
  message.className = 'st-service-msg';
  message.dataset.message = '';
  text.append(title, message);
  id.append(dot, text);

  // Fixed 30-day strip, with the selected-timeframe uptime % in its caption.
  const bars = document.createElement('div');
  bars.className = 'st-service-bars';
  const uptimeHistory = document.createElement('div');
  uptimeHistory.className = 'st-bars';
  uptimeHistory.dataset.uptimeHistory = '';
  const barsMeta = document.createElement('div');
  barsMeta.className = 'st-bars-meta';
  const uptimeText = document.createElement('span');
  uptimeText.dataset.uptime = '';
  uptimeText.textContent = 'Calculating…';
  barsMeta.append(document.createElement('span'), uptimeText, document.createElement('span'));
  barsMeta.firstChild.textContent = '30 days ago';
  barsMeta.lastChild.textContent = 'Today';
  bars.append(uptimeHistory, barsMeta);

  // Hidden until this app has at least one recorded sample (see
  // renderLatencyHistory). A bare canvas has no intrinsic block height,
  // so it needs a sized parent.
  const latencySection = document.createElement('div');
  latencySection.className = 'st-service-spark';
  latencySection.dataset.latencySection = '';
  latencySection.style.visibility = 'hidden';
  const latencyHistoryWrap = document.createElement('div');
  latencyHistoryWrap.className = 'st-spark-wrap';
  const latencyHistory = document.createElement('canvas');
  latencyHistory.dataset.latencyHistory = '';
  latencyHistory.setAttribute('aria-label', 'Response time, last 24 hours');
  latencyHistoryWrap.appendChild(latencyHistory);
  const latencyLabel = document.createElement('div');
  latencyLabel.className = 'st-spark-label';
  latencyLabel.dataset.latencyLabel = '';
  latencyLabel.textContent = 'Response · 24h';
  latencySection.append(latencyHistoryWrap, latencyLabel);

  col.append(id, bars, latencySection);
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
  label.textContent = 'Uptime over';

  const select = document.createElement('select');
  select.id = 'uptime-timeframe-select';
  select.className = 'form-select form-select-sm st-select';
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

// All app ids, cached so the shared timeframe selector's change handler
// can update every card — Object.keys(cachedDownEventsByApp) alone isn't
// reliable for this since an app with zero matched issues ever never gets
// a key in that map at all.
let cachedAppIds = [];

// apps.json's result — only app ids (and, via getAppName, names) are used
// client-side now (see refreshAppStatus), but the map is kept around
// rather than re-fetched.
let cachedApps = {};

// monitoring-start.json's result ({ appId: isoDate }) — fetched once at
// init() alongside apps.json (it changes about as often, i.e. only when a
// new app is added), resolved per-app via common.js's getMonitoringStart.
let cachedMonitoringStartByApp = {};

// issue-summaries.json's result ({ issueNumber: summaryText }) — refreshed
// every cycle (unlike monitoring-start.json) so a just-closed issue's AI
// summary shows up within a refresh or two instead of only after a full
// page reload.
let cachedIssueSummaries = {};

// { appId: colElement }, from renderStatusCards() — kept so the refresh
// loop can update the existing card DOM in place instead of rebuilding it
// every cycle (the app list never changes at runtime).
let cachedCols = {};

// Fingerprint of the last-rendered Recent Updates issue list, so the
// refresh loop only rebuilds the cards (and clears issueCommentsCache, an
// actual network-request cost) when the issues themselves actually
// changed. Tracked separately from cachedIssueSummariesFingerprint below —
// a closed issue's AI summary can land on a later refresh cycle without
// its own state/updated_at changing, so relying on this fingerprint alone
// would leave a stale "Summary pending…" card up indefinitely.
let cachedRecentIssuesFingerprint = null;
let cachedIssueSummariesFingerprint = null;

function renderUptime(app) {
  const select = document.getElementById('uptime-timeframe-select');
  const text = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime]`);
  if (!select || !text) return;

  const timeframeKey = select.value;
  const { label } = UPTIME_TIMEFRAMES[timeframeKey];
  const [windowStart, windowEnd] = getUptimeWindow(timeframeKey, new Date(), app);
  const percent = calculateUptimePercent(cachedDownEventsByApp[app] || [], windowStart, windowEnd, app);
  text.innerHTML = '';
  const strong = document.createElement('strong');
  strong.textContent = `${percent.toFixed(2)}%`;
  text.append(strong, ` uptime · ${label.toLowerCase()}`);
}

// One listener on the single shared selector, rather than one per card —
// recomputes every app from the cached issue history, no re-fetch.
function initUptimeTimeframeSelector() {
  document.getElementById('uptime-timeframe-select')?.addEventListener('change', () => {
    cachedAppIds.forEach((app) => renderUptime(app));
  });
}

// Fixed-length day-by-day history strip, independent of the timeframe
// selector above — see common.js's renderUptimeStrip for the shared loop.
function renderUptimeHistory(app) {
  const container = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime-history]`);
  if (!container) return;
  renderUptimeStrip(container, cachedDownEventsByApp[app] || [], UPTIME_HISTORY_DAYS, getMonitoringStart(app, cachedMonitoringStartByApp), new Date(), app);
}

// A line chart (common.js's renderLatencyChart) scaled to whatever's
// currently in view — unlike uptime, a slower response isn't inherently
// "bad" (some self-hosted apps are just normally slower), so there's no
// invented good/bad threshold here. Hidden entirely until this app has at
// least one recorded sample.
function renderLatencyHistory(app) {
  const col = document.querySelector(`#status-cards [data-app="${app}"]`);
  if (!col) return;
  const section = col.querySelector('[data-latency-section]');
  const canvas = col.querySelector('[data-latency-history]');

  const samples = (cachedLatencyByApp[app] || []).slice(-LATENCY_HISTORY_HOURS);
  if (!samples.length) {
    section.style.visibility = 'hidden';
    return;
  }

  const labels = samples.map((s) => formatTimestamp(s.t));
  const values = samples.map((s) => s.ms);
  renderLatencyChart(canvas, labels, values, { compact: true });
  const latest = values[values.length - 1];
  col.querySelector('[data-latency-label]').textContent = `${Math.round(latest)}ms · last 24h`;
  section.style.visibility = '';
}

// formatTimestamp, formatDuration, and calculateUptimePercent now live in
// common.js (loaded before this file), shared with history.js.

function getUptimeWindow(timeframeKey, now, app) {
  const timeframe = UPTIME_TIMEFRAMES[timeframeKey];
  const start = timeframeKey === 'all'
    ? getMonitoringStart(app, cachedMonitoringStartByApp)
    : new Date(now.getTime() - timeframe.ms);
  return [start, now];
}

// Re-slices the cached full issue list by the selected count and builds
// one card per entry — closed issues get the AI-summarized card, open
// ones get the live card with a link through to history.html's Live
// Incidents section (common.js's renderClosedIncidentCard/
// renderOpenIncidentCard). count/slicing is the only status.js-specific
// piece here; see cachedRecentIssues above.
function renderRecentUpdates(count) {
  const section = document.getElementById('recent-updates');
  const entries = cachedRecentIssues.slice(0, count);

  if (!entries.length) {
    section.classList.add('d-none');
    return;
  }

  const list = document.getElementById('recent-updates-list');
  list.innerHTML = '';
  for (const entry of entries) {
    const card = entry.issue.state === 'closed'
      ? renderClosedIncidentCard(entry, cachedIssueSummaries)
      : renderOpenIncidentCard(entry, { appendComments: false, liveIncidentHref: `history#incident-${entry.issue.number}` });
    list.appendChild(card);
  }
  section.classList.remove('d-none');
}

// Skips rebuilding the cards when nothing relevant has changed since the
// last check. Two independent things can make a rebuild necessary: the
// issue list itself (state/updated_at — in which case cached comments are
// stale too and get cleared), or just cachedIssueSummaries picking up a
// summary that wasn't there yet (the issue itself hasn't changed, so
// comments don't need clearing for that alone).
function updateRecentUpdates(recentIssues) {
  const issuesFingerprint = fingerprintRecentIssues(recentIssues);
  const summariesFingerprint = JSON.stringify(cachedIssueSummaries);
  if (issuesFingerprint === cachedRecentIssuesFingerprint && summariesFingerprint === cachedIssueSummariesFingerprint) return;

  if (issuesFingerprint !== cachedRecentIssuesFingerprint) {
    issueCommentsCache.clear();
  }
  cachedRecentIssuesFingerprint = issuesFingerprint;
  cachedIssueSummariesFingerprint = summariesFingerprint;
  cachedRecentIssues = recentIssues;
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
  const [{ issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp }, latencyByApp, issueSummaries, detailsByApp] =
    await Promise.all([
      fetchAppIssues(cachedAppIds),
      fetchLatencyHistory(),
      fetchIssueSummaries(),
      Promise.all(cachedAppIds.map(fetchAppDetails)).then((list) => Object.fromEntries(cachedAppIds.map((app, i) => [app, list[i]]))),
    ]);

  cachedDownEventsByApp = downEventsByApp;
  cachedLatencyByApp = latencyByApp;
  cachedIssueSummaries = issueSummaries;

  // "Online" comes entirely from the workflow's own server-side checks (an
  // open auto-outage issue) or an announced maintenance window.
  const onlineByApp = Object.fromEntries(
    cachedAppIds.map((app) => [app, !hasOpenAutoOutage[app] && !inMaintenance[app]])
  );

  cachedAppIds.forEach((app) => {
    const online = onlineByApp[app];
    const issues = issuesByApp[app];
    setBadge(cachedCols[app], online, Boolean(issues && issues.length), Boolean(inMaintenance[app]));
    setMessage(cachedCols[app], online, issues);
    // An app's own details (see common.js fetchAppDetails) fill the message
    // line only while there's nothing more important to say there.
    const message = cachedCols[app].querySelector('[data-message]');
    if (!message.textContent) message.textContent = appDetailsText(detailsByApp[app]);
    renderUptime(app);
    renderUptimeHistory(app);
    renderLatencyHistory(app);
  });

  const state = getOverallState(cachedAppIds, hasOpenAutoOutage, inMaintenance);
  updateHeading(state);
  updateFaviconAndTitle(state);
  updateRecentUpdates(recentIssues);

  document.getElementById('last-updated').textContent = `Last updated ${formatTimestamp(new Date())}`;

  lastUpdatedAt = new Date();
  secondsUntilRefresh = REFRESH_INTERVAL_MS / 1000;
  renderLastUpdatedCountdown('header-last-updated');
}

const REFRESH_INTERVAL_MS = 60 * 1000;

// Re-fetches the page's own live common.js (cache-busted) and compares
// its VERSION_NUMBER to the one already running. Checking the live
// file itself, rather than the repo/API, means this only ever reloads
// once a new deploy is actually being served — no false positive during
// GitHub Pages' own build/propagation lag right after a push.
async function checkForNewVersion() {
  try {
    const res = await fetch(`scripts/common.js?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    const match = text.match(/const VERSION_NUMBER = '([^']+)'/);
    if (match && match[1] !== VERSION_NUMBER) {
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
  [cachedApps, cachedMonitoringStartByApp] = await Promise.all([loadApps(), fetchMonitoringStartDates()]);
  createUptimeTimeframeSelector();
  cachedCols = renderStatusCards(cachedApps);
  cachedAppIds = Object.keys(cachedApps);

  initUptimeTimeframeSelector();
  initRecentUpdates();
  startCountdownTicker('header-last-updated');

  document.getElementById('version-text').textContent = `${VERSION_NUMBER}`;

  await scheduleRefresh();
}

init();
