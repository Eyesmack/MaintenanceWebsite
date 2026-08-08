// Shared between index.html (status.js) and history.html (history.js) —
// GitHub Issues fetching, maintenance-window parsing, and the downtime
// math, so both pages agree on exactly the same rules rather than each
// re-implementing (and risking drifting from) this logic independently.

// Bumped by hand whenever status.js/app.js or their HTML changes — shown
// in both index.html's and app.html's footers, and used by status.js's
// checkForNewVersion to detect when a newer deploy is live.
const STATUS_PAGE_VERSION = 'v1.19.1';

// App-to-URL mapping lives in apps.json, shared with the GitHub Actions
// status-check workflow so both stay in sync from one source of truth.
async function loadApps() {
  const res = await fetch('apps.json', { cache: 'no-store' });
  return res.json();
}

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

// Open issues in this repo labeled with an app key (e.g. "notflix")
// are treated as manual status updates and shown on that app's card.
const GITHUB_REPO = { owner: 'Eyesmack', repo: 'MaintenanceWebsite' };

// A Cloudflare Worker (cloudflare/github-proxy-worker.js) proxies these
// GitHub API reads so they can be authenticated (5,000 req/hour instead of
// the unauthenticated 60/hour) without shipping a token to the browser —
// the Worker holds it as a secret and adds it server-side.
const GITHUB_PROXY_BASE = 'https://github-fetchissues.isaacma45.workers.dev';

// Set this to when you actually started using this status page — "All
// Time" uptime is measured from here, since there's no real
// monitoring-start record to derive it from automatically.
const MONITORING_START_DATE = '2026-07-31T00:00:00Z';

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

// Parses one "<Label>: YYYY-MM-DD HH:MM" line (NZ time) out of an issue
// body. Returns null if that line isn't present/parseable.
function extractDeclaredTimestamp(body, label) {
  const match = (body || '').match(new RegExp(`${label}:\\s(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})`));
  return match ? parseZonedDateTime(match[1], 'Pacific/Auckland') : null;
}

// Same Maintenance-Start/Maintenance-End convention the status-check
// workflow looks for when deciding whether to skip filing an outage issue.
// For a *planned* notice (the "update" label) — the window is declared
// ahead of time, before anyone knows exactly how it'll turn out — so both
// ends need to be explicit; returns null unless both lines are present.
function extractMaintenanceWindow(body) {
  const start = extractDeclaredTimestamp(body, 'Maintenance-Start');
  const end = extractDeclaredTimestamp(body, 'Maintenance-End');
  return start && end ? { start, end } : null;
}

