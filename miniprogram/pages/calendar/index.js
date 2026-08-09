const { MAX_TAGS_PER_LOG } = require('../../domain/constants');
const { parseLocalDateTime } = require('../../domain/time');
const { normalizeTags } = require('../../domain/tags');
const { limitTitleCodePoints } = require('../../domain/validation');
const { resolveEditedTimestamp, timePickerState } = require('../../utils/log-time-editor');
const { rangeForView, shiftAnchor } = require('../../utils/date-range');
const {
  buildCalendarBlocks,
  buildTimeRows,
  currentTimeLinePosition,
  defaultPlanDate,
  formatRangeLabel
} = require('../../utils/calendar-grid');
const {
  defaultDateTime,
  formatDateTime,
  getService,
  showError,
  showSaved,
  writeRecentLogHighlight
} = require('../../utils/page');

const FREQUENCY_VALUES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = ['每日', '每周', '每月'];
const DAY_MS = 24 * 60 * 60 * 1_000;
const PLAN_WINDOW_PADDING_MS = DAY_MS;
const MAX_PLAN_WINDOW_MS = 3 * DAY_MS;
const PAGE_TURN_DURATION_MS = 280;
const PAGE_TURN_SWAP_MS = PAGE_TURN_DURATION_MS / 2;
const CURRENT_TIME_TICK_MS = 60 * 1_000;
const GESTURE_DIRECTION_THRESHOLD_PX = 12;
const CREATE_TASK_OPTION_ID = '__create_same_title_task__';
const CREATED_PLAN_VISIBLE_EDGE_PX = 8;
const CREATED_PLAN_VISIBLE_BOTTOM_INSET_PX = 72;
const TASK_OPTION_ROW_HEIGHT_RPX = 96;
const TASK_OPTION_GAP_RPX = 12;
const TASK_PICKER_MAX_LIST_HEIGHT_RPX = 600;

