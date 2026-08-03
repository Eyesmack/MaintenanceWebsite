// Bump this by hand whenever you change status.js/index.html, so the footer
// tells you which version of the page a visitor (or you) is actually seeing.
const STATUS_PAGE_VERSION = 'v1.4.3';

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
      const appName = appNames.find((name) => labels.includes(name.toLowerCase()));
      if (!appName) continue;

      // The "update" label marks an issue as a planned/informational note
      // rather than a real incident, so Recent Updates knows not to show a
      // downtime duration for it (a maintenance notice isn't "downtime").
      const isUpdate = labels.includes('update');
      recentIssues.push({ app: appName, issue, isUpdate });
      if (issue.state === 'open') {
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
  } catch (err) {
    console.warn('Could not fetch status-update issues from GitHub', err);
  }
  return { issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance };
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
    ? 'This service is reachable and has no known issues.'
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

  body.append(title, message);
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

function timestampText(issue, isUpdate) {
  if (isUpdate) {
    // Planned/informational update: show when, never a duration — it
    // wasn't measured downtime, just a note that stayed open a while.
    return issue.state === 'closed' && issue.closed_at
      ? `Resolved ${formatTimestamp(issue.closed_at)}`
      : `Opened ${formatTimestamp(issue.created_at)}`;
  }
  if (issue.state === 'closed' && issue.closed_at) {
    const duration = formatDuration(new Date(issue.closed_at) - new Date(issue.created_at));
    return `Down for ${duration} — resolved ${formatTimestamp(issue.closed_at)}`;
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
  for (const { app, issue, isUpdate } of cachedRecentIssues.slice(0, count)) {
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
    titleText.textContent = `${app}: ${issue.title}`;

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
    issueLink.className = 'accordion-link-btn ms-2';
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

    const description = document.createElement('p');
    description.dataset.description = '';
    description.className = 'preserve-lines';
    description.textContent = truncate(issue.body, 200) || 'No further details provided.';

    const timestamp = document.createElement('p');
    timestamp.className = 'small opacity-75 mb-0';
    timestamp.textContent = timestampText(issue, isUpdate);

    collapseBody.append(description, timestamp);
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
    resolution.textContent = `Resolution: ${truncate(comment, 300)}`;
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

  const [reachability, { issuesByApp, recentIssues, hasOpenAutoOutage, inMaintenance }] = await Promise.all([
    Promise.all(
      appNames.map(async (app) => {
        const online = await checkApp(apps[app]);
        return { app, online };
      })
    ),
    fetchAppIssues(appNames),
  ]);

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
  });

  updateHeading(appNames.map((app) => correctedOnlineByApp[app]));
  initRecentUpdates(recentIssues);

  document.getElementById('last-updated').textContent =
    `Last updated: ${formatTimestamp(new Date())} · ${STATUS_PAGE_VERSION}`;
}

init();
