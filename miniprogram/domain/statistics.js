const { LOG_STATUS } = require('./constants');
const { overlapMinutes } = require('./time');

function isWithinRange(item, rangeStart, rangeEnd) {
  return item.endedAt >= rangeStart && item.startedAt <= rangeEnd;
}

function includedLogs(database, rangeStart, rangeEnd, includeCandidates) {
  return database.timeLogs.filter((log) => {
    const includedStatus = log.status === LOG_STATUS.CONFIRMED || (includeCandidates && log.status === LOG_STATUS.CANDIDATE);
    return includedStatus && isWithinRange(log, rangeStart, rangeEnd);
  });
}

function accumulate(logs, idField, nameField, uncategorizedName) {
  const groups = new Map();
  logs.forEach((log) => {
    const id = log[idField] || 'unassigned';
    const name = log[nameField] || uncategorizedName;
    const current = groups.get(id) || { id, name, durationMinutes: 0, count: 0 };
    current.durationMinutes += log.durationMinutes;
    current.count += 1;
    groups.set(id, current);
  });
  return Array.from(groups.values()).sort((first, second) => second.durationMinutes - first.durationMinutes);
}

function calculatePlanVariance(database, logs, rangeStart, rangeEnd) {
  const logByEvent = new Map();
  logs.forEach((log) => {
    if (!log.calendarEventId) {
      return;
    }
    logByEvent.set(log.calendarEventId, (logByEvent.get(log.calendarEventId) || 0) + log.durationMinutes);
  });
  const events = database.calendarEvents
    .filter((event) => isWithinRange(event, rangeStart, rangeEnd))
    .map((event) => {
      const plannedMinutes = Math.round((event.endedAt - event.startedAt) / (60 * 1000));
      const actualMinutes = logByEvent.get(event.id) || 0;
      return {
        eventId: event.id,
        title: event.title,
        plannedMinutes,
        actualMinutes,
        varianceMinutes: actualMinutes - plannedMinutes
      };
    });
  const nonPlannedMinutes = logs
    .filter((log) => !log.calendarEventId)
    .reduce((total, log) => total + log.durationMinutes, 0);
  return { events, nonPlannedMinutes };
}

function findOverlaps(logs) {
  const overlaps = [];
  const sorted = logs.slice().sort((first, second) => first.startedAt - second.startedAt);
  for (let firstIndex = 0; firstIndex < sorted.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < sorted.length; secondIndex += 1) {
      if (sorted[secondIndex].startedAt >= sorted[firstIndex].endedAt) {
        break;
      }
      const minutes = overlapMinutes(sorted[firstIndex], sorted[secondIndex]);
      if (minutes > 0) {
        overlaps.push({
          firstLogId: sorted[firstIndex].id,
          secondLogId: sorted[secondIndex].id,
          firstTitle: sorted[firstIndex].taskNameSnapshot || sorted[firstIndex].note || '未命名记录',
          secondTitle: sorted[secondIndex].taskNameSnapshot || sorted[secondIndex].note || '未命名记录',
          minutes
        });
      }
    }
  }
  return overlaps;
}

function buildStatistics(database, options) {
  const { rangeStart, rangeEnd, includeCandidates = false } = options;
  const logs = includedLogs(database, rangeStart, rangeEnd, includeCandidates);
  const totalMinutes = logs.reduce((total, log) => total + log.durationMinutes, 0);
  const completedTasks = database.tasks.filter((task) => task.status === 'completed' && task.completedAt >= rangeStart && task.completedAt <= rangeEnd);
  return {
    totalMinutes,
    categories: accumulate(logs, 'categoryId', 'categoryNameSnapshot', '未分类'),
    projects: accumulate(logs, 'projectId', 'projectNameSnapshot', '未归属项目'),
    planVariance: calculatePlanVariance(database, logs, rangeStart, rangeEnd),
    overlaps: findOverlaps(logs),
    weeklyReview: {
      totalMinutes,
      logCount: logs.length,
      completedTaskCount: completedTasks.length,
      nonPlannedMinutes: calculatePlanVariance(database, logs, rangeStart, rangeEnd).nonPlannedMinutes
    }
  };
}

module.exports = {
  includedLogs,
  buildStatistics,
  findOverlaps
};
