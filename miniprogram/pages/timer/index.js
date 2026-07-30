const { TIMER_STATUS } = require('../../domain/constants');
const { calculateTimerDurationMinutes, parseLocalDateTime, sumPausedMilliseconds } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, showError, showSaved } = require('../../utils/page');

const DAY_MS = 24 * 60 * 60 * 1_000;
const PLAN_WINDOW_PADDING_MS = DAY_MS;
const MAX_PLAN_WINDOW_MS = 3 * DAY_MS;

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function elapsedSeconds(timer, now) {
  if (!timer || !Number.isFinite(timer.startedAt) || timer.startedAt <= 0) {
    return 0;
  }
  const pauses = (timer.pauses || []).slice();
  if (timer.status === TIMER_STATUS.PAUSED && timer.pausedAt) {
    pauses.push({ startedAt: timer.pausedAt, endedAt: now });
  }
  return Math.max(0, Math.floor((now - timer.startedAt - sumPausedMilliseconds(pauses, now)) / 1_000));
}

function findOptionIndex(options, id) {
  const index = options.findIndex((item) => item.id === id);
  return index < 0 ? 0 : index;
}

function boundedPlanRange(startedAt, endedAt, fallbackNow = Date.now()) {
  const anchorStart = Number.isFinite(startedAt) ? startedAt : fallbackNow;
  const anchorEnd = Number.isFinite(endedAt) && endedAt >= anchorStart
    ? endedAt
    : anchorStart;
  const rangeStart = anchorStart - PLAN_WINDOW_PADDING_MS;
  return {
    start: rangeStart,
    end: Math.min(anchorEnd + PLAN_WINDOW_PADDING_MS, rangeStart + MAX_PLAN_WINDOW_MS)
  };
}

function planAssociationKey(value) {
  if (value && value.originRuleId && value.originOccurrenceId) {
    return `origin:${value.originRuleId}:${value.originOccurrenceId}`;
  }
  const calendarEventId = value && (value.calendarEventId || (
    value.associationType === 'event' || value.associationType === 'current-event'
      ? value.id
      : null
  ));
  return calendarEventId ? `event:${calendarEventId}` : null;
}

function planOptionTitle(item) {
  return `${item.title} · ${formatDateTime(item.startedAt).slice(5, 16)}`;
}

function planOptionsForRange(service, snapshot, startedAt, endedAt) {
  const taskIds = new Set(snapshot.tasks.map((item) => item.id));
  const range = boundedPlanRange(startedAt, endedAt);
  const options = [{
    id: '',
    title: '非计划实际（不关联计划块）',
    associationType: 'none'
  }];
  const seen = new Set();
  service.planAssociationCandidates(range.start, range.end).forEach((item) => {
    if (!taskIds.has(item.taskId)) return;
    let option;
    if (item.virtual && item.ruleId && item.originOccurrenceId) {
      option = {
        ...item,
        id: `origin:${item.ruleId}:${item.originOccurrenceId}`,
        title: planOptionTitle(item),
        associationType: 'origin',
        originRuleId: item.ruleId
      };
    } else if (item.type === 'plan' && !item.virtual) {
      option = {
        ...item,
        calendarEventId: item.id,
        title: planOptionTitle(item),
        associationType: 'event'
      };
    }
    const key = planAssociationKey(option);
    if (!option || !key || seen.has(key)) return;
    seen.add(key);
    options.push(option);
  });
  return { options, range };
}

function findPlanAssociationIndex(options, association) {
  const key = planAssociationKey(association);
  if (!key) return 0;
  const index = options.findIndex((item) => planAssociationKey(item) === key);
  return index < 0 ? 0 : index;
}

function optionsWithSelected(baseOptions, selected) {
  const options = baseOptions.slice();
  const matchedIndex = findPlanAssociationIndex(options, selected);
  if (matchedIndex > 0 || !planAssociationKey(selected)) {
    return { options, index: matchedIndex };
  }
  options.splice(1, 0, selected);
  return { options, index: 1 };
}

