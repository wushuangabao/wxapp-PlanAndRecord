const { REPEAT_FREQUENCY } = require('./constants');
const { createId } = require('./id');

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function occurrenceKey(ruleId, occurrenceStart) {
  return `${ruleId}:${occurrenceStart}`;
}

function occurrenceId(ruleId, revision, occurrenceStart) {
  return `${ruleId}:${revision}:${occurrenceStart}`;
}

function logicalOccurrenceStart(ruleId, originOccurrenceId) {
  if (typeof ruleId !== 'string' || !ruleId || typeof originOccurrenceId !== 'string') {
    return null;
  }
  const prefix = `${ruleId}:`;
  if (!originOccurrenceId.startsWith(prefix)) {
    return null;
  }
  const parts = originOccurrenceId.slice(prefix.length).split(':');
  if (parts.length !== 2) {
    return null;
  }
  const revision = Number(parts[0]);
  const occurrenceStart = Number(parts[1]);
  if (!Number.isInteger(revision) || revision < 1 || String(revision) !== parts[0]
    || !Number.isInteger(occurrenceStart) || occurrenceStart <= 0 || String(occurrenceStart) !== parts[1]) {
    return null;
  }
  return occurrenceStart;
}

function logicalOccurrenceKey(ruleId, originOccurrenceId) {
  const occurrenceStart = logicalOccurrenceStart(ruleId, originOccurrenceId);
  return occurrenceStart === null ? null : occurrenceKey(ruleId, occurrenceStart);
}

function initialRuleOccurrenceStart(rule) {
  if (!rule || !Array.isArray(rule.revisions)) {
    return null;
  }
  const effectiveStarts = rule.revisions
    .map((revision) => revision.effectiveFrom)
    .filter(Number.isFinite);
  return effectiveStarts.reduce(
    (earliest, effectiveFrom) => (earliest === null ? effectiveFrom : Math.min(earliest, effectiveFrom)),
    null
  );
}

function localDayStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localCalendarDayNumber(timestamp) {
  const date = new Date(timestamp);
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60 * 1000));
}

