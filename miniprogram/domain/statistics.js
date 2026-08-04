const { LOG_STATUS } = require('./constants');
const {
  initialRuleOccurrenceStart,
  intervalIntersectsRange,
  logicalOccurrenceKey,
  logicalOccurrenceStart,
  occurrenceKey,
  projectRuleIntersectingRange
} = require('./recurrence');
const { calculateDurationMinutes } = require('./time');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function projectedRuleOccurrences(database, rule, rangeStart, rangeEnd) {
  return projectRuleIntersectingRange(
    rule,
    rangeStart,
    rangeEnd,
    database.occurrenceExceptions
  );
}

function includedLogs(database, rangeStart, rangeEnd, includeCandidates) {
  return database.timeLogs.filter((log) => {
    const includedStatus = log.status === LOG_STATUS.CONFIRMED || (includeCandidates && log.status === LOG_STATUS.CANDIDATE);
    return includedStatus && intervalIntersectsRange(log, rangeStart, rangeEnd);
  });
}

function accumulate(logs, idField, nameField, fallbackName) {
  const groups = new Map();
  logs.forEach((log) => {
    const id = log[idField] || 'unassigned';
    const name = log[nameField] || fallbackName;
    const current = groups.get(id) || { id, name, durationMinutes: 0, count: 0 };
    current.durationMinutes += log.durationMinutes;
    current.count += 1;
    groups.set(id, current);
  });
  return Array.from(groups.values()).sort((first, second) => second.durationMinutes - first.durationMinutes);
}

function accumulateTags(logs) {
  const groups = new Map();
  logs.forEach((log) => {
    const tags = Array.isArray(log.tags) ? Array.from(new Set(log.tags)) : [];
    const groupTags = tags.length ? tags : [null];
    groupTags.forEach((tag) => {
      const isUntagged = tag === null;
      const id = isUntagged ? 'untagged' : `tag:${tag}`;
      const current = groups.get(id) || {
        id,
        tag,
        name: isUntagged ? '无标签' : tag,
        isUntagged,
        durationMinutes: 0,
        count: 0
      };
      current.durationMinutes += log.durationMinutes;
      current.count += 1;
      groups.set(id, current);
    });
  });
  return Array.from(groups.values()).sort(
    (first, second) => second.durationMinutes - first.durationMinutes
  );
}

function occurrenceRevisionNumber(ruleId, originOccurrenceId) {
  if (!ruleId || !originOccurrenceId || logicalOccurrenceStart(ruleId, originOccurrenceId) === null) {
    return null;
  }
  const prefix = `${ruleId}:`;
  const separatorIndex = originOccurrenceId.indexOf(':', prefix.length);
  if (!originOccurrenceId.startsWith(prefix) || separatorIndex < 0) {
    return null;
  }
  const revision = Number(originOccurrenceId.slice(prefix.length, separatorIndex));
  return Number.isInteger(revision) && revision > 0 ? revision : null;
}

function resolveRuleOccurrenceTaskId(database, log) {
  if (!log.originRuleId || !log.originOccurrenceId) return null;
  const rule = database.repeatRules.find((item) => item.id === log.originRuleId);
  const occurrenceStart = logicalOccurrenceStart(log.originRuleId, log.originOccurrenceId);
  const revisionNumber = occurrenceRevisionNumber(log.originRuleId, log.originOccurrenceId);
  if (!rule || occurrenceStart === null || revisionNumber === null) return null;

  const revision = rule.revisions.find((item) => item.revision === revisionNumber);
  if (!revision) return null;
  const exception = database.occurrenceExceptions.find((item) => (
    item.ruleId === rule.id
    && item.occurrenceStart === occurrenceStart
    && item.kind === 'override'
  ));
  if (exception && exception.override && hasOwn(exception.override, 'taskId')) {
    return exception.override.taskId || null;
  }
  return revision.taskId || null;
}

