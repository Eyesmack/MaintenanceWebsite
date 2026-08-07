// app.js — renders one app's detail page (app.html?app=<name>), driven by
// the `app` query param matched against apps.json's keys. Mirrors
// status.js's live-refresh architecture (refreshAppStatus/scheduleRefresh)
// scoped to one fixed set of elements instead of one card per app.
// Rendering is intentionally NOT shared with status.js — same "each page
// owns its rendering" convention history.js already established (see its
// renderIncidentItem vs. status.js's renderRecentUpdates). Only
// common.js's data/math layer is shared. If either copy's accordion/badge
// logic changes, update both by hand.

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

// Adapted from status.js's renderUptimeHistory (status.js:287-326): same
// per-day loop and tooltip logic, APP_UPTIME_HISTORY_DAYS instead of 30,
// targeting this page's single #app-uptime-history container directly.
function renderAppUptimeHistory(issues) {
  const container = document.getElementById('app-uptime-history');
  const monitoringStart = new Date(MONITORING_START_DATE);
  const now = new Date();

  container.innerHTML = '';
  for (let i = APP_UPTIME_HISTORY_DAYS - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    const dayEnd = new Date(Math.min(dayStart.getTime() + 24 * 60 * 60 * 1000, now.getTime()));

    const day = document.createElement('div');
    day.className = 'flex-fill rounded-1';
    day.setAttribute('data-bs-toggle', 'tooltip');

    if (dayStart < monitoringStart) {
      day.classList.add('bg-secondary');
      day.title = `${dayStart.toLocaleDateString()} — No data (before monitoring began)`;
    } else {
      const percent = calculateUptimePercent(issues, dayStart, dayEnd);
      day.classList.add(percent === 100 ? 'bg-success' : 'bg-danger');
      day.title = `${dayStart.toLocaleDateString()} — ${percent.toFixed(2)}% uptime`;
    }
    container.appendChild(day);
  }
  container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
}

// timestampText/shortTimestampText/fetchIssueComments/preloadIssueComments/
// fingerprintRecentIssues below are copied verbatim from status.js
// (status.js:371-419, 427-439, 574-621, 627-629) — zero status.js-specific
// dependencies, so a straight copy is correct as-is.

