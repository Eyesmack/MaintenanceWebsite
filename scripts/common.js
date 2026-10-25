// Shared between index.html (status.js) and history.html (history.js) —
// GitHub Issues fetching, maintenance-window parsing, and the downtime
// math, so both pages agree on exactly the same rules rather than each
// re-implementing (and risking drifting from) this logic independently.

// Bumped by hand whenever status.js/app.js or their HTML changes — shown
// in both index.html's and app.html's footers, and used by status.js's
// checkForNewVersion to detect when a newer deploy is live.
const VERSION_NUMBER = 'v2.1.0';

// apps.json ({ "<id>": { name, url } }) is shared with the GitHub Actions
// status-check workflow so both stay in sync from one source of truth. The
// id is an app's permanent identity — its GitHub label, and its key in
// every data/*.json file and in app.html?app=<id> — so name and url can be
// edited freely without losing history. Everything here passes ids around;
// getAppName turns one into its display name only at render time.
let appsById = {};

async function loadApps() {
  const res = await fetch(`data/apps.json?v=${Date.now()}`, { cache: 'no-store' });
  appsById = await res.json();
  return appsById;
}

function getAppName(id) {
  return appsById[id]?.name || id;
}

// latency-history.json is committed by the workflow (see status-check.yml)
// once an hour — a plain same-origin static file, like apps.json, so this
// needs no Cloudflare Worker/GitHub API involvement and no rate-limit use.
async function fetchLatencyHistory() {
  try {
    const res = await fetch(`data/latency-history.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// An app can name a small JSON status API of its own in apps.json
// ("statusApi" — so far only the blog: { release, realtime: "up"|"down" },
// see the blog's api/v1/status.php). Fetched straight from the browser
// (that endpoint allows this origin); null on any failure, so callers
// simply show nothing extra.
async function fetchAppDetails(app) {
  const url = appsById[app]?.statusApi;
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// One line for an app's extra details, e.g. "Release v.2610.15.2 · Realtime
// up", or '' when there's nothing to say.
function appDetailsText(details) {
  if (!details) return '';
  const parts = [];
  if (details.release) parts.push(`Release ${details.release}`);
  if (details.realtime) parts.push(`Realtime ${details.realtime}`);
  return parts.join(' · ');
}

// monitoring-start.json is committed by the workflow (see status-check.yml)
// the first time it ever sees a given app id in apps.json — same
// same-origin static-file pattern as fetchLatencyHistory, no GitHub API/
// rate-limit involvement.
async function fetchMonitoringStartDates() {
  try {
    const res = await fetch(`data/monitoring-start.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Falls back to the global MONITORING_START_DATE for any app without its
// own recorded date — covers a fetch failure, and (pre-seeded exception
// aside) is the safe default for any app this file doesn't yet know about.
function getMonitoringStart(app, monitoringStartByApp) {
  const iso = monitoringStartByApp[app];
  return iso ? new Date(iso) : new Date(MONITORING_START_DATE);
}

// issue-summaries.json is committed by the summarize-incident.yml workflow
// whenever an app-labeled issue closes — same same-origin static-file
// pattern as the other data/*.json fetches, no GitHub API involvement.
async function fetchIssueSummaries() {
  try {
    const res = await fetch(`data/issue-summaries.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Open issues in this repo labeled with an app id (e.g. "io5bwbp0")
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
// body. Returns null if that line isn't present/parseable. `label` is
// escaped before building the RegExp — a no-op for the fixed-string labels
// below, but this is also called with a dynamic per-app label
// (`Recovered-<app id>`, see resolveIssueInterval), and app ids are
// user-editable via apps.json.
function extractDeclaredTimestamp(body, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = (body || '').match(new RegExp(`${escapedLabel}:\\s(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})`));
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

// The issues endpoint caps a page at 100, and uptime ("All Time", the
// monthly history table) needs every issue ever filed, not just the newest
// 100 — so keep paging until a short page. MAX_ISSUE_PAGES only bounds a
// runaway (e.g. another flood of auto-outage issues); each page is one
// request against the proxy's shared rate limit, per viewer, per refresh.
const MAX_ISSUE_PAGES = 10;

async function fetchAllIssues() {
  const issues = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const res = await fetch(
      `${GITHUB_PROXY_BASE}/repos/${GITHUB_REPO.owner}/${GITHUB_REPO.repo}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!res.ok) throw new Error(`GitHub API responded with ${res.status}`);
    const pageIssues = await res.json();
    issues.push(...pageIssues);
    if (pageIssues.length < 100) break;
  }
  return issues;
}

// Only issues labeled with a known app id are matched (case-insensitive,
// though ids are always lowercase); anything else in the repo (site bugs,
// feature requests, etc.) is ignored so it never shows up on the public
// page. Fetches every issue (open and closed): issuesByApp (open only)
// drives the per-app card badge/message, recentIssues (open+closed,
// already newest-first from the API) feeds the Recent Updates section.
// Every returned map is keyed by app id, and recentIssues' `apps` are ids.
// Failures here are swallowed so a GitHub API hiccup never blocks the
// reachability checks.
async function fetchAppIssues(appIds) {
  const issuesByApp = {};
  const recentIssues = [];
  const hasOpenAutoOutage = {};
  const inMaintenance = {};
  const downEventsByApp = {};
  try {
    const issues = await fetchAllIssues();
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const labels = issue.labels.map((label) =>
        (typeof label === 'string' ? label : label.name).toLowerCase()
      );
      // An issue can carry more than one app's label (e.g. a
      // whole-server maintenance notice) — match all of them, not just
      // the first, so it shows up on every affected app's card.
      const matchedApps = appIds.filter((id) => labels.includes(id.toLowerCase()));
      if (!matchedApps.length) continue;

      // The "update" label marks an issue as a planned/informational note
      // rather than a real incident, so Recent Updates knows not to show a
      // downtime duration for it (a maintenance notice isn't "downtime").
      const isUpdate = labels.includes('update');
      recentIssues.push({ apps: matchedApps, issue, isUpdate });

      // Every matched issue (open or closed, planned or not) counts as a
      // down-period for uptime% purposes — tracked unconditionally, unlike
      // issuesByApp below which is open-only and drives the live badge.
      for (const appId of matchedApps) {
        (downEventsByApp[appId] ||= []).push(issue);
      }

      if (issue.state === 'open') {
        for (const appId of matchedApps) {
          // An app can individually recover while a shared incident issue
          // stays open for other still-down apps (see status-check.yml's
          // Recovered-<label> body marker, and resolveIssueInterval's
          // comment) — such an app is no longer live-down even though the
          // issue and its label remain attached (permanently, so
          // downEventsByApp above still correctly attributes the
          // historical downtime to it).
          const recovered = extractDeclaredTimestamp(issue.body, `Recovered-${appId.toLowerCase()}`);
          if (recovered) continue;

          (issuesByApp[appId] ||= []).push(issue);
          if (labels.includes('auto-outage')) {
            hasOpenAutoOutage[appId] = true;
          }
          if (isUpdate) {
            const window = extractMaintenanceWindow(issue.body);
            if (window) {
              const now = new Date();
              if (now >= window.start && now <= window.end) {
                inMaintenance[appId] = true;
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
// to created_at); the end is always closed_at/windowEnd, UNLESS `appLabel`
// is given and status-check.yml has recorded that specific app's own
// earlier recovery (a `Recovered-<label>` body line — see status-check.yml
// for why: a combined multi-app issue can have some of its apps recover
// before others, and each app's own downtime needs to stop counting at
// its own recovery time, not whenever the last app finally closes the
// whole issue). `appLabel` is optional and omitted by every caller that
// just wants the overall issue interval (card/accordion rendering) —
// existing behavior there is untouched.
function resolveIssueInterval(issue, windowEnd, appLabel) {
  const maintenanceWindow = extractMaintenanceWindow(issue.body);
  if (maintenanceWindow) return [maintenanceWindow.start, maintenanceWindow.end];

  const incidentStart = extractIncidentStart(issue.body);
  const start = incidentStart || new Date(issue.created_at);

  const recoveredAt = appLabel && extractDeclaredTimestamp(issue.body, `Recovered-${appLabel.toLowerCase()}`);
  const end = recoveredAt || (issue.closed_at ? new Date(issue.closed_at) : windowEnd);
  return [start, end];
}

// Clips each issue's interval to [windowStart, windowEnd] and merges
// overlaps (so overlapping issues never get double-counted), returning
// the total downtime in that window, in milliseconds. `appLabel` (optional)
// is threaded through to resolveIssueInterval — see its comment.
function getDowntimeMs(issues, windowStart, windowEnd, appLabel) {
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return 0;

  const intervals = issues
    .map((issue) => {
      const [start, end] = resolveIssueInterval(issue, windowEnd, appLabel);
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

function calculateUptimePercent(issues, windowStart, windowEnd, appLabel) {
  const windowMs = windowEnd - windowStart;
  if (windowMs <= 0) return 100;
  const uptimeMs = Math.max(0, windowMs - getDowntimeMs(issues, windowStart, windowEnd, appLabel));
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
// issueCommentsCache dedupes across calls. `container` just needs one
// [data-issue-number] item per issue with a nested .incident-body — true
// of both the accordion's collapse-body (history.js's per-month accordions)
// and the flat always-expanded open-incident card (renderOpenIncidentCard).
async function preloadIssueComments(container, issues) {
  await Promise.all(
    issues.map(async ({ issue }) => {
      if (!issueCommentsCache.has(issue.number)) {
        issueCommentsCache.set(issue.number, await fetchIssueComments(issue.number));
      }
      const comments = issueCommentsCache.get(issue.number);
      if (!comments.length) return;

      const body = container.querySelector(`[data-issue-number="${issue.number}"] .incident-body`);
      if (!body || body.querySelector('[data-comments]')) return;

      const list = document.createElement('div');
      list.dataset.comments = '';
      list.className = 'st-updates';

      const label = document.createElement('p');
      label.className = 'st-label';
      label.textContent = `Updates (${comments.length})`;
      list.appendChild(label);

      for (const comment of comments) {
        const wrap = document.createElement('div');
        wrap.className = 'st-update';

        const edited = comment.updated_at !== comment.created_at;
        const meta = document.createElement('p');
        meta.className = 'st-update-meta';
        meta.textContent = `${comment.user?.login || 'unknown'} · ${formatTimestamp(edited ? comment.updated_at : comment.created_at)}${edited ? ' (edited)' : ''}`;

        // A div, not a <p> — same reasoning as the description below.
        const commentBody = document.createElement('div');
        commentBody.className = 'markdown-body';
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

// Small DOM helper for the renderers below — `el('span', 'st-chip', 'Open')`.
// textContent only, never innerHTML, so issue titles etc. are always inert.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A state chip (style.css's .st-chip, coloured by data-state).
function stateChip(state, text) {
  const chip = el('span', 'st-chip', text);
  chip.dataset.state = state;
  return chip;
}

// What kind of entry this is, as [data-state, label]: planned maintenance
// reads in the accent colour, a real incident in red.
function eventKind(isUpdate) {
  return isUpdate ? ['maintenance', 'Maintenance'] : ['down', 'Incident'];
}

// An open entry's live state, as [data-state, label]. A planned notice is
// "In progress" only while now is inside its declared window, "Scheduled"
// before it, and plain "Planned" when it declares no window at all.
function openEventState(issue, isUpdate) {
  if (!isUpdate) return ['down', 'Ongoing'];
  const window = extractMaintenanceWindow(issue.body);
  if (!window) return ['maintenance', 'Planned'];
  const now = new Date();
  if (now < window.start) return ['maintenance', 'Scheduled'];
  if (now <= window.end) return ['maintenance', 'In progress'];
  return ['maintenance', 'Overrunning'];
}

// The affected apps as small pills.
function renderAppPills(apps) {
  const list = el('ul', 'st-event-apps');
  list.setAttribute('aria-label', 'Affected services');
  for (const app of apps) list.appendChild(el('li', '', getAppName(app)));
  return list;
}

function githubLink(issue) {
  const link = el('a', '', 'View on GitHub ↗');
  link.href = issue.html_url;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

// Builds an accordion of { apps, issue, isUpdate } entries into the given
// container — no count/slicing/empty-check logic here, callers pass
// exactly what should render and skip calling this at all when there's
// nothing to show (history.js's per-month loop only ever calls this for
// months that already have ≥1 entry). Callers can invoke this multiple
// times against different containers in the same page load (one per
// month) — each call only touches its own `accordion` element. Keeps
// Bootstrap's accordion classes (collapse JS, plus history.js's deep-link
// expand and the open-state capture below depend on them); style.css
// replaces their look.
function renderIssueAccordion(accordion, issues, summariesByIssue) {
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

    const item = el('div', 'accordion-item');
    item.id = `incident-${issue.number}`;
    item.dataset.issueNumber = String(issue.number);

    // The toggle button and the GitHub link sit side by side — the link
    // can't live inside the button (nested interactive elements are
    // invalid HTML, and the click would also toggle the accordion).
    const header = el('h3', 'accordion-header');

    const button = el('button', 'accordion-button collapsed');
    button.type = 'button';
    button.setAttribute('data-bs-toggle', 'collapse');
    button.setAttribute('data-bs-target', `#${collapseId}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', collapseId);

    // A closed planned-maintenance issue still reads as Maintenance — the
    // kind of entry matters more in the archive than its (always
    // resolved) state; an open one shows its live state instead.
    const [chipState, chipText] = issue.state === 'open' ? openEventState(issue, isUpdate) : eventKind(isUpdate);
    button.append(
      stateChip(chipState, chipText),
      el('span', 'st-acc-title', issue.title),
      el('span', 'st-acc-time', shortTimestampText(issue, isUpdate))
    );

    const issueLink = el('a', 'st-acc-link', '↗');
    issueLink.href = issue.html_url;
    issueLink.target = '_blank';
    issueLink.rel = 'noopener';
    issueLink.title = 'View on GitHub';
    issueLink.setAttribute('aria-label', 'View issue on GitHub');

    header.append(button, issueLink);

    // No data-bs-parent: "Always Open" accordion — expanding one item
    // doesn't collapse the others.
    const collapse = el('div', 'accordion-collapse collapse');
    collapse.id = collapseId;

    const collapseBody = el('div', 'accordion-body incident-body');

    // A div, not a <p> — body_html can contain block-level content
    // (lists, code blocks, multiple paragraphs), which a <p> can't
    // validly hold (the parser would auto-close it around any nested
    // block element). Falls back to plain text (not innerHTML) when
    // body_html isn't present, so raw markdown source is never
    // accidentally parsed as HTML.
    const description = el('div', 'markdown-body mb-3');
    description.dataset.description = '';
    if (issue.body_html) {
      description.innerHTML = issue.body_html;
    } else {
      description.textContent = issue.body || 'No further details provided.';
    }

    const timestamp = el('p', 'st-muted small mb-0', timestampText(issue, isUpdate));
    timestamp.dataset.timestamp = '';

    collapseBody.append(
      renderAppPills(apps),
      el('p', 'st-label', 'Summary'),
      el('p', 'st-event-text', summariesByIssue[issue.number] || 'Summary pending…'),
      el('hr', 'st-divider'),
      el('p', 'st-label', 'Original notice'),
      description,
      timestamp
    );
    collapse.appendChild(collapseBody);

    if (expandedIssueNumbers.has(String(issue.number))) {
      button.classList.remove('collapsed');
      button.setAttribute('aria-expanded', 'true');
      collapse.classList.add('show');
    }

    item.append(header, collapse);
    accordion.appendChild(item);
  }

  preloadIssueComments(accordion, issues);
}

// Timeline entry for a resolved incident/maintenance entry — used
// everywhere a closed issue is shown (index.html's and app.html's event
// lists). Shows the AI-generated summary (from issue-summaries.json, see
// fetchIssueSummaries) in place of the raw GitHub body — a resolved
// issue's story is short and settled, so there's no need for the reader
// to expand anything.
function renderClosedIncidentCard(entry, summariesByIssue) {
  const { apps, issue, isUpdate } = entry;
  const [start, end] = resolveIssueInterval(issue, new Date());
  const [kindState, kindText] = eventKind(isUpdate);

  const item = el('article', 'st-event');
  item.dataset.state = kindState;

  // Links to this incident's entry in its month's accordion on
  // history.html (see renderIssueAccordion's matching item.id).
  const historyHref = `history#incident-${issue.number}`;

  const head = el('div', 'st-event-head');
  head.append(stateChip(kindState, kindText), stateChip('up', 'Resolved'), el('span', 'st-event-time', formatTimestamp(start)));

  const title = el('a', 'st-event-title', issue.title);
  title.href = historyHref;

  // A closed issue this feature shipped after (or one Workers AI hasn't
  // gotten to yet — the summarize-incident.yml run lands within seconds
  // of closing, but isn't instant) has no summary yet; say so rather than
  // showing nothing.
  const summary = el('p', 'st-event-text', summariesByIssue[issue.number] || 'Summary pending…');

  const foot = el('div', 'st-event-foot');
  const duration = el('span', 'st-event-duration', `${isUpdate ? 'Lasted' : 'Down for'} ${formatDuration(end - start)} · ended ${formatTimestamp(end)}`);
  const fullIncidentLink = el('a', '', 'Full incident');
  fullIncidentLink.href = historyHref;
  foot.append(duration, fullIncidentLink, githubLink(issue));

  item.append(head, title, summary, renderAppPills(apps), foot);
  return item;
}

// Timeline entry for an open/ongoing entry — everything an accordion item
// would show, minus the click-to-expand, since an ongoing incident is
// exactly the thing a visitor doesn't want to have to dig for.
// `appendComments` controls whether live-appended comments are fetched in
// (app.html, history.html's live section — the "real" views);
// `liveIncidentHref`, when given instead, adds a link to that fuller view
// (index.html's lighter teaser, pointing at history.html).
// `item.id`/`dataset.issueNumber` are set unconditionally — unused when
// nothing links here, load-bearing when index.html's link needs an anchor
// to scroll to, and when preloadIssueComments needs to find this entry by
// issue number.
function renderOpenIncidentCard(entry, { appendComments, liveIncidentHref }) {
  const { apps, issue, isUpdate } = entry;
  const [kindState, kindText] = eventKind(isUpdate);
  const [liveState, liveText] = openEventState(issue, isUpdate);

  const item = el('article', 'st-event is-live');
  item.dataset.state = liveState;
  item.id = `incident-${issue.number}`;
  item.dataset.issueNumber = String(issue.number);

  const head = el('div', 'st-event-head');
  head.append(stateChip(kindState, kindText), stateChip(liveState, liveText));

  const body = el('div', 'incident-body');

  const description = el('div', 'markdown-body mb-3');
  if (issue.body_html) {
    description.innerHTML = issue.body_html;
  } else {
    description.textContent = issue.body || 'No further details provided.';
  }

  // A lightweight comment *count*, shown only where the real comments
  // themselves aren't (index.html's teaser, appendComments: false) —
  // reuses `issue.comments`, a count GitHub's issues-list API already
  // returns on every issue, so this needs no extra fetch.
  const extras = [];
  if (!appendComments && issue.comments > 0) {
    extras.push(el('p', 'st-count', `${issue.comments} update${issue.comments === 1 ? '' : 's'} posted`));
  }

  const timestamp = el('p', 'st-muted small mb-0', timestampText(issue, isUpdate));
  timestamp.dataset.timestamp = '';

  body.append(renderAppPills(apps), description, ...extras, timestamp);

  const foot = el('div', 'st-event-foot mt-3');
  foot.appendChild(el('span', 'st-event-duration'));
  if (liveIncidentHref) {
    const liveLink = el('a', '', 'Follow live updates');
    liveLink.href = liveIncidentHref;
    foot.appendChild(liveLink);
  }
  foot.appendChild(githubLink(issue));

  item.append(head, el('span', 'st-event-title', issue.title), body, foot);

  if (appendComments) preloadIssueComments(item, [entry]);

  return item;
}

// Fixed-length day-by-day history strip shared by status.js's per-service
// history (30 days) and app.js's single-app history (90 days) — same
// convention as most status pages (Upptime, UptimeRobot, Cachet). Reuses
// calculateUptimePercent/getDowntimeMs per day rather than duplicating the
// downtime math. `appLabel` (optional) is threaded through — see
// resolveIssueInterval's comment for why a per-app label matters here.
// A full day is green; any downtime turns it amber (≥99%) or red (<99%).
function renderUptimeStrip(container, issues, days, monitoringStart, now, appLabel) {
  // Dispose the previous cycle's tooltips first — a tooltip left showing on
  // a bar that gets removed would otherwise stay stuck on screen.
  container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((bar) => bootstrap.Tooltip.getInstance(bar)?.dispose());
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
    const dayLabel = dayStart.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    const day = el('div', 'st-bar');
    day.setAttribute('data-bs-toggle', 'tooltip');

    if (dayStart < monitoringStart) {
      day.classList.add('is-none');
      day.title = `${dayLabel} · No data (before monitoring began)`;
    } else {
      const percent = calculateUptimePercent(issues, dayStart, dayEnd, appLabel);
      if (percent < 100) day.classList.add(percent >= 99 ? 'is-minor' : 'is-major');
      const downtimeMs = getDowntimeMs(issues, dayStart, dayEnd, appLabel);
      day.title = downtimeMs > 0
        ? `${dayLabel} · ${percent.toFixed(2)}% uptime · ${formatDuration(downtimeMs)} down`
        : `${dayLabel} · No downtime`;
    }

    container.appendChild(day);
  }

  // Bootstrap tooltips are opt-in — each trigger element needs its own
  // instance. Its Tooltip JS takes over the `title` attribute (removing it
  // from native-tooltip duty) once initialized.
  container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((bar) => new bootstrap.Tooltip(bar));
}

// Shared Chart.js line-chart renderer for response-time data — status.js's
// per-service sparkline and app.js's full 90-day chart both call this so
// they render with the same visual language despite different data
// windows/granularity. Destroys any previous chart on the same canvas
// first — Chart.js throws "Canvas is already in use" if a second instance
// is constructed over an old one without disposing it first, which the
// 60s refresh loop in both callers would otherwise hit on every tick.
const latencyChartInstances = new WeakMap();

// The blog's accent and muted text colours (style.css's --blog-accent and
// --st-muted) — Chart.js draws on a canvas, so it can't read CSS vars.
const CHART_ACCENT = '#288ef9';
const CHART_MUTED = '#8b97a8';

// The overview's sparklines are only ~36px tall, too short for Chart.js's
// own canvas-drawn tooltip (it gets clipped at the canvas edge) — so they
// use one shared HTML tooltip instead, positioned over the page.
let sparkTooltipEl = null;

function sparkTooltip({ chart, tooltip }) {
  if (!sparkTooltipEl) {
    sparkTooltipEl = el('div', 'st-chart-tip');
    sparkTooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(sparkTooltipEl);
  }
  if (tooltip.opacity === 0) {
    sparkTooltipEl.classList.remove('is-visible');
    return;
  }

  sparkTooltipEl.replaceChildren(
    el('div', 'st-chart-tip-title', tooltip.title.join(' ')),
    el('div', 'st-chart-tip-body', tooltip.body.flatMap((b) => b.lines).join(' '))
  );

  // Centre above the hovered point, kept inside the viewport.
  const rect = chart.canvas.getBoundingClientRect();
  const tipWidth = sparkTooltipEl.offsetWidth;
  const x = Math.min(Math.max(rect.left + tooltip.caretX - tipWidth / 2, 8), window.innerWidth - tipWidth - 8);
  sparkTooltipEl.style.left = `${x}px`;
  sparkTooltipEl.style.top = `${rect.top + tooltip.caretY - sparkTooltipEl.offsetHeight - 10}px`;
  sparkTooltipEl.classList.add('is-visible');
}

// A page scroll leaves a fixed-position tooltip behind its point — hide it.
window.addEventListener('scroll', () => sparkTooltipEl?.classList.remove('is-visible'), { passive: true });

function renderLatencyChart(canvas, labels, values, { compact }) {
  latencyChartInstances.get(canvas)?.destroy();

  const fill = canvas.getContext('2d').createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 200);
  fill.addColorStop(0, 'rgba(40, 142, 249, 0.28)');
  fill.addColorStop(1, 'rgba(40, 142, 249, 0)');

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: CHART_ACCENT,
        backgroundColor: fill,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: compact ? 2 : 4,
        pointHoverBackgroundColor: CHART_ACCENT,
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
        tooltip: {
          enabled: !compact,
          external: compact ? sparkTooltip : undefined,
          backgroundColor: '#141b29',
          borderColor: 'rgba(255, 255, 255, 0.14)',
          borderWidth: 1,
          titleColor: '#e2eef6',
          bodyColor: '#cbd5e1',
          displayColors: false,
          padding: 8,
          callbacks: { label: (ctx) => `${Math.round(ctx.parsed.y)}ms` },
        },
      },
      scales: {
        x: {
          display: !compact,
          grid: { display: false },
          border: { color: 'rgba(255, 255, 255, 0.1)' },
          ticks: { color: CHART_MUTED, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 },
        },
        y: {
          display: !compact,
          beginAtZero: true,
          border: { display: false },
          grid: { color: 'rgba(255, 255, 255, 0.06)' },
          ticks: { color: CHART_MUTED, maxTicksLimit: 5, callback: (v) => `${v}ms` },
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
    `Updated ${formatShortTime(lastUpdatedAt)} · next check in ${secondsText}s`;
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