function deriveLogAssociations(database, logs) {
  const eventsById = new Map(database.calendarEvents.map((event) => [event.id, event]));
  const tasksById = new Map(database.tasks.map((task) => [task.id, task]));
  const projectsById = new Map(database.projects.map((project) => [project.id, project]));

  return logs.map((log) => {
    let taskId = null;
    let taskNameSnapshot = log.taskNameSnapshot || null;
    if (log.calendarEventId) {
      const event = eventsById.get(log.calendarEventId);
      if (event) {
        taskId = event.taskId || null;
        taskNameSnapshot = event.taskNameSnapshot || taskNameSnapshot;
      }
    } else {
      taskId = resolveRuleOccurrenceTaskId(database, log);
    }

    const task = taskId ? tasksById.get(taskId) : null;
    const project = task && task.projectId ? projectsById.get(task.projectId) : null;
    return {
      ...log,
      taskId: task ? task.id : null,
      taskNameSnapshot: task ? task.title : taskNameSnapshot,
      projectId: project ? project.id : null,
      projectNameSnapshot: project ? project.title : null
    };
  });
}

function planAssociationKey(log) {
  if (log.calendarEventId) return `event:${log.calendarEventId}`;
  const logicalKey = logicalOccurrenceKey(log.originRuleId, log.originOccurrenceId);
  return logicalKey ? `occurrence:${logicalKey}` : null;
}

function calculatePlanVariance(database, logs, rangeStart, rangeEnd) {
  const actualMinutesByPlan = new Map();
  logs.forEach((log) => {
    const key = planAssociationKey(log);
    if (!key) return;
    actualMinutesByPlan.set(key, (actualMinutesByPlan.get(key) || 0) + log.durationMinutes);
  });

  const concreteEvents = database.calendarEvents
    .filter((event) => intervalIntersectsRange(event, rangeStart, rangeEnd))
    .map((event) => {
      const plannedMinutes = Math.round((event.endedAt - event.startedAt) / (60 * 1000));
      const actualMinutes = actualMinutesByPlan.get(`event:${event.id}`) || 0;
      return {
        eventId: event.id,
        title: event.title,
        plannedMinutes,
        actualMinutes,
        varianceMinutes: actualMinutes - plannedMinutes
      };
    });

  const repeatRulesById = new Map(database.repeatRules.map((rule) => [rule.id, rule]));
  const taskIds = new Set(database.tasks.map((task) => task.id));
  const materializedEventOccurrences = new Set(database.calendarEvents
    .filter((event) => event.repeatRuleId)
    .map((event) => {
      const occurrenceStart = initialRuleOccurrenceStart(repeatRulesById.get(event.repeatRuleId));
      return occurrenceStart === null || occurrenceStart === undefined
        ? null
        : occurrenceKey(event.repeatRuleId, occurrenceStart);
    })
    .filter(Boolean));
  const recurringEvents = database.repeatRules
    .flatMap((rule) => projectedRuleOccurrences(database, rule, rangeStart, rangeEnd))
    .filter((occurrence) => occurrence.taskId && taskIds.has(occurrence.taskId))
    .filter((occurrence) => !materializedEventOccurrences.has(occurrenceKey(
      occurrence.ruleId,
      occurrence.occurrenceStart
    )))
    .map((occurrence) => {
      const plannedMinutes = calculateDurationMinutes(occurrence.startedAt, occurrence.endedAt, []);
      const key = `occurrence:${occurrenceKey(occurrence.ruleId, occurrence.occurrenceStart)}`;
      const actualMinutes = actualMinutesByPlan.get(key) || 0;
      return {
        eventId: occurrence.originOccurrenceId,
        title: occurrence.title,
        plannedMinutes,
        actualMinutes,
        varianceMinutes: actualMinutes - plannedMinutes
      };
    });

  const nonPlannedMinutes = logs
    .filter((log) => !log.virtual && !planAssociationKey(log))
    .reduce((total, log) => total + log.durationMinutes, 0);
  return { events: concreteEvents.concat(recurringEvents), nonPlannedMinutes };
}

function buildStatistics(database, options) {
  const { rangeStart, rangeEnd, includeCandidates = false } = options;
  const logs = deriveLogAssociations(
    database,
    includedLogs(database, rangeStart, rangeEnd, includeCandidates)
  );
  const totalMinutes = logs.reduce((total, log) => total + log.durationMinutes, 0);
  const completedTasks = database.tasks.filter((task) => task.status === 'completed' && task.completedAt >= rangeStart && task.completedAt <= rangeEnd);
  return {
    totalMinutes,
    tags: accumulateTags(logs),
    projects: accumulate(logs, 'projectId', 'projectNameSnapshot', '未归属项目'),
    planVariance: calculatePlanVariance(database, logs, rangeStart, rangeEnd),
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
  buildStatistics
};
