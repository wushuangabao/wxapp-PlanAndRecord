const { REPEAT_FREQUENCY } = require('./constants');
const { createId } = require('./id');

function occurrenceKey(ruleId, occurrenceStart) {
  return `${ruleId}:${occurrenceStart}`;
}

function occurrenceId(ruleId, revision, occurrenceStart) {
  return `${ruleId}:${revision}:${occurrenceStart}`;
}

function localDayStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayDifference(firstTimestamp, secondTimestamp) {
  const first = localDayStart(firstTimestamp);
  const second = localDayStart(secondTimestamp);
  return Math.round((second - first) / (24 * 60 * 60 * 1000));
}

function weekStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date.getTime();
}

function monthDifference(firstTimestamp, secondTimestamp) {
  const first = new Date(firstTimestamp);
  const second = new Date(secondTimestamp);
  return (second.getFullYear() - first.getFullYear()) * 12 + second.getMonth() - first.getMonth();
}

function isScheduledDate(revision, occurrenceStart) {
  const anchor = new Date(revision.startedAt);
  const candidate = new Date(occurrenceStart);
  const interval = revision.interval || 1;
  if (occurrenceStart < revision.effectiveFrom || (revision.effectiveUntil && occurrenceStart > revision.effectiveUntil)) {
    return false;
  }
  if (revision.frequency === REPEAT_FREQUENCY.DAILY) {
    const difference = dayDifference(revision.effectiveFrom, occurrenceStart);
    return difference >= 0 && difference % interval === 0;
  }
  if (revision.frequency === REPEAT_FREQUENCY.WEEKLY) {
    const difference = Math.round((weekStart(occurrenceStart) - weekStart(revision.effectiveFrom)) / (7 * 24 * 60 * 60 * 1000));
    const weekdays = revision.weekdays && revision.weekdays.length ? revision.weekdays : [anchor.getDay()];
    return difference >= 0 && difference % interval === 0 && weekdays.includes(candidate.getDay());
  }
  if (revision.frequency === REPEAT_FREQUENCY.MONTHLY) {
    const difference = monthDifference(revision.effectiveFrom, occurrenceStart);
    const monthDay = revision.monthDay || anchor.getDate();
    return difference >= 0 && difference % interval === 0 && candidate.getDate() === monthDay;
  }
  return false;
}

function withTime(dayTimestamp, sourceTimestamp) {
  const day = new Date(dayTimestamp);
  const source = new Date(sourceTimestamp);
  day.setHours(source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
  return day.getTime();
}

function projectRule(rule, rangeStart, rangeEnd, exceptions) {
  const projected = [];
  const exceptionsByKey = new Map((exceptions || [])
    .filter((item) => item.ruleId === rule.id)
    .map((item) => [occurrenceKey(item.ruleId, item.occurrenceStart), item]));
  const seen = new Set();
  const oneDay = 24 * 60 * 60 * 1000;

  rule.revisions.forEach((revision) => {
    const duration = revision.endedAt - revision.startedAt;
    const cursor = new Date(Math.max(localDayStart(rangeStart), localDayStart(revision.effectiveFrom)));
    const lastDay = localDayStart(Math.min(rangeEnd, revision.effectiveUntil || rangeEnd));
    for (let day = cursor.getTime(); day <= lastDay; day += oneDay) {
      const startedAt = withTime(day, revision.startedAt);
      const endedAt = startedAt + duration;
      if (startedAt < rangeStart || startedAt > rangeEnd || !isScheduledDate(revision, startedAt)) {
        continue;
      }
      const key = occurrenceKey(rule.id, startedAt);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const exception = exceptionsByKey.get(key);
      if (exception && exception.kind === 'skip') {
        continue;
      }
      const override = exception && exception.kind === 'override' ? exception.override : null;
      projected.push({
        id: occurrenceId(rule.id, revision.revision, startedAt),
        occurrenceKey: key,
        occurrenceStart: startedAt,
        ruleId: rule.id,
        ruleRevision: revision.revision,
        originOccurrenceId: occurrenceId(rule.id, revision.revision, startedAt),
        virtual: true,
        type: 'candidate',
        title: (override && override.title) || rule.title,
        startedAt: (override && override.startedAt) || startedAt,
        endedAt: (override && override.endedAt) || endedAt,
        priority: (override && override.priority) || revision.priority,
        projectId: (override && override.projectId) || revision.projectId,
        projectNameSnapshot: (override && override.projectNameSnapshot) || revision.projectNameSnapshot,
        taskId: (override && override.taskId) || revision.taskId,
        taskNameSnapshot: (override && override.taskNameSnapshot) || revision.taskNameSnapshot,
        originRuleSummarySnapshot: rule.title
      });
    }
  });
  return projected.sort((first, second) => first.startedAt - second.startedAt);
}

function createOccurrenceException(ruleId, occurrenceStart, kind, override, now = Date.now()) {
  return {
    id: createId('exception', now),
    ruleId,
    occurrenceStart,
    kind,
    override: override || null,
    createdAt: now,
    updatedAt: now
  };
}

module.exports = {
  occurrenceKey,
  occurrenceId,
  projectRule,
  createOccurrenceException
};
