const { parseLocalDateTime } = require('../../domain/time');
const { rangeForView, shiftAnchor } = require('../../utils/date-range');
const { defaultDateTime, formatDateTime, getService, showError, showSaved } = require('../../utils/page');

const VIEW_LABELS = { day: '日', week: '周', month: '月', year: '年' };
const FREQUENCY_VALUES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = ['每日', '每周', '每月'];
const DAY_MS = 24 * 60 * 60 * 1_000;
const PLAN_WINDOW_PADDING_MS = DAY_MS;
const MAX_PLAN_WINDOW_MS = 3 * DAY_MS;

function findOptionIndex(options, id) {
  const index = options.findIndex((item) => item.id === id);
  return index < 0 ? 0 : index;
}

function taskOptions(snapshot) {
  const projectById = new Map(snapshot.projects.map((item) => [item.id, item]));
  return [{ id: '', title: '请选择任务' }].concat(
    snapshot.tasks
      .filter((item) => item.status !== 'completed')
      .map((item) => ({
        ...item,
        derivedProjectName: (projectById.get(item.projectId) || {}).title
          || '未关联项目'
      }))
  );
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

function associationInput(option) {
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

Page({
  data: {
    view: 'week',
    anchor: Date.now(),
    rangeLabel: '',
    timeline: [],
    title: '',
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    priority: 1,
    repeatEnabled: false,
    frequencyIndex: 0,
    interval: '1',
    repeatWeekdays: [],
    tasks: [],
    hasTaskOptions: false,
    taskIndex: 0,
    editor: null,
    editorTitle: '',
    editorDate: '',
    editorStart: '',
    editorEnd: '',
    editorPriority: 1,
    logEditor: null,
    logDate: '',
    logStart: '',
    logEnd: '',
    logNote: '',
    logTagsText: '',
    planEditor: null,
    planTitle: '',
    planStartDate: '',
    planStartTime: '',
    planEndDate: '',
    planEndTime: '',
    planPriority: 1,
    planTasks: [],
    planTaskIndex: 0,
    categories: [],
    logCategories: [],
    logEvents: [],
    logCategoryIndex: 0,
    logEventIndex: 0,
    views: ['day', 'week', 'month', 'year'],
    frequencyLabels: FREQUENCY_LABELS,
    weekdayLabels: ['日', '一', '二', '三', '四', '五', '六']
  },

  onLoad() {
    const start = defaultDateTime(Date.now() + 60 * 60 * 1000);
    const end = defaultDateTime(Date.now() + 2 * 60 * 60 * 1000);
    this.setData({ startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      const range = rangeForView(this.data.anchor, this.data.view);
      const now = Date.now();
      const knownTaskIds = new Set(snapshot.tasks.map((item) => item.id));
      const tasks = taskOptions(snapshot);
      const selectedTaskId = this.data.tasks[this.data.taskIndex] && this.data.tasks[this.data.taskIndex].id;
      const timeline = service.timeline(range.start, range.end).map((item) => {
        const canAssociate = knownTaskIds.has(item.taskId);
        return {
          ...item,
          displayTime: `${formatDateTime(item.startedAt)} – ${formatDateTime(item.endedAt)}`,
          displayKind: item.type === 'plan' ? '计划' : item.type === 'candidate' ? '候选' : '实际',
          priority: item.priority || 1,
          canAssociate,
          canEditPlan: item.type === 'plan'
            && !item.virtual
            && (canAssociate || item.endedAt > now)
        };
      });
      const projectById = new Map(snapshot.projects.map((item) => [item.id, item]));
      this.taskById = new Map(snapshot.tasks.map((item) => [item.id, {
        ...item,
        derivedProjectName: (projectById.get(item.projectId) || {}).title
          || (item.status === 'completed' ? item.projectNameSnapshot : null)
          || '未关联项目'
      }]));
      this.categoryById = new Map(snapshot.categories.map((item) => [item.id, item]));
      this.eventById = new Map(snapshot.calendarEvents.map((item) => [item.id, item]));
      this.currentSnapshot = snapshot;
      this.currentService = service;
      this.setData({
        categories: snapshot.categories.filter((item) => item.status === 'active'),
        tasks,
        planTasks: tasks,
        hasTaskOptions: tasks.length > 1,
        taskIndex: findOptionIndex(tasks, selectedTaskId),
        timeline,
        rangeLabel: this.data.view === 'day'
          ? formatDateTime(range.start).slice(0, 10)
          : `${formatDateTime(range.start).slice(0, 10)} ～ ${formatDateTime(range.end).slice(0, 10)}`
      });
    } catch (error) {
      showError(error);
    }
  },

  changeView(event) {
    this.setData({ view: event.currentTarget.dataset.view }, () => this.refresh());
  },

  moveRange(event) {
    this.setData({ anchor: shiftAnchor(this.data.anchor, this.data.view, Number(event.currentTarget.dataset.offset)) }, () => this.refresh());
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onPicker(event) {
    this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) });
  },

  onSwitch(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onWeekdaysChange(event) {
    this.setData({ repeatWeekdays: event.detail.value.map(Number) });
  },

  choosePriority(event) {
    this.setData({ priority: Number(event.currentTarget.dataset.priority) });
  },

  createPlan() {
    try {
      const startedAt = parseLocalDateTime(this.data.startDate, this.data.startTime);
      const endedAt = parseLocalDateTime(this.data.endDate, this.data.endTime);
      const task = this.data.tasks[this.data.taskIndex];
      if (!task || !task.id) {
        throw new Error('请选择任务');
      }
      const input = { title: this.data.title, startedAt, endedAt, priority: this.data.priority, taskId: task.id };
      if (this.data.repeatEnabled) {
        input.frequency = FREQUENCY_VALUES[this.data.frequencyIndex];
        input.interval = Number(this.data.interval);
        input.weekdays = this.data.repeatWeekdays.length ? this.data.repeatWeekdays : [new Date(startedAt).getDay()];
        input.monthDay = new Date(startedAt).getDate();
        getService().createRecurringPlan(input);
        showSaved('固定日程已创建');
      } else {
        getService().createCalendarEvent(input);
        showSaved('计划块已创建');
      }
      this.setData({ title: '', repeatEnabled: false, repeatWeekdays: [] });
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  startTimerFromPlan(event) {
    try {
      const item = event.currentTarget.dataset.item;
      const association = item.virtual
        ? { originRuleId: item.ruleId, originOccurrenceId: item.originOccurrenceId }
        : { calendarEventId: item.id };
      getService().startTimer(association);
      showSaved('已从计划块开始计时');
      wx.switchTab({ url: '/pages/timer/index' });
    } catch (error) {
      showError(error);
    }
  },

  confirmItem(event) {
    try {
      const item = event.currentTarget.dataset.item;
      if (item.virtual) getService().confirmVirtualOccurrence(item);
      else getService().confirmCandidateLog(item.id);
      showSaved('候选已确认');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  discardCandidate(event) {
    const item = event.currentTarget.dataset.item;
    wx.showModal({ title: '作废候选记录', content: '作废后不会写入实际投入。', success: (result) => {
      if (!result.confirm) return;
      try {
        if (item.virtual) getService().skipOccurrence(item.ruleId, item.occurrenceStart);
        else getService().deleteLog(item.id, true);
        showSaved('候选已作废');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  openPlanEditor(event) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    const planTasks = this.data.tasks.slice();
    const existingTask = this.taskById && this.taskById.get(item.taskId);
    if (existingTask && !planTasks.some((task) => task.id === existingTask.id)) {
      planTasks.push(existingTask);
    }
    const planTaskIndex = existingTask
      ? findOptionIndex(planTasks, existingTask.id)
      : 0;
    this.setData({
      planEditor: item,
      planTitle: item.title,
      planStartDate: start.date,
      planStartTime: start.time,
      planEndDate: end.date,
      planEndTime: end.time,
      planPriority: item.priority,
      planTasks,
      planTaskIndex
    });
  },

  closePlanEditor() {
    this.setData({ planEditor: null });
  },

  savePlanEditor() {
    try {
      const item = this.data.planEditor;
      const task = this.data.planTasks[this.data.planTaskIndex];
      if (!task || !task.id || !this.taskById || !this.taskById.has(task.id)) {
        throw new Error('请选择任务');
      }
      getService().updateCalendarEvent(item.id, {
        title: this.data.planTitle,
        startedAt: parseLocalDateTime(this.data.planStartDate, this.data.planStartTime),
        endedAt: parseLocalDateTime(this.data.planEndDate, this.data.planEndTime),
        priority: this.data.planPriority,
        taskId: task.id
      });
      this.closePlanEditor();
      showSaved('计划块已更新');
      this.refresh();
    } catch (error) { showError(error); }
  },

  deletePlan(event) {
    const item = event.currentTarget.dataset.item;
    wx.showModal({
      title: '删除计划块',
      content: '会解除现有时间记录与该计划的关联，但会保留计划标题摘要用于复盘。',
      confirmText: '删除计划',
      confirmColor: '#dc2626',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().deleteCalendarEvent(item.id, true);
          showSaved('计划块已删除');
          this.refresh();
        } catch (error) { showError(error); }
      }
    });
  },

  openOccurrenceEditor(event) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    this.setData({
      editor: item,
      editorTitle: item.title,
      editorDate: start.date,
      editorStart: start.time,
      editorEnd: end.time,
      editorPriority: item.priority
    });
  },

  closeOccurrenceEditor() {
    this.setData({ editor: null });
  },

  onEditorField(event) {
    const key = event.currentTarget.dataset.key;
    this.setData({ [key]: event.detail.value }, () => {
      if (this.data.logEditor && ['logDate', 'logStart', 'logEnd'].includes(key)) {
        this.refreshLogPlanOptions();
      }
    });
  },

  chooseEditorPriority(event) {
    this.setData({ editorPriority: Number(event.currentTarget.dataset.priority) });
  },

  choosePlanPriority(event) {
    this.setData({ planPriority: Number(event.currentTarget.dataset.priority) });
  },

  saveOccurrenceOverride() {
    try {
      const item = this.data.editor;
      getService().overrideOccurrence(item.ruleId, item.occurrenceStart, {
        title: this.data.editorTitle,
        startedAt: parseLocalDateTime(this.data.editorDate, this.data.editorStart),
        endedAt: parseLocalDateTime(this.data.editorDate, this.data.editorEnd),
        priority: this.data.editorPriority,
        taskId: item.taskId,
        taskNameSnapshot: item.taskNameSnapshot
      });
      this.closeOccurrenceEditor();
      showSaved('本次实例已修改');
      this.refresh();
    } catch (error) { showError(error); }
  },

  saveRuleFollowing() {
    try {
      const item = this.data.editor;
      getService().reviseRuleFollowing(item.ruleId, item.occurrenceStart, {
        startedAt: parseLocalDateTime(this.data.editorDate, this.data.editorStart),
        endedAt: parseLocalDateTime(this.data.editorDate, this.data.editorEnd),
        priority: this.data.editorPriority
      });
      this.closeOccurrenceEditor();
      showSaved('后续重复规则已修订');
      this.refresh();
    } catch (error) { showError(error); }
  },

  deleteConfirmed(event) {
    const item = event.currentTarget.dataset.item;
    wx.showModal({ title: '删除实际记录', content: '删除后这条已确认的历史记录将无法恢复。', confirmColor: '#dc2626', success: (result) => {
      if (!result.confirm) return;
      try {
        getService().deleteLog(item.id, true);
        showSaved('记录已删除');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  openLogEditor(event) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    const logCategories = this.data.categories.slice();
    if (item.categoryId && !logCategories.some((category) => category.id === item.categoryId)) {
      const category = this.categoryById && this.categoryById.get(item.categoryId);
      logCategories.push(category || {
        id: item.categoryId,
        name: item.categoryNameSnapshot || '已归档分类'
      });
    }
    const service = this.currentService || getService();
    const snapshot = this.currentSnapshot || service.snapshot();
    const planSelection = planOptionsForRange(
      service,
      snapshot,
      item.startedAt,
      item.endedAt
    );
    let currentPlan;
    const matchedIndex = findPlanAssociationIndex(planSelection.options, item);
    if (matchedIndex > 0) {
      currentPlan = { options: planSelection.options, index: matchedIndex };
    } else if (!item.calendarEventId && item.originRuleId && item.originOccurrenceId) {
      currentPlan = optionsWithSelected(planSelection.options, {
        id: `origin:${item.originRuleId}:${item.originOccurrenceId}`,
        title: `${item.originRuleSummarySnapshot || item.taskNameSnapshot || '重复计划'}（当前关联）`,
        associationType: 'current-origin',
        originRuleId: item.originRuleId,
        originOccurrenceId: item.originOccurrenceId
      });
    } else if (item.calendarEventId) {
      const calendarEvent = this.eventById && this.eventById.get(item.calendarEventId);
      currentPlan = optionsWithSelected(planSelection.options, {
        ...(calendarEvent || {
          id: item.calendarEventId,
          title: item.calendarEventSummarySnapshot || '历史计划块'
        }),
        calendarEventId: item.calendarEventId,
        associationType: 'current-event'
      });
    } else {
      currentPlan = { options: planSelection.options, index: 0 };
    }
    this.logPlanSelectionRange = planSelection.range;
    this.setData({
      logEditor: item,
      logDate: start.date,
      logStart: start.time,
      logEnd: end.time,
      logNote: item.note || '',
      logTagsText: Array.isArray(item.tags) ? item.tags.join('，') : '',
      logCategories,
      logEvents: currentPlan.options,
      logCategoryIndex: findOptionIndex(logCategories, item.categoryId),
      logEventIndex: currentPlan.index
    });
  },

  refreshLogPlanOptions() {
    try {
      const startedAt = parseLocalDateTime(this.data.logDate, this.data.logStart);
      const endedAt = parseLocalDateTime(this.data.logDate, this.data.logEnd);
      const selected = this.data.logEvents[this.data.logEventIndex];
      const service = this.currentService || getService();
      const snapshot = this.currentSnapshot || service.snapshot();
      const planSelection = planOptionsForRange(service, snapshot, startedAt, endedAt);
      const currentPlan = optionsWithSelected(planSelection.options, selected);
      this.logPlanSelectionRange = planSelection.range;
      this.setData({
        logEvents: currentPlan.options,
        logEventIndex: currentPlan.index
      });
    } catch (error) {
      // 日期和时间字段尚未形成合法区间时保留现有选项，保存时再统一提示。
    }
  },

  closeLogEditor() {
    this.setData({ logEditor: null });
  },

  saveLogEditor() {
    try {
      const item = this.data.logEditor;
      const category = this.data.logCategories[this.data.logCategoryIndex];
      const calendarEvent = this.data.logEvents[this.data.logEventIndex];
      const input = {
        startedAt: parseLocalDateTime(this.data.logDate, this.data.logStart),
        endedAt: parseLocalDateTime(this.data.logDate, this.data.logEnd),
        categoryId: category && category.id,
        note: this.data.logNote,
        tags: parseTags(this.data.logTagsText)
      };
      Object.assign(input, associationInput(calendarEvent));
      getService().updateLog(item.id, input);
      this.closeLogEditor();
      showSaved(item.type === 'candidate' ? '候选已编辑并确认' : '记录已更新');
      this.refresh();
    } catch (error) { showError(error); }
  }
});
