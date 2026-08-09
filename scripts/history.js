// Aggregates the exact same GitHub Issues data status.js already fetches
// (via fetchAppIssues in common.js) into a monthly downtime summary and a
// list of past closed incidents — no separate data source, no new fetch
// logic. See common.js for loadApps/fetchAppIssues/getDowntimeMs/etc.

function getMonthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getMonthBounds(year, monthIndex) {
  return [
    new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0)),
    new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0)),
  ];
}

function getMonthLabel(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long',
  });
}

// Every calendar month from MONITORING_START_DATE's month through the
// current month, most recent first — no cap, since a personal-project
// scale stays small even after years of monthly rows.
function buildMonthList(startDate, now) {
  const months = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  const endYear = startDate.getUTCFullYear();
  const endMonth = startDate.getUTCMonth();
  while (year > endYear || (year === endYear && month >= endMonth)) {
    months.push({ year, month });
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return months;
}

function renderMonthlySummary(appNames, downEventsByApp, months, now, monitoringStartByApp) {
  const headerRow = document.getElementById('monthly-summary-header');
  const body = document.getElementById('monthly-summary-body');

  const monthHeader = document.createElement('th');
  monthHeader.textContent = 'Month';
  headerRow.appendChild(monthHeader);
  for (const app of appNames) {
    const th = document.createElement('th');
    th.textContent = app;
    headerRow.appendChild(th);
  }

  for (const { year, month } of months) {
    const [monthStart, monthEndRaw] = getMonthBounds(year, month);
    const monthEnd = new Date(Math.min(monthEndRaw.getTime(), now.getTime()));

    const row = document.createElement('tr');
    const monthCell = document.createElement('td');
    monthCell.textContent = getMonthLabel(year, month);
    row.appendChild(monthCell);

    for (const app of appNames) {
      const issues = downEventsByApp[app] || [];
      // monthStart is always the calendar month's 1st, but this app's own
      // monitoring may have started partway through it (true only for its
      // own earliest row) — clamp per app, not once per row, since two
      // apps can have different start dates. No-op once monthStart is
      // already past that app's own start.
      const monitoringStart = getMonitoringStart(app, monitoringStartByApp);
      const monitoredStart = new Date(Math.max(monthStart.getTime(), monitoringStart.getTime()));
      const downtimeMs = getDowntimeMs(issues, monitoredStart, monthEnd);
      const percent = calculateUptimePercent(issues, monitoredStart, monthEnd);
      const cell = document.createElement('td');
      cell.textContent = downtimeMs > 0
        ? `${formatDuration(downtimeMs)} (${percent.toFixed(2)}%)`
        : `No downtime (${percent.toFixed(2)}%)`;
      row.appendChild(cell);
    }

    body.appendChild(row);
  }

  document.getElementById('monthly-summary-wrap').classList.remove('d-none');
}

// Only months with at least one closed incident get a heading — an empty
// "August 2026" section with nothing under it isn't useful, unlike the
// summary table above where an all-"No downtime" month is worth showing.
// Each month gets its own independent accordion (not one accordion
// spanning every month) — reuses common.js's renderIssueAccordion, the
// same per-issue markup/behavior (raw description + live comments) that
// index.html's/app.html's Recent Updates used to show for everything.
function renderIncidentMonths(recentIssues, months) {
  const container = document.getElementById('incident-months');

  const byMonth = {};
  for (const entry of recentIssues) {
    if (entry.issue.state !== 'closed') continue;
    const key = getMonthKey(new Date(entry.issue.created_at));
    (byMonth[key] ||= []).push(entry);
  }

  let hasAny = false;
  for (const { year, month } of months) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    const entries = byMonth[key];
    if (!entries || !entries.length) continue;
    hasAny = true;

    const heading = document.createElement('h5');
    heading.className = 'text mt-4 mb-3';
    heading.textContent = getMonthLabel(year, month);
    container.appendChild(heading);

    const accordion = document.createElement('div');
    accordion.className = 'accordion incident-accordion';
    container.appendChild(accordion);
    renderIssueAccordion(accordion, entries);
  }

  return hasAny;
}

// Currently-open incidents/maintenance windows, shown above the monthly
// archive in their own section — the full "live" card (real description +
// live-appended comments), same content depth as app.html's own open-issue
// cards. This is also what index.html's lighter teaser cards link to via
// "View Live Incident" (history#incident-<number> — see
// common.js's renderOpenIncidentCard, which sets that id).
function renderLiveIncidents(recentIssues) {
  const section = document.getElementById('live-incidents');
  const openIssues = recentIssues.filter((entry) => entry.issue.state === 'open');

  if (!openIssues.length) {
    section.classList.add('d-none');
    return;
  }

  for (const entry of openIssues) {
    section.appendChild(renderOpenIncidentCard(entry, { appendComments: true }));
  }
  section.classList.remove('d-none');
}

// Deep-linked from index.html's/app.html's "View full incident" and "View
// Live Incident" links (history#incident-<number>). The browser's native
// anchor-jump only fires once, right after the initial (still-empty) HTML
// parses — by the time this dynamically-rendered content exists, it's long
// since given up. Redone by hand once rendering is done, and additionally
// expands the target if it's a collapsed accordion item (a closed
// incident) so the reader doesn't land on a collapsed heading with nothing
// to see.
function focusIncidentFromHash() {
  if (!location.hash.startsWith('#incident-')) return;
  const target = document.getElementById(location.hash.slice(1));
  if (!target) return;

  const button = target.querySelector('.accordion-button');
  const collapse = target.querySelector('.accordion-collapse');
  if (button && collapse && !collapse.classList.contains('show')) {
    button.classList.remove('collapsed');
    button.setAttribute('aria-expanded', 'true');
    collapse.classList.add('show');
  }

  target.scrollIntoView({ block: 'start' });
}

async function init() {
  document.getElementById('version-text').textContent = VERSION_NUMBER;
  document.getElementById('version-text-top').textContent = VERSION_NUMBER;

  const apps = await loadApps();
  const appNames = Object.keys(apps);
  const [{ recentIssues, downEventsByApp }, monitoringStartByApp] =
    await Promise.all([fetchAppIssues(appNames), fetchMonitoringStartDates()]);

  const now = new Date();
  // Always the fixed global date, not per-app — this only needs to be the
  // universal earliest possible bound so the month-row range covers every
  // app's own (always-later-or-equal) start date; per-cell clamping to
  // each app's actual date happens inside renderMonthlySummary.
  const months = buildMonthList(new Date(MONITORING_START_DATE), now);

  renderMonthlySummary(appNames, downEventsByApp, months, now, monitoringStartByApp);
  renderLiveIncidents(recentIssues);
  const hasIncidents = renderIncidentMonths(recentIssues, months);

  const status = document.getElementById('history-status');
  status.textContent = hasIncidents ? '' : 'No incidents recorded yet.';
  if (hasIncidents) status.classList.add('d-none');

  focusIncidentFromHash();
}

init();