function optionsForCurrentDraft(baseOptions, draft, eventById) {
  const options = baseOptions.slice();
  if (draft.originRuleId && draft.originOccurrenceId) {
    const matchedIndex = findPlanAssociationIndex(options, draft);
    if (matchedIndex > 0) return { options, index: matchedIndex };
    options.splice(1, 0, {
      id: `origin:${draft.originRuleId}:${draft.originOccurrenceId}`,
      title: `${draft.originRuleSummarySnapshot || draft.taskNameSnapshot || '重复计划'}（当前关联）`,
      associationType: 'current-origin',
      originRuleId: draft.originRuleId,
      originOccurrenceId: draft.originOccurrenceId
    });
    return { options, index: 1 };
  }
  if (draft.calendarEventId) {
    const matchedIndex = findPlanAssociationIndex(options, draft);
    if (matchedIndex > 0) return { options, index: matchedIndex };
    const currentEvent = eventById && eventById.get(draft.calendarEventId);
    options.splice(1, 0, {
      ...(currentEvent || {
        id: draft.calendarEventId,
        title: draft.calendarEventSummarySnapshot || '历史计划块'
      }),
      associationType: 'current-event',
      calendarEventId: draft.calendarEventId
    });
    return { options, index: 1 };
  }
  return { options, index: 0 };
}

function associationInput(options, index) {
  const option = options[index];
  if (option && (option.associationType === 'current-origin' || option.associationType === 'current-event')) {
    return {};
  }
  if (option && option.associationType === 'origin') {
    return {
      originRuleId: option.originRuleId,
      originOccurrenceId: option.originOccurrenceId
    };
  }
  return {
    calendarEventId: option && option.id ? option.id : null
  };
}

