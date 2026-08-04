// Bump this by hand whenever you change status.js/index.html, so the footer
// tells you which version of the page a visitor (or you) is actually seeing.
const STATUS_PAGE_VERSION = 'v1.7.3';

// App-to-URL mapping lives in apps.json, shared with the GitHub Actions
// status-check workflow so both stay in sync from one source of truth.
async function loadApps() {
  const res = await fetch('apps.json', { cache: 'no-store' });
  return res.json();
}

const CHECK_TIMEOUT_MS = 6000;

// Open issues in this repo labeled with an app key (e.g. "notflix")
// are treated as manual status updates and shown on that app's card.
const GITHUB_REPO = { owner: 'Eyesmack', repo: 'MaintenanceWebsite' };

// Set this to when you actually started using this status page — "All
// Time" uptime is measured from here, since there's no real
// monitoring-start record to derive it from automatically.
const MONITORING_START_DATE = '2026-07-01T00:00:00Z';

const UPTIME_TIMEFRAMES = {
  '24h': { label: '24 Hours', ms: 24 * 60 * 60 * 1000 },
  '7d': { label: '7 Days', ms: 7 * 24 * 60 * 60 * 1000 },
  '1m': { label: '1 Month', ms: 30 * 24 * 60 * 60 * 1000 },
  '1y': { label: '1 Year', ms: 365 * 24 * 60 * 60 * 1000 },
  all: { label: 'All Time', ms: null },
};

// The history bar's length is fixed and independent of the Uptime %
// selector above (same convention most status pages use).
var UPTIME_HISTORY_DAYS = 30;

// no-cors mode can't read the HTTP status (opaque response), so a
// resolved fetch only proves the host is reachable, not that the app
// itself is healthy. A rejected fetch (network error or our own
// timeout abort) is treated as offline.
async function checkApp(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// Converts a naive "YYYY-MM-DD HH:MM" string (meant as wall-clock time in
// `timeZone`) into the actual instant it represents, without any external
// date library. Mirrors the workflow's `TZ='Pacific/Auckland' date -d`
// logic so the client and the GitHub Action agree on what "now" means
// relative to a maintenance window.
function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUTC - date.getTime()) / 60000;
}

function parseZonedDateTime(naiveStr, timeZone) {
  const guessUTC = new Date(`${naiveStr.replace(' ', 'T')}Z`);
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, guessUTC);
  return new Date(guessUTC.getTime() - offsetMinutes * 60000);
}

