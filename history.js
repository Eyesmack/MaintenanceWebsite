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

function renderMonthlySummary(appNames, downEventsByApp, months, now, monitoringStart) {
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
    // monthStart is always the calendar month's 1st, but monitoring may have
    // started partway through it (true only for the oldest row) — clamp so
    // the uptime% denominator never counts pre-monitoring days as "up" time.
    // No-op for every later row, whose monthStart is already >= monitoringStart.
    const monitoredStart = new Date(Math.max(monthStart.getTime(), monitoringStart.getTime()));

    const row = document.createElement('tr');
    const monthCell = document.createElement('td');
    monthCell.textContent = getMonthLabel(year, month);
    row.appendChild(monthCell);

    for (const app of appNames) {
      const issues = downEventsByApp[app] || [];
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

function renderIncidentItem(entry) {
  const { apps, issue, isUpdate } = entry;
  const [start, end] = resolveIssueInterval(issue, new Date());

  const item = document.createElement('div');
  item.className = 'sub-card rounded p-3 mb-3';

  const titleRow = document.createElement('div');
  titleRow.className = 'd-flex justify-content-between align-items-start gap-2 mb-2';

  const title = document.createElement('span');
  title.className = 'text fw-semibold';
  title.textContent = issue.title;

  const badge = document.createElement('span');
  badge.className = `badge ${isUpdate ? 'bg-info' : 'bg-secondary'}`;
  badge.textContent = isUpdate ? 'Maintenance' : 'Incident';

  titleRow.append(title, badge);

  const affectedApps = document.createElement('p');
  affectedApps.className = 'small opacity-75 mb-1 text';
  affectedApps.textContent = `Affected Apps: ${apps.join(', ')}`;

  const timing = document.createElement('p');
  timing.className = 'small opacity-75 mb-2 text';
  timing.textContent = `${formatTimestamp(start)} — ${formatTimestamp(end)} (${formatDuration(end - start)})`;

  const link = document.createElement('a');
  link.href = issue.html_url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.className = 'small';
  link.textContent = 'View on GitHub ↗';

  item.append(titleRow, affectedApps, timing, link);
  return item;
}

// Only months with at least one closed incident get a heading — an empty
// "August 2026" section with nothing under it isn't useful, unlike the
// summary table above where an all-"No downtime" month is worth showing.
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

    for (const entry of entries) {
      container.appendChild(renderIncidentItem(entry));
    }
  }

  return hasAny;
}

async function init() {
  const apps = await loadApps();
  const appNames = Object.keys(apps);
  const { recentIssues, downEventsByApp } = await fetchAppIssues(appNames);

  const now = new Date();
  const monitoringStart = new Date(MONITORING_START_DATE);
  const months = buildMonthList(monitoringStart, now);

  renderMonthlySummary(appNames, downEventsByApp, months, now, monitoringStart);
  const hasIncidents = renderIncidentMonths(recentIssues, months);

  const status = document.getElementById('history-status');
  status.textContent = hasIncidents ? '' : 'No incidents recorded yet.';
  if (hasIncidents) status.classList.add('d-none');
}

init();