function calendarBlockDomId(id) {
  return `calendar-block-${String(id || '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function createdPlanEvent(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.event && typeof result.event === 'object') return result.event;
  return Number.isFinite(result.startedAt) && Number.isFinite(result.endedAt)
    ? result
    : null;
}

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
        optionType: 'task',
        derivedProjectName: (projectById.get(item.projectId) || {}).title
          || '未关联项目'
      }))
  );
}

function taskPickerListHeight(options) {
  const optionCount = (options || []).filter((item) => item && item.id).length;
  if (!optionCount) return 0;
  return Math.min(
    TASK_PICKER_MAX_LIST_HEIGHT_RPX,
    optionCount * TASK_OPTION_ROW_HEIGHT_RPX + (optionCount - 1) * TASK_OPTION_GAP_RPX
  );
}

function createPlanTaskOptions(snapshot) {
  const options = taskOptions(snapshot);
  options.splice(1, 0, {
    id: CREATE_TASK_OPTION_ID,
    title: '新建同名任务',
    optionType: 'create',
    derivedProjectName: '未关联项目'
  });
  return options;
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
    title: '计划外（不关联计划块）',
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

function secondTimeValue(value) {
  return /^\d{2}:\d{2}$/.test(value || '') ? `${value}:00` : value;
}

function resolveLogTimestamp(originalTimestamp, edited, date, time) {
  return resolveEditedTimestamp({
    originalTimestamp,
    edited,
    date,
    time: secondTimeValue(time)
  });
}

function overlapLabel(overlapMeta) {
  if (!overlapMeta || !overlapMeta.totalCount) return '';
  const counts = [];
  if (overlapMeta.confirmedCount > 0) counts.push(`实际 ${overlapMeta.confirmedCount} 条`);
  if (overlapMeta.candidateCount > 0) counts.push(`候选 ${overlapMeta.candidateCount} 条`);
  return counts.length ? `与其他记录重叠：${counts.join('、')}` : '';
}

Page({
  data: {
    view: 'day',
    anchor: Date.now(),
    rangeLabel: '',
    timeRows: [],
    canvasHeight: 0,
    calendarScrollTop: 0,
    calendarScrollWithAnimation: false,
    scrollIntoView: '',
    rangeIncludesToday: false,
    currentTimeLineStyle: '',
    pageTurnClass: '',
    maxTagsPerLog: MAX_TAGS_PER_LOG,
    timeline: [],
    detailItem: null,
    isCreateOpen: false,
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
    editorMode: 'occurrence',
    tasks: [],
    hasAnyTasks: false,
    hasTaskOptions: false,
    taskIndex: 0,
    planFormTasks: [],
    planFormTaskIndex: 0,
    isTaskPickerOpen: false,
    taskPickerListHeight: 0,
    editor: null,
    editorTitle: '',
    editorDate: '',
    editorStart: '',
    editorEnd: '',
    editorPriority: 1,
    logEditor: null,
    logStartDate: '',
    logStartTimeValue: '',
    logStartTimeEdited: false,
    logEndDate: '',
    logEndTimeValue: '',
    logEndTimeEdited: false,
    logPausedDurationSeconds: 0,
    logNote: '',
    logTags: [],
    logTagInputVisible: false,
    planEditor: null,
    planTasks: [],
    logEvents: [],
    logEventIndex: 0,
    views: ['year', 'month', 'week', 'day'],
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
    this.startCurrentTimeTicker();
  },

  onHide() {
    this.stopCurrentTimeTicker();
  },

  onUnload() {
    clearTimeout(this.pageTurnSwapTimer);
    clearTimeout(this.pageTurnEndTimer);
    clearTimeout(this.createdPlanScrollVerifyTimer);
    this.stopCurrentTimeTicker();
  },

  refresh(afterRefresh) {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      const range = rangeForView(this.data.anchor, this.data.view);
      const now = Date.now();
      const knownTaskIds = new Set(snapshot.tasks.map((item) => item.id));
      const tasks = createPlanTaskOptions(snapshot);
      const planTasks = taskOptions(snapshot);
      const selectedTaskId = this.data.tasks[this.data.taskIndex] && this.data.tasks[this.data.taskIndex].id;
      const projectById = new Map(snapshot.projects.map((item) => [item.id, item]));
      this.taskById = new Map(snapshot.tasks.map((item) => [item.id, {
        ...item,
        derivedProjectName: (projectById.get(item.projectId) || {}).title
          || (item.status === 'completed' ? item.projectNameSnapshot : null)
          || '未关联项目'
      }]));
      const rawTimeline = service.timeline(range.start, range.end).map((item) => {
        const canAssociate = knownTaskIds.has(item.taskId);
        const task = this.taskById.get(item.taskId);
        return {
          ...item,
          displayTime: `${formatDateTime(item.startedAt)} – ${formatDateTime(item.endedAt)}`,
          displayKind: item.virtual
            ? '重复计划·待确认'
            : item.type === 'candidate'
              ? '候选记录'
              : item.type === 'plan'
                ? '计划'
                : '实际记录',
          displayOverlap: overlapLabel(item.overlapMeta),
          displayTaskName: (task && task.title) || item.taskNameSnapshot || '',
          displayProjectName: (task && task.derivedProjectName !== '未关联项目'
            ? task.derivedProjectName
            : '') || item.projectNameSnapshot || '',
          displayTags: Array.isArray(item.tags) ? item.tags.join('、') : '',
          displayPriority: item.priority || null,
          priority: item.priority || 1,
          canAssociate,
          canEditPlan: item.type === 'plan'
            && !item.virtual
            && (canAssociate || item.endedAt > now)
        };
      });
      const grid = buildTimeRows(range, this.data.view);
      const currentTimeTop = currentTimeLinePosition(now, range, grid);
      const timeline = buildCalendarBlocks(rawTimeline, range, this.data.view, grid).map((item) => ({
        ...item,
        domId: calendarBlockDomId(item.renderKey || item.id),
        ariaLabel: item.isAggregate
          ? `${item.title}，点击查看被聚合的重叠条目`
          : `${item.displayKind}，${item.title}，${item.displayTime}`
      }));
      this.eventById = new Map(snapshot.calendarEvents.map((item) => [item.id, item]));
      this.currentSnapshot = snapshot;
      this.currentService = service;
      this.setData({
        tasks,
        planTasks,
        hasAnyTasks: snapshot.tasks.length > 0,
        hasTaskOptions: planTasks.length > 1,
        taskIndex: findOptionIndex(tasks, selectedTaskId),
        timeline,
        timeRows: grid.rows,
        canvasHeight: grid.canvasHeight,
        rangeLabel: formatRangeLabel(range, this.data.view),
        rangeIncludesToday: now >= range.start && now <= range.end,
        currentTimeLineStyle: currentTimeTop === null ? '' : `top: ${currentTimeTop.toFixed(2)}rpx;`
      }, () => {
        if (typeof afterRefresh === 'function') afterRefresh();
      });
    } catch (error) {
      showError(error);
    }
  },

  changeView(event) {
    const view = event.currentTarget.dataset.view;
    if (view === this.data.view) return;
    this.cancelPageTurn();
    if (!this.viewScrollTops) this.viewScrollTops = {};
    const hasSavedScrollTop = Object.prototype.hasOwnProperty.call(this.viewScrollTops, view);
    const calendarScrollTop = this.viewScrollTops[view] || 0;
    this.currentCalendarScrollTop = calendarScrollTop;
    this.setData({
      view,
      calendarScrollTop,
      calendarScrollWithAnimation: false,
      scrollIntoView: ''
    }, () => {
      this.refresh();
      if (!hasSavedScrollTop) this.focusCurrentHour();
    });
  },

  moveRange(event) {
    this.animateRangeChange(Number(event.currentTarget.dataset.offset));
  },

  goToday() {
    this.cancelPageTurn();
    this.currentCalendarScrollTop = 0;
    if (!this.viewScrollTops) this.viewScrollTops = {};
    this.viewScrollTops[this.data.view] = 0;
    this.setData({
      anchor: Date.now(),
      calendarScrollTop: 0,
      calendarScrollWithAnimation: false,
      scrollIntoView: ''
    }, () => {
      this.refresh();
      this.focusCurrentHour();
    });
  },

  focusCurrentHour() {
    if (this.data.view !== 'day') return;
    const now = new Date();
    const anchor = new Date(this.data.anchor);
    if (now.getFullYear() !== anchor.getFullYear()
      || now.getMonth() !== anchor.getMonth()
      || now.getDate() !== anchor.getDate()) return;
    this.setData({ scrollIntoView: '' }, () => {
      this.setData({ scrollIntoView: `calendar-time-row-${Math.max(0, now.getHours() - 1)}` });
    });
  },

  refreshCurrentTimeLine(now = Date.now()) {
    const range = rangeForView(this.data.anchor, this.data.view);
    const grid = buildTimeRows(range, this.data.view);
    const top = currentTimeLinePosition(now, range, grid);
    const currentTimeLineStyle = top === null ? '' : `top: ${top.toFixed(2)}rpx;`;
    const rangeIncludesToday = now >= range.start && now <= range.end;
    if (currentTimeLineStyle !== this.data.currentTimeLineStyle
      || rangeIncludesToday !== this.data.rangeIncludesToday) {
      this.setData({ currentTimeLineStyle, rangeIncludesToday });
    }
  },

  startCurrentTimeTicker() {
    this.stopCurrentTimeTicker();
    const now = Date.now();
    const delay = CURRENT_TIME_TICK_MS - (now % CURRENT_TIME_TICK_MS) + 20;
    this.currentTimeLineTimer = setTimeout(() => {
      this.currentTimeLineTimer = null;
      this.refreshCurrentTimeLine();
      this.startCurrentTimeTicker();
    }, delay);
  },

  stopCurrentTimeTicker() {
    clearTimeout(this.currentTimeLineTimer);
    this.currentTimeLineTimer = null;
  },

  onCanvasScroll(event) {
    if (!this.viewScrollTops) this.viewScrollTops = {};
    this.currentCalendarScrollTop = event.detail.scrollTop;
    this.viewScrollTops[this.data.view] = this.currentCalendarScrollTop;
  },

  applyCreatedPlanScroll(eventId, targetScrollTop) {
    const updates = {
      calendarScrollWithAnimation: true,
      scrollIntoView: calendarBlockDomId(eventId)
    };
    if (Number.isFinite(targetScrollTop)) {
      updates.calendarScrollTop = targetScrollTop;
      this.currentCalendarScrollTop = targetScrollTop;
      if (!this.viewScrollTops) this.viewScrollTops = {};
      this.viewScrollTops[this.data.view] = targetScrollTop;
    }
    this.setData({ scrollIntoView: '' }, () => this.setData(updates));
  },

  scrollCreatedPlanIntoView(eventId, verifyAttempt = 0) {
    if (!eventId) return;
    if (verifyAttempt === 0) {
      clearTimeout(this.createdPlanScrollVerifyTimer);
      this.createdPlanScrollVerifyTimer = null;
    }
    if (typeof wx === 'undefined' || typeof wx.createSelectorQuery !== 'function') {
      this.applyCreatedPlanScroll(eventId);
      return;
    }
    const query = wx.createSelectorQuery();
    query.select('.calendar-scroll').boundingClientRect();
    query.select(`#${calendarBlockDomId(eventId)}`).boundingClientRect();
    query.exec((rects) => {
      const viewport = rects && rects[0];
      const block = rects && rects[1];
      if (!viewport || !block) {
        this.applyCreatedPlanScroll(eventId);
        if (verifyAttempt === 0) {
          this.createdPlanScrollVerifyTimer = setTimeout(() => {
            this.createdPlanScrollVerifyTimer = null;
            this.scrollCreatedPlanIntoView(eventId, 1);
          }, PAGE_TURN_DURATION_MS + 80);
        }
        return;
      }
      const viewportBottom = Number.isFinite(viewport.bottom)
        ? viewport.bottom
        : viewport.top + viewport.height;
      const blockBottom = Number.isFinite(block.bottom)
        ? block.bottom
        : block.top + block.height;
      const visibleTop = viewport.top + CREATED_PLAN_VISIBLE_EDGE_PX;
      const visibleBottom = viewportBottom - CREATED_PLAN_VISIBLE_BOTTOM_INSET_PX;
      if (block.top >= visibleTop && blockBottom <= visibleBottom) return;

      const currentScrollTop = Number.isFinite(this.currentCalendarScrollTop)
        ? this.currentCalendarScrollTop
        : (this.viewScrollTops && this.viewScrollTops[this.data.view]) || 0;
      const targetScrollTop = Math.max(
        0,
        currentScrollTop + block.top - viewport.top
          - Math.max(0, (viewport.height - block.height) / 2)
      );
      this.applyCreatedPlanScroll(eventId, targetScrollTop);
      if (verifyAttempt === 0) {
        this.createdPlanScrollVerifyTimer = setTimeout(() => {
          this.createdPlanScrollVerifyTimer = null;
          this.scrollCreatedPlanIntoView(eventId, 1);
        }, PAGE_TURN_DURATION_MS + 80);
      }
    });
  },

  revealCreatedPlan(event) {
    if (!event) {
      this.refresh();
      return;
    }
    const range = rangeForView(this.data.anchor, this.data.view);
    const isInCurrentRange = event.endedAt > range.start && event.startedAt <= range.end;
    const revealAfterRefresh = () => {
      const reveal = () => this.scrollCreatedPlanIntoView(event.id);
      if (typeof wx !== 'undefined' && typeof wx.nextTick === 'function') {
        wx.nextTick(reveal);
      } else {
        reveal();
      }
    };
    if (isInCurrentRange) {
      this.refresh(revealAfterRefresh);
      return;
    }

    this.cancelPageTurn();
    this.currentCalendarScrollTop = 0;
    if (!this.viewScrollTops) this.viewScrollTops = {};
    this.viewScrollTops[this.data.view] = 0;
    this.setData({
      anchor: event.startedAt,
      calendarScrollTop: 0,
      calendarScrollWithAnimation: false,
      scrollIntoView: ''
    }, () => this.refresh(revealAfterRefresh));
  },

  onCanvasTouchStart(event) {
    const touch = event.touches && event.touches[0];
    this.canvasTouchStart = touch
      ? { x: touch.clientX, y: touch.clientY, direction: null }
      : null;
  },

  onCanvasTouchMove(event) {
    const start = this.canvasTouchStart;
    const touch = event.touches && event.touches[0];
    if (!start || !touch || start.direction) return;
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < GESTURE_DIRECTION_THRESHOLD_PX) return;
    start.direction = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical';
  },

  onCanvasTouchEnd(event) {
    const start = this.canvasTouchStart;
    const touch = event.changedTouches && event.changedTouches[0];
    this.canvasTouchStart = null;
    if (!start || !touch) return;
    const deltaX = touch.clientX - start.x;
    if (start.direction !== 'horizontal' || Math.abs(deltaX) < 48) return;
    this.animateRangeChange(deltaX < 0 ? 1 : -1);
  },

  onCanvasTouchCancel() {
    this.canvasTouchStart = null;
  },

  cancelPageTurn() {
    clearTimeout(this.pageTurnSwapTimer);
    clearTimeout(this.pageTurnEndTimer);
    this.pageTurnSwapTimer = null;
    this.pageTurnEndTimer = null;
    if (this.data.pageTurnClass) this.setData({ pageTurnClass: '' });
  },

  animateRangeChange(offset) {
    if (!offset || this.pageTurnEndTimer) return;
    const targetAnchor = shiftAnchor(this.data.anchor, this.data.view, offset);
    const pageTurnClass = offset > 0 ? 'page-turn-next' : 'page-turn-previous';
    this.setData({ pageTurnClass });
    this.pageTurnSwapTimer = setTimeout(() => {
      this.pageTurnSwapTimer = null;
      this.setData({ anchor: targetAnchor }, () => this.refresh());
    }, PAGE_TURN_SWAP_MS);
    this.pageTurnEndTimer = setTimeout(() => {
      this.pageTurnEndTimer = null;
      this.setData({ pageTurnClass: '' });
    }, PAGE_TURN_DURATION_MS);
  },

  openItemDetail(event) {
    this.setData({ detailItem: event.currentTarget.dataset.item });
  },

  closeItemDetail() {
    this.setData({ detailItem: null });
  },

  openCreatePlan() {
    const now = Date.now();
    const start = defaultDateTime(now + 60 * 60 * 1000);
    const end = defaultDateTime(now + 2 * 60 * 60 * 1000);
    const date = defaultPlanDate(this.data.anchor, now);
    const wrapsDay = end.time <= start.time;
    this.setData({
      isCreateOpen: true,
      planEditor: null,
      planFormTasks: this.data.tasks.slice(),
      planFormTaskIndex: this.data.taskIndex,
      isTaskPickerOpen: false,
      title: '',
      startDate: date,
      endDate: date,
      startTime: wrapsDay ? '09:00' : start.time,
      endTime: wrapsDay ? '10:00' : end.time,
      priority: 1,
      repeatEnabled: false,
      frequencyIndex: 0,
      interval: '1',
      repeatWeekdays: []
    });
  },

  closeCreatePlan() {
    this.setData({ isCreateOpen: false, isTaskPickerOpen: false, planEditor: null });
  },

  openTaskPicker() {
    this.setData({
      isTaskPickerOpen: true,
      taskPickerListHeight: taskPickerListHeight(this.data.planFormTasks)
    });
  },

  closeTaskPicker() {
    this.setData({ isTaskPickerOpen: false });
  },

  chooseTaskOption(event) {
    const planFormTaskIndex = Number(event.currentTarget.dataset.index);
    this.setData({
      planFormTaskIndex,
      ...(!this.data.planEditor ? { taskIndex: planFormTaskIndex } : {}),
      isTaskPickerOpen: false
    });
  },

  onField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onTitleField(event) {
    this.setData({ [event.currentTarget.dataset.key]: limitTitleCodePoints(event.detail.value) });
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

  submitPlanForm() {
    if (this.data.planEditor) {
      this.savePlanEditor();
      return;
    }
    this.createPlan();
  },

  createPlan() {
    try {
      const startedAt = parseLocalDateTime(this.data.startDate, this.data.startTime);
      const endedAt = parseLocalDateTime(this.data.endDate, this.data.endTime);
      const service = getService();
      const formTasks = this.data.planFormTasks.length ? this.data.planFormTasks : this.data.tasks;
      const formTaskIndex = this.data.planFormTasks.length ? this.data.planFormTaskIndex : this.data.taskIndex;
      const task = formTasks[formTaskIndex];
      const shouldCreateTask = !this.data.hasAnyTasks
        || (task && task.optionType === 'create');
      if (!shouldCreateTask && (!task || !task.id)) {
        throw new Error('请选择任务');
      }
      const input = {
        title: this.data.title,
        startedAt,
        endedAt,
        priority: this.data.priority,
        ...(shouldCreateTask ? {} : { taskId: task.id })
      };
      let result;
      if (this.data.repeatEnabled) {
        input.frequency = FREQUENCY_VALUES[this.data.frequencyIndex];
        input.interval = Number(this.data.interval);
        input.weekdays = this.data.repeatWeekdays.length ? this.data.repeatWeekdays : [new Date(startedAt).getDay()];
        input.monthDay = new Date(startedAt).getDate();
        if (shouldCreateTask) {
          result = service.createRecurringPlanWithNewTask(input);
        } else {
          result = service.createRecurringPlan(input);
        }
        showSaved('固定日程已创建');
      } else {
        if (shouldCreateTask) {
          result = service.createCalendarEventWithNewTask(input);
        } else {
          result = service.createCalendarEvent(input);
        }
        showSaved('计划块已创建');
      }
      const event = createdPlanEvent(result);
      this.setData({
        title: '',
        repeatEnabled: false,
        repeatWeekdays: [],
        isCreateOpen: false,
        isTaskPickerOpen: false,
        planEditor: null
      }, () => this.revealCreatedPlan(event));
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
      this.closeItemDetail();
      showSaved('已从计划块开始计时');
      wx.switchTab({ url: '/pages/timer/index' });
    } catch (error) {
      showError(error);
    }
  },

  confirmItem(event) {
    try {
      const item = event.currentTarget.dataset.item;
      const service = getService();
      const log = item.virtual
        ? service.confirmVirtualOccurrence(item)
        : service.confirmCandidateLog(item.id);
      writeRecentLogHighlight(this.currentSnapshot, log && log.id);
      this.closeItemDetail();
      showSaved(item.virtual ? '重复计划已确认' : '候选记录已确认');
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
        getService().deleteLog(item.id, true);
        this.closeItemDetail();
        showSaved('候选已作废');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  skipVirtualOccurrence(event) {
    const item = event.currentTarget.dataset.item;
    wx.showModal({ title: '跳过重复计划', content: '跳过后本次重复计划不会再出现。', success: (result) => {
      if (!result.confirm) return;
      try {
        getService().skipOccurrence(item.ruleId, item.occurrenceStart);
        this.closeItemDetail();
        showSaved('本次重复计划已跳过');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  openPlanEditor(event) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    const planTasks = this.data.planTasks.slice();
    const existingTask = this.taskById && this.taskById.get(item.taskId);
    if (existingTask && !planTasks.some((task) => task.id === existingTask.id)) {
      planTasks.push({ ...existingTask, optionType: 'task' });
    }
    const planTaskIndex = existingTask
      ? findOptionIndex(planTasks, existingTask.id)
      : 0;
    this.setData({
      detailItem: null,
      isCreateOpen: true,
      isTaskPickerOpen: false,
      planEditor: item,
      title: item.title,
      startDate: start.date,
      startTime: start.time,
      endDate: end.date,
      endTime: end.time,
      priority: item.priority,
      repeatEnabled: false,
      planFormTasks: planTasks,
      planFormTaskIndex: planTaskIndex
    });
  },

  savePlanEditor() {
    try {
      const item = this.data.planEditor;
      const task = this.data.planFormTasks[this.data.planFormTaskIndex];
      if (!task || !task.id || !this.taskById || !this.taskById.has(task.id)) {
        throw new Error('请选择任务');
      }
      getService().updateCalendarEvent(item.id, {
        title: this.data.title,
        startedAt: parseLocalDateTime(this.data.startDate, this.data.startTime),
        endedAt: parseLocalDateTime(this.data.endDate, this.data.endTime),
        priority: this.data.priority,
        taskId: task.id
      });
      this.closeCreatePlan();
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
      confirmColor: '#9a5550',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().deleteCalendarEvent(item.id, true);
          this.closeItemDetail();
          showSaved('计划块已删除');
          this.refresh();
        } catch (error) { showError(error); }
      }
    });
  },

  openOccurrenceEditorWithMode(event, editorMode) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    this.setData({
      detailItem: null,
      editor: item,
      editorMode,
      editorTitle: item.title,
      editorDate: start.date,
      editorStart: start.time,
      editorEnd: end.time,
      editorPriority: item.priority
    });
  },

  openOccurrenceEditor(event) {
    this.openOccurrenceEditorWithMode(event, 'occurrence');
  },

  openRuleFollowingEditor(event) {
    this.openOccurrenceEditorWithMode(event, 'following');
  },

  closeOccurrenceEditor() {
    this.setData({ editor: null, editorMode: 'occurrence' });
  },

  onEditorField(event) {
    const key = event.currentTarget.dataset.key;
    const legacyLogFields = {
      logDate: ['logStartDate', 'logEndDate'],
      logStart: ['logStartTimeValue'],
      logEnd: ['logEndTimeValue']
    };
    const targetKeys = legacyLogFields[key] || [key];
    const updates = {};
    targetKeys.forEach((targetKey) => {
      updates[targetKey] = targetKey.includes('TimeValue')
        ? secondTimeValue(event.detail.value)
        : event.detail.value;
    });
    if (key === 'logDate' || key === 'logStart') updates.logStartTimeEdited = true;
    if (key === 'logDate' || key === 'logEnd') updates.logEndTimeEdited = true;
    this.setData(updates, () => {
      if (this.data.logEditor && legacyLogFields[key]) {
        this.refreshLogPlanOptions();
      }
    });
  },

  onLogDateChange(event) {
    const { key, editedKey } = event.currentTarget.dataset;
    this.setData({ [key]: event.detail.value, [editedKey]: true }, () => {
      this.refreshLogPlanOptions();
    });
  },

  onLogTimeChange(event) {
    const { key, editedKey } = event.currentTarget.dataset;
    this.setData({ [key]: event.detail.value, [editedKey]: true }, () => {
      this.refreshLogPlanOptions();
    });
  },

  onLogPausedDurationChange(event) {
    this.setData({ logPausedDurationSeconds: event.detail.value });
  },

  chooseEditorPriority(event) {
    this.setData({ editorPriority: Number(event.currentTarget.dataset.priority) });
  },

  submitOccurrenceEditor() {
    if (this.data.editorMode === 'following') {
      this.saveRuleFollowing();
      return;
    }
    this.saveOccurrenceOverride();
  },

  saveOccurrenceOverride() {
    try {
      const item = this.data.editor;
      const result = getService().overrideOccurrence(item.ruleId, item.occurrenceStart, {
        title: this.data.editorTitle,
        startedAt: parseLocalDateTime(this.data.editorDate, this.data.editorStart),
        endedAt: parseLocalDateTime(this.data.editorDate, this.data.editorEnd),
        priority: this.data.editorPriority,
        taskId: item.taskId,
        taskNameSnapshot: item.taskNameSnapshot
      });
      writeRecentLogHighlight(this.currentSnapshot, result && result.log && result.log.id);
      this.closeOccurrenceEditor();
      showSaved('本次实例已修改并确认');
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
    wx.showModal({ title: '删除实际记录', content: '删除后这条记录将无法恢复。', confirmColor: '#9a5550', success: (result) => {
      if (!result.confirm) return;
      try {
        getService().deleteLog(item.id, true);
        this.closeItemDetail();
        showSaved('记录已删除');
        this.refresh();
      } catch (error) { showError(error); }
    } });
  },

  openLogEditor(event) {
    const item = event.currentTarget.dataset.item;
    const start = defaultDateTime(item.startedAt);
    const end = defaultDateTime(item.endedAt);
    const originalTags = Array.isArray(item.tags) ? item.tags.slice() : [];
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
    this.logOriginalStartedAt = item.startedAt;
    this.logOriginalEndedAt = item.endedAt;
    this.setData({
      detailItem: null,
      logEditor: item,
      logStartDate: start.date,
      logStartTimeValue: timePickerState(item.startedAt).value,
      logStartTimeEdited: false,
      logEndDate: end.date,
      logEndTimeValue: timePickerState(item.endedAt).value,
      logEndTimeEdited: false,
      logPausedDurationSeconds: item.pausedDurationSeconds || 0,
      logNote: item.note || '',
      logTags: originalTags,
      logTagInputVisible: false,
      logEvents: currentPlan.options,
      logEventIndex: currentPlan.index
    });
  },

  refreshLogPlanOptions() {
    try {
      const startedAt = resolveLogTimestamp(
        this.logOriginalStartedAt,
        this.data.logStartTimeEdited,
        this.data.logStartDate,
        this.data.logStartTimeValue
      );
      const endedAt = resolveLogTimestamp(
        this.logOriginalEndedAt,
        this.data.logEndTimeEdited,
        this.data.logEndDate,
        this.data.logEndTimeValue
      );
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
    this.logOriginalStartedAt = null;
    this.logOriginalEndedAt = null;
    this.setData({
      logEditor: null,
      logStartTimeEdited: false,
      logEndTimeEdited: false
    });
  },

  openTagInput(event) {
    this.setData({ [event.currentTarget.dataset.inputVisibleKey]: true });
  },

  addTag(event) {
    const { tagsKey, inputVisibleKey } = event.currentTarget.dataset;
    if (!this.data[inputVisibleKey]) return;
    try {
      const tag = normalizeTags([event.detail.value])[0];
      if (!tag) {
        this.setData({ [inputVisibleKey]: false });
        return;
      }
      const currentTags = this.data[tagsKey] || [];
      if (currentTags.includes(tag)) {
        wx.showToast({ title: '标签已存在', icon: 'none' });
        return;
      }
      this.setData({
        [tagsKey]: normalizeTags(currentTags.concat(tag)),
        [inputVisibleKey]: false
      });
    } catch (error) {
      showError(error);
    }
  },

  onTagInputBlur(event) {
    if (String(event.detail.value || '').trim()) {
      this.addTag(event);
      return;
    }
    this.setData({ [event.currentTarget.dataset.inputVisibleKey]: false });
  },

  removeTag(event) {
    const { tagsKey } = event.currentTarget.dataset;
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [tagsKey]: (this.data[tagsKey] || []).filter((_, itemIndex) => itemIndex !== index) });
  },

  saveLogEditor() {
    try {
      const item = this.data.logEditor;
      const calendarEvent = this.data.logEvents[this.data.logEventIndex];
      const input = {
        startedAt: resolveLogTimestamp(
          this.logOriginalStartedAt,
          this.data.logStartTimeEdited,
          this.data.logStartDate,
          this.data.logStartTimeValue
        ),
        endedAt: resolveLogTimestamp(
          this.logOriginalEndedAt,
          this.data.logEndTimeEdited,
          this.data.logEndDate,
          this.data.logEndTimeValue
        ),
        pausedDurationSeconds: this.data.logPausedDurationSeconds,
        note: this.data.logNote,
        tags: this.data.logTags.slice()
      };
      Object.assign(input, associationInput(calendarEvent));
      const result = getService().updateLog(item.id, input);
      if (item.type === 'candidate') {
        writeRecentLogHighlight(this.currentSnapshot, (result && result.log && result.log.id) || item.id);
      }
      this.closeLogEditor();
      showSaved(item.type === 'candidate' ? '候选已编辑并确认' : '记录已更新');
      this.refresh();
    } catch (error) { showError(error); }
  },

  noop() {
  }
});
