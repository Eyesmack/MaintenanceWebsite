// Shared between index.html (status.js) and history.html (history.js) —
// GitHub Issues fetching, maintenance-window parsing, and the downtime
// math, so both pages agree on exactly the same rules rather than each
// re-implementing (and risking drifting from) this logic independently.

// App-to-URL mapping lives in apps.json, shared with the GitHub Actions
// status-check workflow so both stay in sync from one source of truth.
async function loadApps() {
  const res = await fetch('apps.json', { cache: 'no-store' });
  return res.json();
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
// happened to be created. Real incidents never have a parseable window,
// so this falls through to created_at/closed_at for them exactly as before.
function resolveIssueInterval(issue, windowEnd) {
  const window = extractMaintenanceWindow(issue.body);
  const start = window ? window.start : new Date(issue.created_at);
  const end = window ? window.end : (issue.closed_at ? new Date(issue.closed_at) : windowEnd);
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