// Incident-Start: for backdating a *real* incident's true start after the
// fact — e.g. the outage actually began hours before anyone got around to
// filing the issue. Deliberately a separate convention from Maintenance-
// Start/End (rather than reusing it) so a genuine outage's issue body
// doesn't read like a planned notice. Start-only: there's no Incident-End
// — the end is always whenever the issue actually gets closed (see
// resolveIssueInterval below), not a second declared value, so filing an
// issue for an outage you caught immediately needs no extra fields at all.
function extractIncidentStart(body) {
  return extractDeclaredTimestamp(body, 'Incident-Start');
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
      `${GITHUB_PROXY_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/issues?state=all&per_page=100&sort=created&direction=desc`,
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

// Planned-maintenance issues get filed ahead of time — the down period is
// the declared Maintenance-Start/End window, not when the heads-up notice
// happened to be created. A real incident works differently: only the
// start can be backdated (Incident-Start, if given — otherwise falls back
// to created_at); the end is always closed_at/windowEnd regardless, never
// a second declared value, since there's no Incident-End.
function resolveIssueInterval(issue, windowEnd) {
  const maintenanceWindow = extractMaintenanceWindow(issue.body);
  if (maintenanceWindow) return [maintenanceWindow.start, maintenanceWindow.end];

  const incidentStart = extractIncidentStart(issue.body);
  const start = incidentStart || new Date(issue.created_at);
  const end = issue.closed_at ? new Date(issue.closed_at) : windowEnd;
  return [start, end];
}

// Clips each issue's interval to [windowStart, windowEnd] and merges
// overlaps (so overlapping issues never get double-counted), returning
// the total downtime in that window, in milliseconds.
function getDowntimeMs(issues, windowStart, windowEnd) {
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return 0;

  const intervals = issues
    .map((issue) => {
      const [start, end] = resolveIssueInterval(issue, windowEnd);
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

  return merged.reduce((sum, [start, end]) => sum + (end - start), 0);
}

function calculateUptimePercent(issues, windowStart, windowEnd) {
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return 100;
  const uptimeMs = Math.max(0, windowMs - getDowntimeMs(issues, windowStart, windowEnd));
  return Math.min(100, (uptimeMs / windowMs) * 100);
}

// Comments are shown so the user can post live debugging updates on an
// outage issue and have them appear here as they're added, not just a
// final "closing comment". Cached per issue number, per page load (a
// fresh Map every time index.html/app.html loads this script), so
// re-rendering the same issue list — e.g. status.js's Recent Updates
// count selector switching back and forth — never re-fetches.
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

// Fetches comments for every currently rendered issue (open or closed —
// a debugging update can be posted at any point, not just when closing),
// in parallel, and injects each issue's comment list as soon as it
// resolves — rather than waiting for the user to expand that item.
// issueCommentsCache dedupes across calls. Assumes the caller's page has
// a #recent-updates-accordion with one [data-issue-number] item per
// issue (true of both index.html and app.html).
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

        // A div, not a <p> — same reasoning as the description below.
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

// Full one-line-per-state description for the expanded accordion body.
function timestampText(issue, isUpdate) {
  if (isUpdate) {
    if (issue.state === 'closed' && issue.closed_at) {
      return `Resolved ${formatTimestamp(issue.closed_at)}`;
    }
    const window = extractMaintenanceWindow(issue.body);
    return window
      ? `Expected Outage: ${formatTimestamp(window.start)}`
      : `Opened ${formatTimestamp(issue.created_at)}`;
  }
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

// Only each rendered issue's (number, state, updated_at) is compared —
// GitHub bumps updated_at on edits, closes, and new comments alike, so
// this catches "something changed" (including new comments) without a
// separate comments diff.
function fingerprintRecentIssues(recentIssues) {
  return recentIssues.map(({ issue }) => `${issue.number}:${issue.state}:${issue.updated_at}`).join('|');
}

// Builds the Recent Updates accordion for a plain list of { apps, issue,
// isUpdate } entries — no count/slicing logic here, callers pass exactly
// what should render (status.js pre-slices its cached full list by the
// selected count; app.js passes its already-filtered-to-one-app list).
// Assumes #recent-updates and #recent-updates-accordion elements exist
// (true of both index.html and app.html).
function renderIssueAccordion(issues) {
  const section = document.getElementById('recent-updates');
  const accordion = document.getElementById('recent-updates-accordion');

  if (!issues.length) {
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
  for (const { apps, issue, isUpdate } of issues) {
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
  preloadIssueComments(issues);
}

// Fixed-length day-by-day history strip shared by status.js's per-card
// history (30 days) and app.js's single-app history (90 days) — same
// convention as most status pages (Upptime, UptimeRobot, Cachet). Reuses
// calculateUptimePercent per day rather than duplicating the downtime math.
function renderUptimeStrip(container, issues, days, monitoringStart, now) {
  container.innerHTML = '';
  for (let i = days - 1; i >= 0; i--) {
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

// Shared Chart.js line-chart renderer for response-time data — status.js's
// per-card mini chart and app.js's full 90-day chart both call this so they
// render with the same visual language despite different data windows/
// granularity. Destroys any previous chart on the same canvas first —
// Chart.js throws "Canvas is already in use" if a second instance is
// constructed over an old one without disposing it first, which the 60s
// refresh loop in both callers would otherwise hit on every tick.
const latencyChartInstances = new WeakMap();

function renderLatencyChart(canvas, labels, values, { compact }) {
  latencyChartInstances.get(canvas)?.destroy();

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#0dcaf0',
        backgroundColor: 'rgba(13, 202, 240, 0.15)',
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: compact ? 0 : 3,
        borderWidth: compact ? 1.5 : 2,
        spanGaps: false, // a day/hour with no sample is a real gap, not 0ms
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${Math.round(ctx.parsed.y)}ms` } },
      },
      scales: {
        x: {
          display: !compact,
          grid: { color: 'rgba(255, 255, 255, 0.08)' },
          ticks: { color: '#6a7585', maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
        },
        // display stays true even when compact — the compact chart still
        // wants 2 dashed reference gridlines (top + middle), just no
        // visible axis border/tick labels. beginAtZero + ticks.count:3
        // produces exactly 3 evenly-spaced ticks (bottom/middle/top); the
        // bottom one (index 0) is made transparent below so only the
        // middle and top lines actually show.
        y: {
          display: true,
          beginAtZero: true,
          border: { display: !compact },
          grid: {
            display: true,
            color: compact
              ? (ctx) => (ctx.index === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.25)')
              : 'rgba(255, 255, 255, 0.08)',
            borderDash: compact ? [4, 4] : undefined,
          },
          ticks: {
            display: !compact,
            count: compact ? 3 : undefined,
            color: '#6a7585',
            callback: (v) => `${v}ms`,
          },
        },
      },
    },
  });

  latencyChartInstances.set(canvas, chart);
  return chart;
}

// Forces 12-hour am/pm regardless of the visitor's locale default (some
// locales default to 24-hour time) — the exact "10:57 pm" format was
// specifically requested. Shared by status.js's header countdown and
// app.js's — same live "Last updated X | Next update in Y sec." indicator,
// just rendered into a different element per page.
function formatShortTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}

let lastUpdatedAt = null; // Date of the most recent successful refresh
let secondsUntilRefresh = 0; // reset by each page's own refresh function

function renderLastUpdatedCountdown(elementId) {
  if (!lastUpdatedAt) return;
  const secondsText = String(secondsUntilRefresh).padStart(2, '0');
  document.getElementById(elementId).textContent =
    `Last updated ${formatShortTime(lastUpdatedAt)} | Next update in ${secondsText} sec.`;
}

// Named (not an inline arrow in setInterval) so it's independently
// callable from a test without waiting on a real timer.
function tickCountdown(elementId) {
  secondsUntilRefresh = Math.max(0, secondsUntilRefresh - 1);
  renderLastUpdatedCountdown(elementId);
}

// Ticks every second independent of each page's own 60s refresh cycle —
// reset to REFRESH_INTERVAL_MS/1000 happens in that page's own refresh
// function, right when a new refresh completes, so the visual countdown
// and the real timer stay anchored to the same instant rather than
// drifting apart over many cycles.
function startCountdownTicker(elementId) {
  setInterval(() => tickCountdown(elementId), 1000);
}