function timestampText(issue, isUpdate) {
  if (isUpdate) {
    if (issue.state === 'closed' && issue.closed_at) return `Resolved ${formatTimestamp(issue.closed_at)}`;
    const window = extractMaintenanceWindow(issue.body);
    return window ? `Expected Outage: ${formatTimestamp(window.start)}` : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  const [start, end] = resolveIssueInterval(issue, new Date());
  if (issue.state === 'closed' && issue.closed_at) {
    return `Down for ${formatDuration(end - start)} — Resolved ${formatTimestamp(end)}`;
  }
  return `Down since ${formatTimestamp(start)}`;
}

function shortTimestampText(issue, isUpdate) {
  if (isUpdate) {
    if (issue.state === 'closed' && issue.closed_at) return `Resolved ${formatTimestamp(issue.closed_at)}`;
    const window = extractMaintenanceWindow(issue.body);
    return window ? `Expected outage: ${formatTimestamp(window.start)}` : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  const [start, end] = resolveIssueInterval(issue, new Date());
  if (issue.state === 'closed' && issue.closed_at) return `Resolved ${formatTimestamp(end)}`;
  return `Down since ${formatTimestamp(start)}`;
}

const issueCommentsCache = new Map();

async function fetchIssueComments(issueNumber) {
  try {
    const res = await fetch(
      `${GITHUB_PROXY_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/issues/${issueNumber}/comments?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);
    return res.json();
  } catch (err) {
    console.warn(`Could not fetch comments for issue #${issueNumber}`, err);
    return [];
  }
}

async function preloadIssueComments(issues) {
  const accordion = document.getElementById('recent-updates-accordion');
  await Promise.all(
    issues.map(async ({ issue }) => {
      if (!issueCommentsCache.has(issue.number)) {
        issueCommentsCache.set(issue.number, await fetchIssueComments(issue.number));
      }
      const comments = issueCommentsCache.get(issue.number);
      if (!comments.length) return;

      const body = accordion.querySelector(`[data-issue-number="${issue.number}"] .accordion-body`);
      if (!body || body.querySelector('[data-comments]')) return;

      const list = document.createElement('div');
      list.dataset.comments = '';
      list.className = 'mt-2';

      const label = document.createElement('p');
      label.className = 'small opacity-75 mb-1';
      label.textContent = 'Updates:';
      list.appendChild(label);

      for (const comment of comments) {
        const wrap = document.createElement('div');
        wrap.className = 'comment-box p-2 mb-2';
        const edited = comment.updated_at !== comment.created_at;
        const meta = document.createElement('p');
        meta.className = 'small opacity-75 mb-0';
        meta.textContent = `${comment.user?.login || 'unknown'} · ${formatTimestamp(edited ? comment.updated_at : comment.created_at)}${edited ? ' (edited)' : ''}`;
        const commentBody = document.createElement('div');
        commentBody.className = 'markdown-body mb-0';
        if (comment.body_html) { commentBody.innerHTML = comment.body_html; }
        else { commentBody.textContent = comment.body; }
        wrap.append(meta, commentBody);
        list.appendChild(wrap);
      }
      body.querySelector('[data-timestamp]').before(list);
    })
  );
}

function fingerprintRecentIssues(recentIssues) {
  return recentIssues.map(({ issue }) => `${issue.number}:${issue.state}:${issue.updated_at}`).join('|');
}

// Adapted from status.js's renderRecentUpdates (status.js:441-566): takes
// the already-filtered-to-this-app issue list directly instead of slicing
// a cached list by a user-selected count (no Last-5/10 selector here —
// one app's history is short enough to show in full). Otherwise
// identical, including the expand-state capture/restore that keeps an
// open item open across the 60s refresh.
function renderAppRecentUpdates(issues) {
  const section = document.getElementById('recent-updates');
  const accordion = document.getElementById('recent-updates-accordion');

  if (!issues.length) {
    section.classList.add('d-none');
    return;
  }

  const expandedIssueNumbers = new Set(
    Array.from(accordion.querySelectorAll('.accordion-item'))
      .filter((item) => item.querySelector('.accordion-collapse')?.classList.contains('show'))
      .map((item) => item.dataset.issueNumber)
  );

  accordion.innerHTML = '';
  for (const { apps, issue, isUpdate } of issues) {
    const collapseId = `ru-collapse-${issue.number}`;

    const item = document.createElement('div');
    item.className = 'accordion-item';
    item.dataset.issueNumber = String(issue.number);

    const header = document.createElement('h2');
    header.className = 'accordion-header d-flex align-items-center';

    const button = document.createElement('button');
    button.className = 'accordion-button collapsed flex-grow-1';
    button.type = 'button';
    button.setAttribute('data-bs-toggle', 'collapse');
    button.setAttribute('data-bs-target', `#${collapseId}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', collapseId);

    const titleWrap = document.createElement('span');
    titleWrap.className = 'd-flex justify-content-between align-items-center w-100 gap-2';
    const titleText = document.createElement('span');
    titleText.append(`${issue.title} - `);
    const titleTimestamp = document.createElement('span');
    titleTimestamp.className = 'opacity-75';
    titleTimestamp.textContent = shortTimestampText(issue, isUpdate);
    titleText.appendChild(titleTimestamp);

    const stateBadge = document.createElement('span');
    if (isUpdate && issue.state === 'open') {
      stateBadge.className = 'badge bg-info me-2';
      stateBadge.textContent = 'Planned';
    } else {
      stateBadge.className = `badge me-2 ${issue.state === 'open' ? 'bg-danger' : 'bg-success'}`;
      stateBadge.textContent = issue.state === 'open' ? 'Open' : 'Resolved';
    }
    titleWrap.append(titleText, stateBadge);
    button.appendChild(titleWrap);

    const issueLink = document.createElement('a');
    issueLink.href = issue.html_url;
    issueLink.target = '_blank';
    issueLink.rel = 'noopener';
    issueLink.className = 'accordion-link-btn ms-2 me-2';
    issueLink.title = 'View on GitHub';
    issueLink.setAttribute('aria-label', 'View issue on GitHub');
    issueLink.textContent = '↗';
    header.append(button, issueLink);

    const collapse = document.createElement('div');
    collapse.id = collapseId;
    collapse.className = 'accordion-collapse collapse';

    const collapseBody = document.createElement('div');
    collapseBody.className = 'accordion-body';

    const affectedApps = document.createElement('p');
    affectedApps.className = 'small opacity-75 mb-2';
    affectedApps.textContent = `Affected Apps: ${apps.join(', ')}`;

    const description = document.createElement('div');
    description.dataset.description = '';
    description.className = 'markdown-body';
    if (issue.body_html) { description.innerHTML = issue.body_html; }
    else { description.textContent = issue.body || 'No further details provided.'; }

    const timestamp = document.createElement('p');
    timestamp.dataset.timestamp = '';
    timestamp.className = 'small opacity-75 mb-0';
    timestamp.textContent = timestampText(issue, isUpdate);

    collapseBody.append(affectedApps, description, timestamp);
    collapse.appendChild(collapseBody);

    if (expandedIssueNumbers.has(String(issue.number))) {
      button.classList.remove('collapsed');
      button.setAttribute('aria-expanded', 'true');
      collapse.classList.add('show');
    }

    item.append(header, collapse);
    accordion.appendChild(item);
  }

  section.classList.remove('d-none');
  preloadIssueComments(issues);
}

let cachedFingerprint = null;

// Adapted from status.js's updateRecentUpdates: same fingerprint-diff
// skip, so an unchanged issue set doesn't rebuild the accordion (and
// doesn't clear issueCommentsCache) on every 60s tick.
function updateAppRecentUpdates(recentIssues) {
  const fingerprint = fingerprintRecentIssues(recentIssues);
  if (fingerprint === cachedFingerprint) return;
  cachedFingerprint = fingerprint;
  issueCommentsCache.clear();
  renderAppRecentUpdates(recentIssues);
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