function dayDifference(firstTimestamp, secondTimestamp) {
  return localCalendarDayNumber(secondTimestamp) - localCalendarDayNumber(firstTimestamp);
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

function isWithinRevision(revision, occurrenceStart) {
  return occurrenceStart >= revision.effectiveFrom
    && (!revision.effectiveUntil || occurrenceStart <= revision.effectiveUntil);
}

function isScheduledDate(revision, occurrenceStart) {
  const anchor = new Date(revision.effectiveFrom);
  const candidate = new Date(occurrenceStart);
  const interval = revision.interval || 1;
  if (!isWithinRevision(revision, occurrenceStart)) {
    return false;
  }
  if (revision.frequency === REPEAT_FREQUENCY.DAILY) {
    const difference = dayDifference(revision.effectiveFrom, occurrenceStart);
    return difference >= 0 && difference % interval === 0;
  }
  if (revision.frequency === REPEAT_FREQUENCY.WEEKLY) {
    const difference = dayDifference(weekStart(revision.effectiveFrom), weekStart(occurrenceStart)) / 7;
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

function shiftLocalDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function projectRevisionStartedAt(revision, occurrenceStart) {
  if (occurrenceStart === revision.effectiveFrom) {
    return revision.startedAt;
  }
  const displayDayOffset = dayDifference(revision.effectiveFrom, revision.startedAt);
  return withTime(shiftLocalDays(occurrenceStart, displayDayOffset), revision.startedAt);
}

function intervalIntersectsRange(item, rangeStart, rangeEnd) {
  return Boolean(item)
    && Number.isFinite(item.startedAt)
    && Number.isFinite(item.endedAt)
    && item.endedAt > rangeStart
    && item.startedAt <= rangeEnd;
}

function projectRule(rule, rangeStart, rangeEnd, exceptions) {
  const projected = [];
  const exceptionsByKey = new Map((exceptions || [])
    .filter((item) => item.ruleId === rule.id)
    .map((item) => [occurrenceKey(item.ruleId, item.occurrenceStart), item]));
  const seen = new Set();

  rule.revisions.forEach((revision) => {
    const duration = revision.endedAt - revision.startedAt;
    const lastDay = localDayStart(Math.min(rangeEnd, revision.effectiveUntil || rangeEnd));
    for (
      const cursor = new Date(Math.max(localDayStart(rangeStart), localDayStart(revision.effectiveFrom)));
      cursor.getTime() <= lastDay;
      cursor.setDate(cursor.getDate() + 1)
    ) {
      const day = cursor.getTime();
      const occurrenceStart = withTime(day, revision.effectiveFrom);
      const startedAt = projectRevisionStartedAt(revision, occurrenceStart);
      const endedAt = startedAt + duration;
      if (occurrenceStart < rangeStart || occurrenceStart > rangeEnd
        || !isWithinRevision(revision, occurrenceStart)) {
        continue;
      }
      const key = occurrenceKey(rule.id, occurrenceStart);
      const exception = exceptionsByKey.get(key);
      const hasOverride = exception && exception.kind === 'override';
      if (!hasOverride && !isScheduledDate(revision, occurrenceStart)) {
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (exception && exception.kind === 'skip') {
        continue;
      }
      const override = exception && exception.kind === 'override' ? exception.override : null;
      projected.push({
        id: occurrenceId(rule.id, revision.revision, occurrenceStart),
        occurrenceKey: key,
        occurrenceStart,
        ruleId: rule.id,
        ruleRevision: revision.revision,
        originOccurrenceId: occurrenceId(rule.id, revision.revision, occurrenceStart),
        virtual: true,
        type: 'candidate',
        title: (override && override.title) || rule.title,
        startedAt: (override && override.startedAt) || startedAt,
        endedAt: (override && override.endedAt) || endedAt,
        priority: (override && override.priority) || revision.priority,
        projectId: null,
        projectNameSnapshot: hasOwn(override, 'projectNameSnapshot')
          ? override.projectNameSnapshot
          : revision.projectNameSnapshot,
        taskId: hasOwn(override, 'taskId') ? override.taskId : revision.taskId,
        taskNameSnapshot: hasOwn(override, 'taskNameSnapshot')
          ? override.taskNameSnapshot
          : revision.taskNameSnapshot,
        originRuleSummarySnapshot: rule.title
      });
    }
  });
  return projected.sort((first, second) => first.startedAt - second.startedAt);
}

function projectRuleIntersectingRange(rule, rangeStart, rangeEnd, exceptions) {
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd < rangeStart) {
    return [];
  }

  const occurrences = new Map();
  const addOccurrence = (occurrence) => {
    occurrences.set(occurrenceKey(occurrence.ruleId, occurrence.occurrenceStart), occurrence);
  };

  rule.revisions.forEach((revision) => {
    const duration = Math.max(0, revision.endedAt - revision.startedAt);
    const displayDayOffset = dayDifference(revision.effectiveFrom, revision.startedAt);
    const firstLogicalDay = shiftLocalDays(localDayStart(rangeStart - duration), -displayDayOffset);
    const lastLogicalDay = shiftLocalDays(localDayStart(rangeEnd), -displayDayOffset);
    projectRule(
      { ...rule, revisions: [revision] },
      withTime(firstLogicalDay, revision.effectiveFrom),
      withTime(lastLogicalDay, revision.effectiveFrom),
      exceptions
    ).forEach(addOccurrence);
  });

  (exceptions || [])
    .filter((exception) => exception.ruleId === rule.id && exception.kind === 'override')
    .forEach((exception) => {
      projectRule(
        rule,
        exception.occurrenceStart,
        exception.occurrenceStart,
        exceptions
      )
        .filter((occurrence) => intervalIntersectsRange(occurrence, rangeStart, rangeEnd))
        .forEach(addOccurrence);
    });

  return Array.from(occurrences.values())
    .filter((occurrence) => intervalIntersectsRange(occurrence, rangeStart, rangeEnd))
    .sort((first, second) => first.startedAt - second.startedAt);
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
  logicalOccurrenceKey,
  logicalOccurrenceStart,
  initialRuleOccurrenceStart,
  intervalIntersectsRange,
  projectRevisionStartedAt,
  projectRule,
  projectRuleIntersectingRange,
  createOccurrenceException
};
