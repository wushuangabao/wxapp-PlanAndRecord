const {
  MAX_TAGS_PER_LOG,
  MAX_TAG_LENGTH,
  TIMER_STATUS
} = require('../../domain/constants');
const { normalizeTags } = require('../../domain/tags');
const { calculateTimerDurationMinutes, parseLocalDateTime, sumPausedMilliseconds } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, showError, showSaved } = require('../../utils/page');

const DAY_MS = 24 * 60 * 60 * 1_000;
const PLAN_WINDOW_PADDING_MS = DAY_MS;
const MAX_PLAN_WINDOW_MS = 3 * DAY_MS;
const RECENT_SWIPE_DISTANCE_RATIO = 0.15;
const RECENT_SWIPE_DISTANCE_FALLBACK = 36;
const RECENT_RETURN_ANIMATION_DURATION = 600;
const RECENT_SNAP_ANIMATION_DURATION = 420;
const RECENT_RETURN_ANIMATION_FRAME = 16;
const RECENT_BOUNDARY_PULL_RESISTANCE = 0.45;
const RECENT_BOUNDARY_MAX_OFFSET = 72;

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

function clampRecentColumnIndex(index, columnCount) {
  if (columnCount <= 0) return 0;
  return Math.max(0, Math.min(index, columnCount - 1));
}

function recentSwipeDistance(columnStep) {
  return columnStep > 0 ? columnStep * RECENT_SWIPE_DISTANCE_RATIO : RECENT_SWIPE_DISTANCE_FALLBACK;
}

function easeOutCubic(progress) {
  return 1 - Math.pow(1 - progress, 3);
}

function easeOutBack(progress) {
  const overshoot = 1.3;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * Math.pow(shifted, 3) + overshoot * Math.pow(shifted, 2);
}

function isDevelopmentRuntime() {
  if (typeof wx === 'undefined' || typeof wx.getAccountInfoSync !== 'function') return false;
  const accountInfo = wx.getAccountInfoSync();
  return Boolean(accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion === 'develop');
}

function displayRecoveryDraftReason(reason) {
  const legacyReasons = {
    '时间戳无法还原，请手工修正后再创建候选记录': '时间戳无法还原，请手工修正并确认记录',
    '可恢复时间无效，请手工修正后再创建候选记录': '可恢复时间无效，请手工修正并确认记录'
  };
  return legacyReasons[reason] || reason;
}