function parseTags(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function formatTags(tags) {
  return Array.isArray(tags) ? tags.join('，') : '';
}

Page({
  data: {
    timer: { status: TIMER_STATUS.IDLE },
    elapsed: '00:00:00',
    elapsedMinutes: 0,
    statusLabel: '准备开始',
    primaryLabel: '开始记录',
    categories: [],
    events: [],
    categoryIndex: 0,
    eventIndex: 0,
    note: '',
    tagsText: '',
    showManual: false,
    manualStartDate: '',
    manualStartTime: '',
    manualEndDate: '',
    manualEndTime: '',
    manualNote: '',
    manualTagsText: '',
    manualCategories: [],
    manualEvents: [],
    manualCategoryIndex: 0,
    manualEventIndex: 0,
    manualMode: 'manual',
    recoveryDraft: null,
    recentLogs: []
  },

  onLoad() {
    const end = defaultDateTime();
    const start = defaultDateTime(Date.now() - 60 * 60 * 1000);
    this.setData({
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualEndDate: end.date,
      manualEndTime: end.time
    });
  },

  onShow() {
    this.refresh();
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  startTicker() {
    this.stopTicker();
    if (this.data.timer && this.data.timer.status === TIMER_STATUS.RUNNING) {
      this.ticker = setInterval(() => this.updateElapsed(), 1_000);
    }
  },

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  refresh() {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      const draft = snapshot.timer.draft || {};
      const activeCategories = snapshot.categories.filter((item) => item.status === 'active');
      const categories = activeCategories.slice();
      if (
        snapshot.timer.status !== TIMER_STATUS.IDLE
        && draft.categoryId
        && !categories.some((item) => item.id === draft.categoryId)
      ) {
        const currentCategory = snapshot.categories.find((item) => item.id === draft.categoryId);
        if (currentCategory) categories.push(currentCategory);
      }
      const now = Date.now();
      const planSelection = planOptionsForRange(service, snapshot, now, now);
      const selectableEvents = planSelection.options;
      const eventById = new Map(snapshot.calendarEvents.map((item) => [item.id, item]));
      const currentCategory = this.data.categories[this.data.categoryIndex];
      const currentEvent = this.data.events[this.data.eventIndex];
      const categoryId = snapshot.timer.status === TIMER_STATUS.IDLE
        ? (currentCategory && currentCategory.id)
        : draft.categoryId;
      let currentPlan;
      if (snapshot.timer.status === TIMER_STATUS.IDLE) {
        const matchedIndex = findPlanAssociationIndex(selectableEvents, currentEvent);
        currentPlan = matchedIndex > 0
          ? { options: selectableEvents, index: matchedIndex }
          : currentEvent && ['event', 'origin'].includes(currentEvent.associationType)
            ? optionsWithSelected(selectableEvents, currentEvent)
            : { options: selectableEvents, index: 0 };
      } else {
        currentPlan = optionsForCurrentDraft(selectableEvents, draft, eventById);
      }
      this.categoryById = new Map(snapshot.categories.map((item) => [item.id, item]));
      this.eventById = eventById;
      this.activeCategories = activeCategories;
      this.selectableEvents = selectableEvents;
      this.currentSnapshot = snapshot;
      this.currentService = service;
      this.planSelectionRange = planSelection.range;
      const recentLogs = snapshot.timeLogs.slice(-5).reverse().map((log) => ({
        ...log,
        displayTime: `${formatDateTime(log.startedAt)} · ${log.durationMinutes} 分钟`,
        displayTitle: log.calendarEventSummarySnapshot
          || log.originRuleSummarySnapshot
          || log.taskNameSnapshot
          || log.note
          || '未命名记录'
      }));
      this.setData({
        timer: snapshot.timer,
        recoveryDraft: snapshot.recoveryDraft,
        categories,
        events: currentPlan.options,
        categoryIndex: findOptionIndex(categories, categoryId),
        eventIndex: currentPlan.index,
        recentLogs,
        note: snapshot.timer.status === TIMER_STATUS.IDLE ? this.data.note : (draft.note || ''),
        tagsText: snapshot.timer.status === TIMER_STATUS.IDLE
          ? this.data.tagsText
          : formatTags(draft.tags)
      }, () => {
        this.updateElapsed();
        this.startTicker();
      });
    } catch (error) {
      showError(error);
    }
  },

  updateElapsed() {
    const timer = this.data.timer;
    if (!timer || !timer.startedAt || timer.status === TIMER_STATUS.IDLE) {
      this.setData({ elapsed: '00:00:00', elapsedMinutes: 0, statusLabel: '准备开始', primaryLabel: '开始记录' });
      return;
    }
    const endedAt = timer.status === TIMER_STATUS.ENDED ? timer.endedAt : Date.now();
    const pauses = timer.status === TIMER_STATUS.PAUSED && timer.pausedAt
      ? (timer.pauses || []).concat({ startedAt: timer.pausedAt, endedAt })
      : timer.pauses;
    const seconds = elapsedSeconds(timer, endedAt);
    const duration = calculateTimerDurationMinutes(timer.startedAt, endedAt, pauses);
    const primaryLabel = timer.status === TIMER_STATUS.RUNNING ? '暂停' : timer.status === TIMER_STATUS.PAUSED ? '继续' : '生成记录';
    const statusLabel = timer.status === TIMER_STATUS.RUNNING ? '计时中' : timer.status === TIMER_STATUS.PAUSED ? '已暂停' : '已结束，等待确认';
    this.setData({ elapsed: formatDuration(seconds), elapsedMinutes: duration, statusLabel, primaryLabel });
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  onTagsInput(event) {
    this.setData({ tagsText: event.detail.value });
  },

  onPickerChange(event) {
    this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) });
  },

  selectedInput() {
    const getId = (items, index) => (items[index] ? items[index].id : undefined);
    return {
      categoryId: getId(this.data.categories, this.data.categoryIndex),
      ...associationInput(this.data.events, this.data.eventIndex),
      note: this.data.note,
      tags: parseTags(this.data.tagsText)
    };
  },

  selectedManualInput() {
    const category = this.data.manualCategories[this.data.manualCategoryIndex];
    return {
      categoryId: category && category.id,
      ...associationInput(this.data.manualEvents, this.data.manualEventIndex),
      tags: parseTags(this.data.manualTagsText)
    };
  },

  onPrimary() {
    const service = getService();
    try {
      const status = this.data.timer.status;
      if (status === TIMER_STATUS.IDLE) service.startTimer(this.selectedInput());
      if (status === TIMER_STATUS.RUNNING) service.pauseTimer();
      if (status === TIMER_STATUS.PAUSED) service.resumeTimer();
      if (status === TIMER_STATUS.ENDED) {
        const result = service.generateTimerRecord();
        this.setData({ categoryIndex: 0, eventIndex: 0, note: '', tagsText: '' });
        showSaved(result.hasOverlap ? '已保存：存在重叠时间' : '记录已生成');
      }
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  onSaveTimerDraft() {
    try {
      getService().updateTimerDraft(this.selectedInput());
      showSaved();
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  onFinishTimer() {
    try {
      getService().finishTimer();
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  planOptionsForManualFields() {
    const startedAt = parseLocalDateTime(this.data.manualStartDate, this.data.manualStartTime);
    const endedAt = parseLocalDateTime(this.data.manualEndDate, this.data.manualEndTime);
    const service = this.currentService || getService();
    const snapshot = this.currentSnapshot || service.snapshot();
    return planOptionsForRange(service, snapshot, startedAt, endedAt);
  },

  refreshManualPlanOptions() {
    if (!this.data.showManual) return;
    try {
      const selected = this.data.manualEvents[this.data.manualEventIndex];
      const planSelection = this.planOptionsForManualFields();
      const currentPlan = optionsWithSelected(planSelection.options, selected);
      this.manualPlanSelectionRange = planSelection.range;
      this.setData({
        manualEvents: currentPlan.options,
        manualEventIndex: currentPlan.index
      });
    } catch (error) {
      // 日期和时间字段尚未形成合法区间时保留现有选项，保存时再统一提示。
    }
  },

  openManual() {
    const categories = (this.activeCategories || this.data.categories).slice();
    const currentCategory = this.data.categories[this.data.categoryIndex];
    const currentEvent = this.data.events[this.data.eventIndex];
    const planSelection = this.planOptionsForManualFields();
    const matchedIndex = findPlanAssociationIndex(planSelection.options, currentEvent);
    const currentPlan = matchedIndex > 0
      ? { options: planSelection.options, index: matchedIndex }
      : currentEvent && ['event', 'origin'].includes(currentEvent.associationType)
        ? optionsWithSelected(planSelection.options, currentEvent)
        : { options: planSelection.options, index: 0 };
    this.manualPlanSelectionRange = planSelection.range;
    this.setData({
      showManual: true,
      manualMode: 'manual',
      manualNote: '',
      manualTagsText: '',
      manualCategories: categories,
      manualEvents: currentPlan.options,
      manualCategoryIndex: findOptionIndex(categories, currentCategory && currentCategory.id),
      manualEventIndex: currentPlan.index
    });
  },

  openRecoveryManual() {
    const timer = this.data.recoveryDraft && this.data.recoveryDraft.timer ? this.data.recoveryDraft.timer : {};
    const startedAt = Number.isFinite(timer.startedAt) && timer.startedAt > 0 ? timer.startedAt : Date.now() - 60 * 60 * 1_000;
    const endedAt = Number.isFinite(timer.endedAt) && timer.endedAt > startedAt ? timer.endedAt : startedAt + 60 * 60 * 1_000;
    const start = defaultDateTime(startedAt);
    const end = defaultDateTime(endedAt);
    const draft = timer.draft || {};
    const categories = this.data.categories.slice();
    if (draft.categoryId && !categories.some((item) => item.id === draft.categoryId)) {
      const currentCategory = this.categoryById && this.categoryById.get(draft.categoryId);
      if (currentCategory) categories.push(currentCategory);
    }
    const service = this.currentService || getService();
    const snapshot = this.currentSnapshot || service.snapshot();
    const planSelection = planOptionsForRange(service, snapshot, startedAt, endedAt);
    const currentPlan = optionsForCurrentDraft(planSelection.options, draft, this.eventById);
    this.manualPlanSelectionRange = planSelection.range;
    this.setData({
      showManual: true,
      manualMode: 'recovery',
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualEndDate: end.date,
      manualEndTime: end.time,
      manualNote: draft.note || '',
      manualTagsText: formatTags(draft.tags),
      manualCategories: categories,
      manualEvents: currentPlan.options,
      manualCategoryIndex: findOptionIndex(categories, draft.categoryId),
      manualEventIndex: currentPlan.index
    });
  },

  closeManual() {
    this.setData({ showManual: false });
  },

  onManualField(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [key]: event.detail.value }, () => {
      if (['manualStartDate', 'manualStartTime', 'manualEndDate', 'manualEndTime'].includes(key)) {
        this.refreshManualPlanOptions();
      }
    });
  },

  onManualSave() {
    try {
      const startedAt = parseLocalDateTime(this.data.manualStartDate, this.data.manualStartTime);
      const endedAt = parseLocalDateTime(this.data.manualEndDate, this.data.manualEndTime);
      const input = { ...this.selectedManualInput(), startedAt, endedAt, note: this.data.manualNote };
      const result = this.data.manualMode === 'recovery'
        ? { log: getService().createRecoveryCandidate(input), hasOverlap: false }
        : getService().createManualLog(input);
      const wasRecovery = this.data.manualMode === 'recovery';
      this.setData({
        showManual: false,
        manualMode: 'manual',
        manualNote: '',
        manualTagsText: ''
      });
      showSaved(wasRecovery ? '已创建待核实的恢复记录' : (result.hasOverlap ? '已保存：存在重叠时间' : '补录已保存'));
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  noop() {
    // 阻止弹层点击穿透。
  }
});
