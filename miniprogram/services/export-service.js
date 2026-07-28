const { formatDateTime } = require('../domain/time');

function escapeCsv(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportJson(database) {
  return JSON.stringify(database, null, 2);
}

function exportLogsCsv(database) {
  const header = [
    'id', 'startedAt', 'endedAt', 'durationMinutes', 'status', 'source',
    'categoryName', 'projectName', 'taskName', 'calendarEventSummary', 'note', 'tags'
  ];
  const rows = database.timeLogs.map((log) => [
    log.id,
    formatDateTime(log.startedAt),
    formatDateTime(log.endedAt),
    log.durationMinutes,
    log.status,
    log.source,
    log.categoryNameSnapshot,
    log.projectNameSnapshot,
    log.taskNameSnapshot,
    log.calendarEventSummarySnapshot,
    log.note,
    (log.tags || []).join('|')
  ].map(escapeCsv).join(','));
  return `\uFEFF${header.join(',')}\n${rows.join('\n')}`;
}

module.exports = {
  exportJson,
  exportLogsCsv
};