// Same Maintenance-Start/Maintenance-End convention (and NZ timezone) the
// status-check workflow looks for when deciding whether to skip filing an
// outage issue. Returns null if either line is missing/unparseable.
function extractMaintenanceWindow(body) {
  const startMatch = (body || '').match(/Maintenance-Start:\s(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  const endMatch = (body || '').match(/Maintenance-End:\s(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  if (!startMatch || !endMatch) return null;
  return {
    start: parseZonedDateTime(startMatch[1], 'Pacific/Auckland'),
    end: parseZonedDateTime(endMatch[1], 'Pacific/Auckland'),
  };
}

// Only issues labeled with a known app name are matched (label match is
// case-insensitive, so "Homepage" in apps.json matches a "homepage"
// label); anything else in the repo (site bugs, feature requests, etc.)
// is ignored so it never shows up on the public page. Fetches every
// issue (open and closed) in one call: issuesByApp (open only) drives
// the per-app card badge/message, recentIssues (open+closed, already
// newest-first from the API) feeds the Recent Updates section.
// Failures here are swallowed so a GitHub API hiccup never blocks the
// reachability checks.
async function fetchAppIssues(appNames) {
  const issuesByApp = {};
  const recentIssues = [];
  const hasOpenAutoOutage = {};
  const inMaintenance = {};
  const downEventsByApp = {};
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/issues?state=all&per_page=100&sort=created&direction=desc`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);
    const issues = await res.json();
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const labels = issue.labels.map((label) =>
        (typeof label === 'string' ? label : label.name).toLowerCase()
      );
      // An issue can carry more than one app's label (e.g. a
      // whole-server maintenance notice) — match all of them, not just
      // the first, so it shows up on every affected app's card.
      const matchedApps = appNames.filter((name) => labels.includes(name.toLowerCase()));
      if (!matchedApps.length) continue;

      // The "update" label marks an issue as a planned/informational note
      // rather than a real incident, so Recent Updates knows not to show a
      // downtime duration for it (a maintenance notice isn't "downtime").
      const isUpdate = labels.includes('update');
      recentIssues.push({ apps: matchedApps, issue, isUpdate });

      // Every matched issue (open or closed, planned or not) counts as a
      // down-period for uptime% purposes — tracked unconditionally, unlike
      // issuesByApp below which is open-only and drives the live badge.
      for (const appName of matchedApps) {
        (downEventsByApp[appName] ||= []).push(issue);
      }

      if (issue.state === 'open') {
        for (const appName of matchedApps) {
          (issuesByApp[appName] ||= []).push(issue);
          if (labels.includes('auto-outage')) {
            hasOpenAutoOutage[appName] = true;
          }
          if (isUpdate) {
            const window = extractMaintenanceWindow(issue.body);
            if (window) {
              const now = new Date();
              if (now >= window.start && now <= window.end) {
                inMaintenance[appName] = true;
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not fetch status-update issues from GitHub', err);
  }
  return { issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp };
}

function truncate(text, max) {
  const clean = (text || '').trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}

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
    ? 'This service is reachable and has no known issues or planned maintenance.'
    : 'This service could not be reached. It may be down, or blocking status checks from your network.';
}

function updateHeading(onlineFlags) {
  const heading = document.getElementById('status-heading');
  const subheading = document.getElementById('status-subheading');
  const onlineCount = onlineFlags.filter(Boolean).length;

  if (onlineCount === onlineFlags.length) {
    heading.textContent = 'All Systems Operational';
    subheading.textContent = 'Everything is up and running normally.';
  } else if (onlineCount === 0) {
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
  body.className = 'card-body';

  const title = document.createElement('h5');
  title.className = 'card-title text';
  title.append(`${app} `);
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

  const uptimeSelect = document.createElement('select');
  uptimeSelect.className = 'form-select form-select-sm';
  uptimeSelect.style.width = 'auto';
  uptimeSelect.dataset.uptimeSelect = '';
  uptimeSelect.dataset.app = app;
  for (const [key, { label }] of Object.entries(UPTIME_TIMEFRAMES)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    if (key === '24h') option.selected = true;
    uptimeSelect.appendChild(option);
  }

  uptimeRow.append(uptimeText, uptimeSelect);

  const uptimeHistory = document.createElement('div');
  uptimeHistory.className = 'd-flex gap-1 mt-2';
  uptimeHistory.style.height = '18px';
  uptimeHistory.dataset.uptimeHistory = '';

  body.append(title, message, uptimeRow, uptimeHistory);
  card.appendChild(body);
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

// Caches the full (open + closed) matched issue list so the "Last 5 /
// Last 10" selector can re-render instantly without re-fetching.
let cachedRecentIssues = [];

// Per-app down-event history, cached so the uptime timeframe selector can
// recompute instantly without re-fetching.
let cachedDownEventsByApp = {};

function renderUptime(app) {
  const select = document.querySelector(`[data-uptime-select][data-app="${app}"]`);
  const text = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime]`);
  if (!select || !text) return;

  const timeframeKey = select.value;
  const { label } = UPTIME_TIMEFRAMES[timeframeKey];
  const [windowStart, windowEnd] = getUptimeWindow(timeframeKey, new Date());
  const percent = calculateUptimePercent(cachedDownEventsByApp[app] || [], windowStart, windowEnd);
  text.textContent = `${percent.toFixed(2)}% uptime (${label})`;
}

// One delegated listener for every card's uptime selector, rather than one
// per card — recomputes from the cached issue history, no re-fetch.
function initUptimeSelectors() {
  document.getElementById('status-cards').addEventListener('change', (event) => {
    if (!event.target.matches('[data-uptime-select]')) return;
    renderUptime(event.target.dataset.app);
  });
}

// Fixed-length day-by-day history strip, independent of the timeframe
// selector above — same convention as most status pages (Upptime,
// UptimeRobot, Cachet). Reuses calculateUptimePercent per day rather than
// duplicating the downtime math.
function renderUptimeHistory(app) {
  const container = document.querySelector(`#status-cards [data-app="${app}"] [data-uptime-history]`);
  if (!container) return;

  const issues = cachedDownEventsByApp[app] || [];
  const monitoringStart = new Date(MONITORING_START_DATE);
  const now = new Date();

  container.innerHTML = '';
  for (let i = UPTIME_HISTORY_DAYS - 1; i >= 0; i--) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - i);
    // Clamp today's bucket to the real current time — otherwise a still-
    // open issue (whose down-period defaults to whatever windowEnd is
    // passed in) would look like it extends all the way to midnight
    // tonight, i.e. into the future.
    const dayEnd = new Date(Math.min(dayStart.getTime() + 24 * 60 * 60 * 1000, now.getTime()));

    const day = document.createElement('div');
    day.className = 'flex-fill rounded-1';

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
}

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function getUptimeWindow(timeframeKey, now) {
  const timeframe = UPTIME_TIMEFRAMES[timeframeKey];
  const start = timeframeKey === 'all'
    ? new Date(MONITORING_START_DATE)
    : new Date(now.getTime() - timeframe.ms);
  return [start, now];
}

// Treats every issue's [created_at, closed_at || now] as a down-period,
// clips each to the window, merges overlaps (so overlapping issues never
// get double-counted), and returns the uptime percentage for that window.
function calculateUptimePercent(issues, windowStart, windowEnd) {
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return 100;

  const intervals = issues
    .map((issue) => {
      // Planned-maintenance issues get filed ahead of time — the down
      // period is the declared Maintenance-Start/End window, not when the
      // heads-up notice happened to be created. Real incidents never have
      // a parseable window, so this falls through to created_at/closed_at
      // for them exactly as before.
      const window = extractMaintenanceWindow(issue.body);
      const start = window ? window.start : new Date(issue.created_at);
      const end = window ? window.end : (issue.closed_at ? new Date(issue.closed_at) : windowEnd);
      return [Math.max(start, windowStart), Math.min(end, windowEnd)];
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  const downtimeMs = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  const uptimeMs = Math.max(0, windowMs - downtimeMs);
  return Math.min(100, (uptimeMs / windowMs) * 100);
}

function timestampText(issue, isUpdate) {
  if (isUpdate) {
    if (issue.state === 'closed' && issue.closed_at) {
      // Closed planned maintenance: this is factual completion info, not
      // a prediction, so it stays as-is.
      return `Resolved ${formatTimestamp(issue.closed_at)}`;
    }
    // Still open: show when the outage is actually expected (parsed from
    // the same Maintenance-Start convention the workflow itself uses),
    // not when this GitHub issue happened to be filed. Falls back to the
    // filing time if the body doesn't declare a parseable window.
    const window = extractMaintenanceWindow(issue.body);
    return window
      ? `Expected Outage: ${formatTimestamp(window.start)}`
      : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  if (issue.state === 'closed' && issue.closed_at) {
    const duration = formatDuration(new Date(issue.closed_at) - new Date(issue.created_at));
    return `Down for ${duration} — Resolved ${formatTimestamp(issue.closed_at)}`;
  }
  return `Down since ${formatTimestamp(issue.created_at)}`;
}

// A compact one-line version of timestampText for the accordion header —
// drops the duration ("Down for Xh Ym —") so it fits alongside the title
// without needing to expand the item first.
function shortTimestampText(issue, isUpdate) {
  if (issue.state === 'closed' && issue.closed_at) {
    return `Resolved ${formatTimestamp(issue.closed_at)}`;
  }
  if (isUpdate) {
    const window = extractMaintenanceWindow(issue.body);
    return window
      ? `Expected outage: ${formatTimestamp(window.start)}`
      : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  return `Down since ${formatTimestamp(issue.created_at)}`;
}

// A closed issue's "closing comment" isn't a distinct GitHub field — it's
// just the last comment on the issue (what the workflow posts via
// `--comment` when auto-closing an outage, or whatever's left when closing
// one by hand). Cached per issue number so re-expanding an accordion item
// never re-fetches.
const closingCommentCache = new Map();

async function fetchClosingComment(issueNumber) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/issues/${issueNumber}/comments`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);
    const comments = await res.json();
    return comments.length ? comments[comments.length - 1].body : null;
  } catch (err) {
    console.warn(`Could not fetch closing comment for issue #${issueNumber}`, err);
    return null;
  }
}

function renderRecentUpdates(count) {
  const section = document.getElementById('recent-updates');
  const accordion = document.getElementById('recent-updates-accordion');

  if (!cachedRecentIssues.length) {
    section.classList.add('d-none');
    return;
  }

  accordion.innerHTML = '';
  for (const { apps, issue, isUpdate } of cachedRecentIssues.slice(0, count)) {
    const collapseId = `ru-collapse-${issue.number}`;

    const item = document.createElement('div');
    item.className = 'accordion-item';
    item.dataset.issueNumber = String(issue.number);
    item.dataset.issueState = issue.state;

    // A flex row: the toggle button (still the only click target for
    // expand/collapse) plus a separate link icon after it. The link can't
    // live inside the button itself — nested interactive elements are
    // invalid HTML and the click would also toggle the accordion.
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
      // A closed planned-maintenance issue is just Resolved, same as any
      // other closed issue — "Planned" only makes sense while it's open.
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

    // No data-bs-parent: "Always Open" accordion — expanding one item
    // doesn't collapse the others.
    const collapse = document.createElement('div');
    collapse.id = collapseId;
    collapse.className = 'accordion-collapse collapse';

    const collapseBody = document.createElement('div');
    collapseBody.className = 'accordion-body';

    const affectedApps = document.createElement('p');
    affectedApps.className = 'small opacity-75 mb-2';
    affectedApps.textContent = `Affected Apps: ${apps.join(', ')}`;

    const description = document.createElement('p');
    description.dataset.description = '';
    description.className = 'preserve-lines';
    description.textContent = truncate(issue.body, 300) || 'No further details provided.';

    const timestamp = document.createElement('p');
    timestamp.className = 'small opacity-75 mb-0';
    timestamp.textContent = timestampText(issue, isUpdate);

    collapseBody.append(affectedApps, description, timestamp);
    collapse.appendChild(collapseBody);

    item.append(header, collapse);
    accordion.appendChild(item);
  }

  section.classList.remove('d-none');
}

// Event delegation: one listener for the whole accordion, rather than one
// per item. Fires each time any item is expanded; only fetches the closing
// comment the first time a given closed issue is opened.
function initRecentUpdatesAccordion() {
  const accordion = document.getElementById('recent-updates-accordion');
  accordion.addEventListener('shown.bs.collapse', async (event) => {
    const item = event.target.closest('.accordion-item');
    if (!item || item.dataset.issueState !== 'closed') return;

    const issueNumber = Number(item.dataset.issueNumber);
    if (!closingCommentCache.has(issueNumber)) {
      closingCommentCache.set(issueNumber, await fetchClosingComment(issueNumber));
    }
    const comment = closingCommentCache.get(issueNumber);
    if (!comment) return;

    const body = event.target.querySelector('.accordion-body');
    if (!body || body.querySelector('[data-closing-comment]')) return;

    const resolution = document.createElement('p');
    resolution.dataset.closingComment = '';
    resolution.className = 'preserve-lines';
    resolution.textContent = `Closing Comment: ${truncate(comment, 300)}`;
    body.querySelector('[data-description]').after(resolution);
  });
}

function initRecentUpdates(recentIssues) {
  cachedRecentIssues = recentIssues;
  initRecentUpdatesAccordion();
  const select = document.getElementById('recent-updates-count');
  renderRecentUpdates(Number(select.value));
  select.addEventListener('change', () => renderRecentUpdates(Number(select.value)));
}

async function init() {
  const apps = await loadApps();
  const cols = renderStatusCards(apps);
  const appNames = Object.keys(apps);

  const [reachability, { issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance, downEventsByApp }] = await Promise.all([
    Promise.all(
      appNames.map(async (app) => {
        const online = await checkApp(apps[app]);
        return { app, online };
      })
    ),
    fetchAppIssues(appNames),
  ]);

  cachedDownEventsByApp = downEventsByApp;

  const onlineByApp = Object.fromEntries(reachability.map(({ app, online }) => [app, online]));

  // A no-cors browser probe can't see HTTP error statuses (e.g. 502) — it
  // only detects total network failure. The workflow's auto-outage issue
  // (based on a real status check) closes that gap: if one's open, treat
  // the app as offline regardless of what the probe saw. An active
  // maintenance window is also factored in here (rather than just at the
  // badge level) so it correctly keeps the app out of the "All Systems
  // Operational" count too.
  const correctedOnlineByApp = Object.fromEntries(
    appNames.map((app) => [app, onlineByApp[app] && !hasOpenAutoOutage[app] && !inMaintenance[app]])
  );

  appNames.forEach((app) => {
    const online = correctedOnlineByApp[app];
    const issues = issuesByApp[app];
    setBadge(cols[app], online, Boolean(issues && issues.length), Boolean(inMaintenance[app]));
    setMessage(cols[app], online, issues);
    renderUptime(app);
    renderUptimeHistory(app);
  });

  initUptimeSelectors();
  updateHeading(appNames.map((app) => correctedOnlineByApp[app]));
  initRecentUpdates(recentIssues);

  document.getElementById('last-updated').textContent =
    `Last updated: ${formatTimestamp(new Date())} · ${STATUS_PAGE_VERSION}`;
  document.getElementById('version-text').textContent =
  `${STATUS_PAGE_VERSION}`;
}

init();
