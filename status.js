// Bump this by hand whenever you change status.js/index.html, so the footer
// tells you which version of the page a visitor (or you) is actually seeing.
const STATUS_PAGE_VERSION = 'v1.16.1';

// Captured once, before status.js ever changes it, so index.html's
// <title> stays the single source of truth for the page's base title.
const BASE_TITLE = document.title;

// Matches the hex values behind Bootstrap's bg-success/bg-warning/bg-danger,
// so the favicon dot's colors stay consistent with the card badges.
const FAVICON_COLORS = { operational: '#198754', partial: '#ffc107', down: '#dc3545' };
let faviconDataUrlCache = {};

// loadApps, GITHUB_REPO, GITHUB_PROXY_BASE, MONITORING_START_DATE,
// getTimeZoneOffsetMinutes, parseZonedDateTime, extractMaintenanceWindow,
// and fetchAppIssues now live in common.js (loaded before this file),
// shared with history.js.

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
  const prefix = state === 'down' ? '🔴 ' : state === 'partial' ? '⚠️ ' : '';
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

  // Bootstrap tooltips are opt-in — each trigger element needs its own
  // instance. Its Tooltip JS takes over the `title` attribute (removing it
  // from native-tooltip duty) once initialized.
  container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => new bootstrap.Tooltip(el));
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
  // Real incidents: resolveIssueInterval prefers a declared Incident-Start
  // over raw created_at when one's present — unlike the isUpdate case
  // above, a start declared here isn't a prediction made in advance, it's
  // the true start backfilled after the fact (e.g. the outage began hours
  // before anyone got around to filing the issue), so it's more
  // trustworthy than created_at once given. The end is always closed_at/
  // "now", never a second declared value — see resolveIssueInterval.
  const [start, end] = resolveIssueInterval(issue, new Date());
  if (issue.state === 'closed' && issue.closed_at) {
    return `Down for ${formatDuration(end - start)} — Resolved ${formatTimestamp(end)}`;
  }
  return `Down since ${formatTimestamp(start)}`;
}

// A compact one-line version of timestampText for the accordion header —
// drops the duration ("Down for Xh Ym —") so it fits alongside the title
// without needing to expand the item first.
function shortTimestampText(issue, isUpdate) {
  if (isUpdate) {
    if (issue.state === 'closed' && issue.closed_at) {
      return `Resolved ${formatTimestamp(issue.closed_at)}`;
    }
    const window = extractMaintenanceWindow(issue.body);
    return window
      ? `Expected outage: ${formatTimestamp(window.start)}`
      : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  const [start, end] = resolveIssueInterval(issue, new Date());
  if (issue.state === 'closed' && issue.closed_at) {
    return `Resolved ${formatTimestamp(end)}`;
  }
  return `Down since ${formatTimestamp(start)}`;
}

// Comments are shown so the user can post live debugging updates on an
// outage issue and have them appear here as they're added, not just a
// final "closing comment". Cached per issue number so switching the
// Recent Updates count back and forth never re-fetches.
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

function renderRecentUpdates(count) {
  const section = document.getElementById('recent-updates');
  const accordion = document.getElementById('recent-updates-accordion');

  if (!cachedRecentIssues.length) {
    section.classList.add('d-none');
    return;
  }

  // Capture which items are currently expanded so the rebuild below (which
  // happens on every fingerprint change from the auto-refresh loop, not
  // just a manual count-selector change) doesn't snap them back closed —
  // e.g. someone watching a big ongoing issue for new comments shouldn't
  // have it collapse out from under them the moment one arrives.
  const expandedIssueNumbers = new Set(
    Array.from(accordion.querySelectorAll('.accordion-item'))
      .filter((item) => item.querySelector('.accordion-collapse')?.classList.contains('show'))
      .map((item) => item.dataset.issueNumber)
  );

  accordion.innerHTML = '';
  const toRender = cachedRecentIssues.slice(0, count);
  for (const { apps, issue, isUpdate } of toRender) {
    const collapseId = `ru-collapse-${issue.number}`;

    const item = document.createElement('div');
    item.className = 'accordion-item';
    item.dataset.issueNumber = String(issue.number);

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

    // A div, not a <p> — body_html can contain block-level content
    // (lists, code blocks, multiple paragraphs), which a <p> can't
    // validly hold (the parser would auto-close it around any nested
    // block element). Falls back to plain text (not innerHTML) when
    // body_html isn't present, so raw markdown source is never
    // accidentally parsed as HTML.
    const description = document.createElement('div');
    description.dataset.description = '';
    description.className = 'markdown-body';
    if (issue.body_html) {
      description.innerHTML = issue.body_html;
    } else {
      description.textContent = issue.body || 'No further details provided.';
    }

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
  preloadIssueComments(toRender);
}

// Fetches comments for every currently rendered issue (open or closed —
// a debugging update can be posted at any point, not just when closing),
// in parallel, and injects each issue's comment list as soon as it
// resolves — rather than waiting for the user to expand that item.
// issueCommentsCache dedupes across calls, so switching the Recent
// Updates count back and forth never re-fetches an issue already loaded.
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

        // A div, not a <p> — same reasoning as the description above.
        const commentBody = document.createElement('div');
        commentBody.className = 'markdown-body mb-0';
        if (comment.body_html) {
          commentBody.innerHTML = comment.body_html;
        } else {
          commentBody.textContent = comment.body;
        }

        wrap.append(meta, commentBody);
        list.appendChild(wrap);
      }

      body.querySelector('[data-timestamp]').before(list);
    })
  );
}

// Only each rendered issue's (number, state, updated_at) is compared —
// GitHub bumps updated_at on edits, closes, and new comments alike, so
// this catches "something changed" (including new comments) without a
// separate comments diff.
function fingerprintRecentIssues(recentIssues) {
  return recentIssues.map(({ issue }) => `${issue.number}:${issue.state}:${issue.updated_at}`).join('|');
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