function touchPageX(event, field) {
  const touch = event && event[field] && event[field][0];
  return touch && Number.isFinite(touch.pageX) ? touch.pageX : null;
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

Page({
  data: {
    timer: { status: TIMER_STATUS.IDLE },
    elapsed: '00:00:00',
    elapsedMinutes: 0,
    statusLabel: '准备开始',
    primaryLabel: '开始记录',
    maxTagsPerLog: MAX_TAGS_PER_LOG,
    maxTagLength: MAX_TAG_LENGTH,
    events: [],
    eventIndex: 0,
    note: '',
    tags: [],
    tagInputVisible: false,
    showManual: false,
    manualStartDate: '',
    manualStartTime: '',
    manualEndDate: '',
    manualEndTime: '',
    manualNote: '',
    manualTags: [],
    manualTagInputVisible: false,
    manualEvents: [],
    manualEventIndex: 0,
    manualMode: 'manual',
    recoveryDraft: null,
    recentLogs: [],
    recentColumnIndex: 0,
    recentColumnStep: 0,
    recentScrollLeft: 0,
    recentScrollWithAnimation: true,
    recentScrollEnabled: true,
    recentBoundaryOffset: 0,
    recentBoundaryIsDragging: false,
    showDebugTools: false,
    debugPanelExpanded: false,
    debugPanelDock: 'right'
  },

  onLoad() {
    const end = defaultDateTime();
    const start = defaultDateTime(Date.now() - 60 * 60 * 1000);
    this.setData({
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualEndDate: end.date,
      manualEndTime: end.time,
      showDebugTools: isDevelopmentRuntime()
    });
  },

  onShow() {
    this.refresh();
  },

  onReady() {
    this.measureRecentColumn();
  },

  onHide() {
    this.stopTicker();
    if (!this.data.recentScrollEnabled) this.setData({ recentScrollEnabled: true });
  },

  onUnload() {
    this.stopTicker();
    this.clearRecentScrollAnimation();
  },

  onDebugDockTouchStart(event) {
    this.debugDockStartX = touchPageX(event, 'touches');
    this.debugDockSuppressTap = false;
  },

  onDebugDockTouchEnd(event) {
    const startX = this.debugDockStartX;
    const endX = touchPageX(event, 'changedTouches');
    this.debugDockStartX = null;
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || Math.abs(endX - startX) < 24) return;
    this.debugDockSuppressTap = true;
    this.setData({
      debugPanelDock: endX > startX ? 'left' : 'right',
      debugPanelExpanded: false
    });
  },

  toggleDebugPanel() {
    if (this.debugDockSuppressTap) {
      this.debugDockSuppressTap = false;
      return;
    }
    this.setData({ debugPanelExpanded: !this.data.debugPanelExpanded });
  },

  onDebugTimerFailure() {
    if (!this.data.showDebugTools) return;
    try {
      getService().simulateTimerRecoveryFailureForDebug();
      this.setData({ debugPanelExpanded: false });
      this.refresh();
      showSaved('已创建待修正的恢复草稿');
    } catch (error) {
      showError(error);
    }
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
      const draftTags = Array.isArray(draft.tags) ? draft.tags.slice() : [];
      const hasActiveDraft = snapshot.timer.status !== TIMER_STATUS.IDLE;
      const now = Date.now();
      const planSelection = planOptionsForRange(service, snapshot, now, now);
      const selectableEvents = planSelection.options;
      const eventById = new Map(snapshot.calendarEvents.map((item) => [item.id, item]));
      const currentEvent = this.data.events[this.data.eventIndex];
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
      this.eventById = eventById;
      this.selectableEvents = selectableEvents;
      this.currentSnapshot = snapshot;
      this.currentService = service;
      this.planSelectionRange = planSelection.range;
      const recentLogs = snapshot.timeLogs.slice(-5).reverse().map((log) => ({
        ...log,
        displayTime: `${formatDateTime(log.startedAt)} · ${log.durationMinutes} 分钟`,
        displayNote: log.note || '未命名记录',
        isCandidate: log.status === 'candidate',
        tags: Array.isArray(log.tags) ? log.tags : [],
        tagScrollLeft: 0,
        tagMaxScrollLeft: 0
      }));
      const recoveryDraft = snapshot.recoveryDraft && {
        ...snapshot.recoveryDraft,
        displayReason: displayRecoveryDraftReason(snapshot.recoveryDraft.reason)
      };
      const recentColumnIndex = clampRecentColumnIndex(this.data.recentColumnIndex, recentLogs.length);
      this.setData({
        timer: snapshot.timer,
        recoveryDraft,
        events: currentPlan.options,
        eventIndex: currentPlan.index,
        recentLogs,
        recentColumnIndex,
        recentScrollLeft: this.recentScrollAnimationId !== null && this.recentScrollAnimationId !== undefined
          ? this.data.recentScrollLeft
          : (this.data.recentColumnStep ? recentColumnIndex * this.data.recentColumnStep : 0),
        note: snapshot.timer.status === TIMER_STATUS.IDLE ? this.data.note : (draft.note || ''),
        tags: hasActiveDraft ? draftTags : this.data.tags
      }, () => {
        this.measureRecentColumn();
        this.measureRecentTagTracks();
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

  measureRecentColumn() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .selectAll('.recent-column')
      .boundingClientRect((rects) => {
        const first = rects && rects[0];
        if (!first || !first.width) return;
        const second = rects[1];
        const step = second ? second.left - first.left : first.width;
        const index = clampRecentColumnIndex(this.data.recentColumnIndex, this.data.recentLogs.length);
        this.setData({
          recentColumnStep: step,
          recentColumnIndex: index,
          recentScrollLeft: this.recentScrollAnimationId !== null && this.recentScrollAnimationId !== undefined
            ? this.data.recentScrollLeft
            : index * step
        });
      })
      .exec();
  },

  measureRecentTagTracks() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .selectAll('.recent-log-tags')
      .boundingClientRect()
      .selectAll('.recent-log-tags-content')
      .boundingClientRect()
      .exec((result) => {
        const viewportRects = Array.isArray(result && result[0]) ? result[0] : [];
        const trackRects = Array.isArray(result && result[1]) ? result[1] : [];
        const recentLogs = this.data.recentLogs.map((log, index) => {
          const viewportWidth = viewportRects[index] && viewportRects[index].width;
          const trackWidth = trackRects[index] && trackRects[index].width;
          const tagMaxScrollLeft = Math.max(0, (trackWidth || 0) - (viewportWidth || 0));
          return {
            ...log,
            tagMaxScrollLeft,
            tagScrollLeft: Math.min(Math.max(0, log.tagScrollLeft || 0), tagMaxScrollLeft)
          };
        });
        this.setData({ recentLogs });
      });
  },

  clearRecentScrollAnimation() {
    if (this.recentScrollAnimationId !== null && this.recentScrollAnimationId !== undefined) clearTimeout(this.recentScrollAnimationId);
    this.recentScrollAnimationId = null;
  },

  animateRecentScrollLeft(targetScrollLeft, options = {}) {
    this.clearRecentScrollAnimation();
    const startScrollLeft = Number.isFinite(options.startScrollLeft) ? options.startScrollLeft : this.data.recentScrollLeft;
    const duration = options.duration || RECENT_RETURN_ANIMATION_DURATION;
    const easing = options.easing || easeOutCubic;
    if (startScrollLeft === targetScrollLeft) {
      this.setData({ recentScrollLeft: targetScrollLeft, recentScrollWithAnimation: false });
      return;
    }

    const startedAt = Date.now();
    this.setData({ recentScrollLeft: startScrollLeft, recentScrollWithAnimation: false });
    const step = () => {
      const progress = Math.min(1, (Date.now() - startedAt) / duration);
      const scrollLeft = progress === 0
        ? startScrollLeft
        : startScrollLeft + (targetScrollLeft - startScrollLeft) * easing(progress);
      this.setData({ recentScrollLeft: scrollLeft });
      if (progress < 1) {
        this.recentScrollAnimationId = setTimeout(step, RECENT_RETURN_ANIMATION_FRAME);
        return;
      }
      this.recentScrollAnimationId = null;
      this.setData({ recentScrollLeft: targetScrollLeft, recentScrollWithAnimation: false });
    };
    step();
  },

  snapRecentColumn(index, currentScrollLeft) {
    this.clearRecentScrollAnimation();
    const currentIndex = clampRecentColumnIndex(this.data.recentColumnIndex, this.data.recentLogs.length);
    const nextIndex = clampRecentColumnIndex(index, this.data.recentLogs.length);
    const targetScrollLeft = this.data.recentColumnStep ? nextIndex * this.data.recentColumnStep : 0;
    this.setData({ recentColumnIndex: nextIndex });
    if (!Number.isFinite(currentScrollLeft)) {
      this.setData({ recentScrollLeft: targetScrollLeft, recentScrollWithAnimation: true });
      return;
    }
    this.animateRecentScrollLeft(targetScrollLeft, {
      startScrollLeft: currentScrollLeft,
      duration: RECENT_SNAP_ANIMATION_DURATION,
      easing: nextIndex === currentIndex ? easeOutCubic : easeOutBack
    });
  },

  onRecentTouchStart(event) {
    this.clearRecentScrollAnimation();
    if (this.data.recentBoundaryOffset || this.data.recentBoundaryIsDragging) {
      this.setData({ recentBoundaryOffset: 0, recentBoundaryIsDragging: false });
    }
    const touch = event.touches && event.touches[0];
    this.recentTouchStartX = touch ? touch.pageX : null;
    this.recentTouchStartScrollLeft = this.data.recentScrollLeft;
    this.recentScrollLeft = this.data.recentScrollLeft;
  },

  onRecentTagTouchStart(event) {
    const touch = event.touches && event.touches[0];
    const tagIndex = Number(event.currentTarget.dataset.index);
    const tagLog = this.data.recentLogs[tagIndex];
    this.recentTagTouchIndex = Number.isInteger(tagIndex) && tagLog ? tagIndex : null;
    this.recentTagTouchStartX = touch ? touch.pageX : null;
    this.recentTagTouchStartLeft = tagLog ? tagLog.tagScrollLeft || 0 : 0;
    this.setData({ recentScrollEnabled: false });
  },

  onRecentTagTouchMove(event) {
    const touch = event.touches && event.touches[0];
    const tagIndex = this.recentTagTouchIndex;
    if (!touch || tagIndex === null || tagIndex === undefined || this.recentTagTouchStartX === null || this.recentTagTouchStartX === undefined) return;
    const tagLog = this.data.recentLogs[tagIndex];
    if (!tagLog) return;
    const tagMaxScrollLeft = tagLog.tagMaxScrollLeft || 0;
    const nextScrollLeft = Math.min(
      tagMaxScrollLeft,
      Math.max(0, this.recentTagTouchStartLeft + this.recentTagTouchStartX - touch.pageX)
    );
    const recentLogs = this.data.recentLogs.map((log, index) => (
      index === tagIndex ? { ...log, tagScrollLeft: nextScrollLeft } : log
    ));
    this.setData({ recentLogs });
  },

  onRecentTagTouchEnd() {
    this.recentTagTouchIndex = null;
    this.recentTagTouchStartX = null;
    this.recentTagTouchStartLeft = 0;
    this.setData({ recentScrollEnabled: true });
  },

  onRecentTouchMove(event) {
    const touch = event.touches && event.touches[0];
    if (!touch || this.recentTouchStartX === null || this.recentTouchStartX === undefined) return;
    const dragDistance = touch.pageX - this.recentTouchStartX;
    if (this.data.recentColumnIndex !== 0 || dragDistance <= 0) {
      if (this.data.recentBoundaryOffset || this.data.recentBoundaryIsDragging) {
        this.setData({ recentBoundaryOffset: 0, recentBoundaryIsDragging: false });
      }
      return;
    }
    this.setData({
      recentBoundaryOffset: Math.min(RECENT_BOUNDARY_MAX_OFFSET, dragDistance * RECENT_BOUNDARY_PULL_RESISTANCE),
      recentBoundaryIsDragging: true
    });
  },

  onRecentScroll(event) {
    this.recentScrollLeft = event.detail.scrollLeft;
  },

  onRecentTouchEnd(event) {
    const touch = event.changedTouches && event.changedTouches[0];
    const endX = touch ? touch.pageX : null;
    const deltaX = this.recentTouchStartX === null || endX === null ? 0 : this.recentTouchStartX - endX;
    const touchStartScrollLeft = Number.isFinite(this.recentTouchStartScrollLeft)
      ? this.recentTouchStartScrollLeft
      : this.data.recentScrollLeft;
    const currentLeft = Math.max(0, touchStartScrollLeft + deltaX);
    const swipeDirection = deltaX > 0 ? 1 : -1;
    const requestedIndex = this.data.recentColumnIndex + swipeDirection;
    const isFirstColumnPull = this.data.recentColumnIndex === 0 && this.data.recentBoundaryIsDragging;
    this.recentTouchStartX = null;
    this.recentTouchStartScrollLeft = null;
    if (isFirstColumnPull) {
      this.setData({ recentBoundaryOffset: 0, recentBoundaryIsDragging: false });
      this.snapRecentColumn(this.data.recentColumnIndex);
      return;
    }
    const nextIndex = Math.abs(deltaX) >= recentSwipeDistance(this.data.recentColumnStep)
      ? requestedIndex
      : this.data.recentColumnIndex;
    this.snapRecentColumn(nextIndex, currentLeft);
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  openTagInput(event) {
    const inputVisibleKey = event.currentTarget.dataset.inputVisibleKey;
    this.setData({ [inputVisibleKey]: true });
  },

  addTag(event) {
    const { tagsKey, inputVisibleKey } = event.currentTarget.dataset;
    if (!this.data[inputVisibleKey]) return;
    try {
      const [tag] = normalizeTags([event.detail.value]);
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

  onPickerChange(event) {
    this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) });
  },

  selectedInput() {
    return {
      ...associationInput(this.data.events, this.data.eventIndex),
      note: this.data.note,
      tags: this.data.tags.slice()
    };
  },

  selectedManualInput() {
    return {
      ...associationInput(this.data.manualEvents, this.data.manualEventIndex),
      tags: this.data.manualTags.slice()
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
        this.setData({ eventIndex: 0, note: '', tags: [], tagInputVisible: false });
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
      const service = getService();
      service.updateTimerDraft(this.selectedInput());
      service.finishTimer();
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
      manualTags: [],
      manualTagInputVisible: false,
      manualEvents: currentPlan.options,
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
    const originalTags = Array.isArray(draft.tags) ? draft.tags.slice() : [];
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
      manualTags: originalTags,
      manualTagInputVisible: false,
      manualEvents: currentPlan.options,
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
        ? { log: getService().createRecoveryConfirmedLog(input), hasOverlap: false }
        : getService().createManualLog(input);
      const wasRecovery = this.data.manualMode === 'recovery';
      this.setData({
        showManual: false,
        manualMode: 'manual',
        manualNote: '',
        manualTags: [],
        manualTagInputVisible: false
      });
      showSaved(wasRecovery ? '恢复记录已确认' : (result.hasOverlap ? '已保存：存在重叠时间' : '补录已保存'));
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  noop() {
    // 阻止弹层点击穿透。
  }
});
