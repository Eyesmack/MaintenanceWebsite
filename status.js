// Bump this by hand whenever you change status.js/index.html, so the footer
// tells you which version of the page a visitor (or you) is actually seeing.
const STATUS_PAGE_VERSION = 'v1.0.0';

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
      }
    }
  } catch (err) {
    console.warn('Could not fetch status-update issues from GitHub', err);
  }
  return { issuesByApp, recentIssues };
}

function truncate(text, max) {
  const clean = (text || '').trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}

function setBadge(col, online, hasIssue) {
  const badge = col.querySelector('[data-badge]');
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

function renderRecentUpdates(count) {
  const section = document.getElementById('recent-updates');
  const list = document.getElementById('recent-updates-list');

  if (!cachedRecentIssues.length) {
    section.classList.add('d-none');
    return;
  }

  list.innerHTML = '';
  for (const { app, issue, isUpdate } of cachedRecentIssues.slice(0, count)) {
    const item = document.createElement('div');
    item.className = 'card sub-card text-start mb-2';

    const body = document.createElement('div');
    body.className = 'card-body';

    const header = document.createElement('div');
    header.className = 'd-flex justify-content-between align-items-start gap-2';

    const title = document.createElement('h6');
    title.className = 'card-title text mb-1';
    const link = document.createElement('a');
    link.href = issue.html_url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'text';
    link.textContent = `${app}: ${issue.title}`;
    title.appendChild(link);

    const stateBadge = document.createElement('span');
    stateBadge.className = `badge ${issue.state === 'open' ? 'bg-danger' : 'bg-success'}`;
    stateBadge.textContent = issue.state === 'open' ? 'Open' : 'Resolved';

    header.append(title, stateBadge);

    const excerpt = document.createElement('p');
    excerpt.className = 'card-text text small mb-0';
    excerpt.textContent = truncate(issue.body, 200) || 'No further details provided.';

    const timestamp = document.createElement('p');
    timestamp.className = 'card-text text small mb-0 opacity-75';
    if (isUpdate) {
      // Planned/informational update: show when, never a duration — it
      // wasn't measured downtime, just a note that stayed open a while.
      timestamp.textContent = issue.state === 'closed' && issue.closed_at
        ? `Resolved ${formatTimestamp(issue.closed_at)}`
        : `Opened ${formatTimestamp(issue.created_at)}`;
    } else if (issue.state === 'closed' && issue.closed_at) {
      const duration = formatDuration(new Date(issue.closed_at) - new Date(issue.created_at));
      timestamp.textContent = `Down for ${duration} — resolved ${formatTimestamp(issue.closed_at)}`;
    } else {
      timestamp.textContent = `Down since ${formatTimestamp(issue.created_at)}`;
    }

    body.append(header, excerpt, timestamp);
    item.appendChild(body);
    list.appendChild(item);
  }

  section.classList.remove('d-none');
}

function initRecentUpdates(recentIssues) {
  cachedRecentIssues = recentIssues;
  const select = document.getElementById('recent-updates-count');
  renderRecentUpdates(Number(select.value));
  select.addEventListener('change', () => renderRecentUpdates(Number(select.value)));
}

async function init() {
  const apps = await loadApps();
  const cols = renderStatusCards(apps);
  const appNames = Object.keys(apps);

  const [reachability, { issuesByApp, recentIssues }] = await Promise.all([
    Promise.all(
      appNames.map(async (app) => {
        const online = await checkApp(apps[app]);
        return { app, online };
      })
    ),
    fetchAppIssues(appNames),
  ]);

  const onlineByApp = Object.fromEntries(reachability.map(({ app, online }) => [app, online]));

  appNames.forEach((app) => {
    const online = onlineByApp[app];
    const issues = issuesByApp[app];
    setBadge(cols[app], online, Boolean(issues && issues.length));
    setMessage(cols[app], online, issues);
  });

  updateHeading(reachability.map(({ online }) => online));
  initRecentUpdates(recentIssues);

  document.getElementById('last-updated').textContent =
    `Last updated: ${formatTimestamp(new Date())} · ${STATUS_PAGE_VERSION}`;
}

init();
