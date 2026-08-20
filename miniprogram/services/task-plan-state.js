const { LOG_STATUS, TIMER_STATUS } = require('../domain/constants');
const { projectRuleIntersectingRange } = require('../domain/recurrence');

const DAY_MS = 24 * 60 * 60 * 1000;

function localDayRange(timestamp) {
  const start = new Date(timestamp);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() - 1 };
}

function occurrenceAssociationKey(ruleId, occurrenceId) {
  return `${ruleId || ''}::${occurrenceId || ''}`;
}

function compareStartedAt(first, second) {
  return first.startedAt - second.startedAt || String(first.id).localeCompare(String(second.id));
}

function compareEvidence(first, second) {
  return first.createdAt - second.createdAt || String(first.id).localeCompare(String(second.id));
}

function pushMapValue(map, key, value) {
  if (!key) {
    return;
  }
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function revisionsForTask(rule, taskId) {
  return (rule.revisions || []).filter((revision) => revision.taskId === taskId);
}

function ruleCanProjectFrom(rule, now, exceptions) {
  const revisions = rule.revisions || [];
  if (!revisions.length) {
    return false;
  }
  if (revisions.some((revision) => revision.effectiveUntil === null)) {
    return true;
  }
  const rangeEnd = revisions.reduce((latest, revision) => {
    const duration = Math.max(0, revision.endedAt - revision.startedAt);
    return Math.max(latest, revision.effectiveUntil + duration);
  }, now);
  return projectRuleIntersectingRange(rule, now, rangeEnd, exceptions).length > 0;
}

function timerAssociation(database) {
  const timer = database.timer || {};
  if (timer.status === TIMER_STATUS.IDLE || !timer.draft) {
    return null;
  }
  if (timer.draft.calendarEventId) {
    return { kind: 'event', id: timer.draft.calendarEventId };
  }
  if (timer.draft.originRuleId && timer.draft.originOccurrenceId) {
    return {
      kind: 'occurrence',
      id: occurrenceAssociationKey(timer.draft.originRuleId, timer.draft.originOccurrenceId)
    };
  }
  return null;
}

function activeTimerMatchesOccurrence(database, ruleId, originOccurrenceId) {
  const association = timerAssociation(database);
  return Boolean(
    association
    && association.kind === 'occurrence'
    && association.id === occurrenceAssociationKey(ruleId, originOccurrenceId)
  );
}

function inferCompletionUndoLog(state) {
  if (!state || !state.entityPlanEvidence || !state.entityPlanEvidence.length) {
    return null;
  }
  const firstEvidencePerPlan = state.entityPlanEvidence.map((item) => {
    const confirmed = (item.logs || []).slice().sort(compareEvidence);
    return confirmed[0] || null;
  });
  if (firstEvidencePerPlan.some((item) => !item)) {
    return null;
  }
  return firstEvidencePerPlan.sort(compareEvidence).at(-1) || null;
}

function buildTaskPlanStates(database, now = Date.now()) {
  const tasks = database.tasks || [];
  const events = database.calendarEvents || [];
  const rules = database.repeatRules || [];
  const exceptions = database.occurrenceExceptions || [];
  const confirmedLogs = (database.timeLogs || []).filter((log) => log.status === LOG_STATUS.CONFIRMED);
  const eventsByTask = new Map();
  const rulesByTask = new Map();
  const confirmedByEvent = new Map();
  const confirmedByOccurrence = new Map();
  const eventById = new Map(events.map((event) => [event.id, event]));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const today = localDayRange(now);
  const activeTimerAssociation = timerAssociation(database);

  events.forEach((event) => pushMapValue(eventsByTask, event.taskId, event));
  rules.forEach((rule) => {
    const taskIds = new Set((rule.revisions || []).map((revision) => revision.taskId).filter(Boolean));
    taskIds.forEach((taskId) => pushMapValue(rulesByTask, taskId, rule));
  });
  confirmedLogs.forEach((log) => {
    pushMapValue(confirmedByEvent, log.calendarEventId, log);
    if (log.originRuleId && log.originOccurrenceId) {
      pushMapValue(
        confirmedByOccurrence,
        occurrenceAssociationKey(log.originRuleId, log.originOccurrenceId),
        log
      );
    }
  });

  const result = new Map();
  tasks.forEach((task) => {
    const entityPlans = (eventsByTask.get(task.id) || []).slice().sort(compareStartedAt);
    const repeatRules = (rulesByTask.get(task.id) || []).slice();
    const todayOccurrences = repeatRules
      .flatMap((rule) => projectRuleIntersectingRange(rule, today.start, today.end, exceptions)
        .filter((occurrence) => occurrence.taskId === task.id))
      .sort(compareStartedAt);
    const todayRuleIds = new Set(todayOccurrences.map((occurrence) => occurrence.ruleId));
    const activeRepeatRules = repeatRules.filter((rule) => (
      todayRuleIds.has(rule.id)
      || ruleCanProjectFrom({ ...rule, revisions: revisionsForTask(rule, task.id) }, now, exceptions)
    ));
    const entityPlanEvidence = entityPlans.map((event) => ({
      eventId: event.id,
      logs: (confirmedByEvent.get(event.id) || []).slice().sort(compareEvidence)
    }));
    const pendingEntityPlans = entityPlans.filter((event) => !confirmedByEvent.has(event.id));
    const pendingTodayOccurrences = todayOccurrences.filter((occurrence) => (
      !confirmedByOccurrence.has(occurrenceAssociationKey(occurrence.ruleId, occurrence.originOccurrenceId))
    ));
    const eventCandidates = pendingEntityPlans.map((event) => ({
      id: `event:${event.id}`,
      kind: 'event',
      title: event.title,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      calendarEventId: event.id
    }));
    const occurrenceCandidates = pendingTodayOccurrences.map((occurrence) => ({
      id: `occurrence:${occurrence.ruleId}:${occurrence.originOccurrenceId}`,
      kind: 'occurrence',
      title: occurrence.title,
      startedAt: occurrence.startedAt,
      endedAt: occurrence.endedAt,
      originRuleId: occurrence.ruleId,
      originOccurrenceId: occurrence.originOccurrenceId
    }));
    const candidates = [...eventCandidates, ...occurrenceCandidates].sort(compareStartedAt);

    let timerMatchesTask = false;
    let timerCandidateId = null;
    if (activeTimerAssociation && activeTimerAssociation.kind === 'event') {
      const activeEvent = eventById.get(activeTimerAssociation.id);
      timerMatchesTask = Boolean(activeEvent && activeEvent.taskId === task.id);
      timerCandidateId = timerMatchesTask ? `event:${activeEvent.id}` : null;
    } else if (activeTimerAssociation && activeTimerAssociation.kind === 'occurrence') {
      const draft = database.timer.draft;
      const activeRule = ruleById.get(draft.originRuleId);
      timerMatchesTask = Boolean(activeRule && revisionsForTask(activeRule, task.id).length);
      timerCandidateId = timerMatchesTask
        ? `occurrence:${draft.originRuleId}:${draft.originOccurrenceId}`
        : null;
    }

    const hasRecordedToday = todayOccurrences.length > 0 && pendingTodayOccurrences.length === 0;
    const canAutoComplete = entityPlans.length > 0
      && pendingEntityPlans.length === 0
      && activeRepeatRules.length === 0;
    let controlKind = 'checkbox';
    if (timerMatchesTask || candidates.length > 0) {
      controlKind = 'timer';
    } else if (hasRecordedToday && activeRepeatRules.length > 0) {
      controlKind = 'recorded';
    } else if (activeRepeatRules.length > 0) {
      controlKind = 'schedule';
    }
    const state = {
      taskId: task.id,
      entityPlans,
      repeatRules,
      activeRepeatRules,
      todayOccurrences,
      pendingEntityPlans,
      pendingTodayOccurrences,
      entityPlanEvidence,
      candidates,
      hasPlanAssociations: entityPlans.length > 0 || repeatRules.length > 0,
      canAutoComplete,
      topVisible: timerMatchesTask
        || pendingEntityPlans.length > 0
        || activeRepeatRules.length === 0
        || todayOccurrences.length > 0,
      controlKind,
      recordedToday: hasRecordedToday && activeRepeatRules.length > 0,
      timerMatchesTask,
      timerCandidateId,
      timerStatus: timerMatchesTask ? database.timer.status : TIMER_STATUS.IDLE,
      completionUndoLog: null
    };
    state.completionUndoLog = inferCompletionUndoLog(state);
    result.set(task.id, state);
  });
  return result;
}

module.exports = {
  buildTaskPlanStates,
  inferCompletionUndoLog,
  occurrenceAssociationKey,
  activeTimerMatchesOccurrence
};
