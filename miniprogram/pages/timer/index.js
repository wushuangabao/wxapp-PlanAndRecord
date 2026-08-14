const {
  MAX_TAGS_PER_LOG,
  TIMER_STATUS
} = require('../../domain/constants');
const { normalizeTags } = require('../../domain/tags');
const { calculateTimerDurationMinutes, sumPausedMilliseconds } = require('../../domain/time');
const { displayLogTitle } = require('../../utils/log-presentation');
const { resolveEditedTimestamp, timePickerState } = require('../../utils/log-time-editor');
const {
  defaultDateTime,
  formatDateTime,
  getService,
  readRecentLogHighlight,
  showError,
  showSaved,
  writeRecentLogHighlight
} = require('../../utils/page');

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
const TIMER_DRAFT_DEBOUNCE_MS = 300;

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

function secondTimeValue(value) {
  return /^\d{2}:\d{2}$/.test(value || '') ? `${value}:00` : value;
}

function editableTimeFields(timestamp) {
  return {
    date: defaultDateTime(timestamp).date,
    time: timePickerState(timestamp).value
  };
}

function resolvePageTimestamp(originalTimestamp, edited, date, time) {
  return resolveEditedTimestamp({
    originalTimestamp,
    edited,
    date,
    time: secondTimeValue(time)
  });
}

function originalTimestampForFields(originalTimestamp, date, time) {
  if (Number.isFinite(originalTimestamp) && originalTimestamp > 0) {
    const original = editableTimeFields(originalTimestamp);
    if (original.date === date && original.time === secondTimeValue(time)) {
      return originalTimestamp;
    }
  }
  return resolvePageTimestamp(null, true, date, time);
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

function isCandidatePreview(candidatePreview) {
  return Boolean(candidatePreview
    && Number.isFinite(candidatePreview.startedAt)
    && Number.isFinite(candidatePreview.endedAt)
    && candidatePreview.endedAt > candidatePreview.startedAt
    && Number.isInteger(candidatePreview.durationMinutes)
    && candidatePreview.durationMinutes > 0);
}

function recoveryDraftPresentation(recoveryDraft) {
  const candidatePreview = recoveryDraft && recoveryDraft.candidatePreview;
  if (isCandidatePreview(candidatePreview)) {
    return {
      displayTitle: '有一条待审核的自动恢复记录',
      displayReason: `系统候选：${formatDateTime(candidatePreview.startedAt)} 至 ${formatDateTime(candidatePreview.endedAt)}，共 ${candidatePreview.durationMinutes} 分钟。请核实后确认记录。`,
      confirmLabel: '核实并确认记录',
      discardTitle: '放弃自动恢复记录？',
      discardCopy: '将永久删除这条未审核的自动恢复记录，不会生成时间记录。'
    };
  }
  return {
    displayTitle: '有一条待修正的恢复草稿',
    displayReason: displayRecoveryDraftReason(recoveryDraft && recoveryDraft.reason),
    confirmLabel: '修正并确认记录',
    discardTitle: '放弃恢复草稿？',
    discardCopy: '将永久删除这条无法还原的计时草稿，不会生成时间记录。'
  };
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

function buildTagCandidateQueue(timeLogs, excludedLogId = null) {
  const logs = Array.isArray(timeLogs) ? timeLogs : [];
  const orderedLogs = logs
    .map((log, index) => ({ log, index }))
    .filter(({ log }) => log && log.id !== excludedLogId)
    .sort((left, right) => {
      const leftStartedAt = Number.isFinite(left.log.startedAt) ? left.log.startedAt : 0;
      const rightStartedAt = Number.isFinite(right.log.startedAt) ? right.log.startedAt : 0;
      return rightStartedAt - leftStartedAt || right.index - left.index;
    });
  const seen = new Set();
  const candidates = [];
  orderedLogs.forEach(({ log }) => {
    (Array.isArray(log.tags) ? log.tags : []).forEach((value) => {
      try {
        const tag = normalizeTags([value])[0];
        if (!tag || seen.has(tag)) return;
        seen.add(tag);
        candidates.push(tag);
      } catch (error) {
        // 导入数据可能保留超出用户输入上限的标签；候选区只展示当前可直接添加的标签。
      }
    });
  });
  return candidates;
}

function availableTagCandidates(candidateQueue, selectedTags) {
  const selected = Array.isArray(selectedTags) ? selectedTags : [];
  if (selected.length >= MAX_TAGS_PER_LOG) return [];
  const selectedSet = new Set(selected);
  return (Array.isArray(candidateQueue) ? candidateQueue : []).filter((tag) => !selectedSet.has(tag));
}

function candidateDataKey(tagsKey) {
  return tagsKey === 'manualTags' ? 'manualTagCandidates' : 'tagCandidates';
}

function tagInputFocusDataKey(inputVisibleKey) {
  return inputVisibleKey === 'manualTagInputVisible'
    ? 'manualTagInputAutoFocus'
    : 'tagInputAutoFocus';
}

const TAG_CANDIDATE_TAP_SLOP = 8;
const TAG_CANDIDATE_BLUR_GUARD_MS = 200;

function touchPoint(event, key) {
  const touches = event && Array.isArray(event[key]) ? event[key] : [];
  const point = touches[0];
  if (!point) return null;
  return {
    x: Number(point.clientX),
    y: Number(point.clientY)
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
    events: [],
    eventIndex: 0,
    note: '',
    tags: [],
    tagCandidates: [],
    tagInputVisible: false,
    tagInputAutoFocus: false,
    showManual: false,
    manualStartDate: '',
    manualStartTime: '',
    manualStartTimeEdited: false,
    manualEndDate: '',
    manualEndTime: '',
    manualEndTimeEdited: false,
    manualPausedDurationSeconds: 0,
    manualNote: '',
    manualTags: [],
    manualTagCandidates: [],
    manualTagInputVisible: false,
    manualTagInputAutoFocus: false,
    manualEvents: [],
    manualEventIndex: 0,
    manualMode: 'manual',
    manualEditingCandidate: false,
    manualLogId: null,
    recoveryDraft: null,
    showDiscardRecoveryConfirm: false,
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
    this.recentNewLogId = null;
    this.focusedRecentLogId = null;
    this.timerDraftSyncId = null;
    const endedAt = Date.now();
    const startedAt = endedAt - 60 * 60 * 1000;
    const end = editableTimeFields(endedAt);
    const start = editableTimeFields(startedAt);
    this.manualOriginalStartedAt = startedAt;
    this.manualOriginalEndedAt = endedAt;
    this.setData({
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualStartTimeEdited: false,
      manualEndDate: end.date,
      manualEndTime: end.time,
      manualEndTimeEdited: false,
      manualPausedDurationSeconds: 0,
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
    this.flushTimerDraftSync();
    this.stopTicker();
    if (!this.data.recentScrollEnabled) this.setData({ recentScrollEnabled: true });
  },

  onUnload() {
    this.flushTimerDraftSync();
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

  refresh({ newLogId = null } = {}) {
    try {
      const service = getService();
      const snapshot = service.snapshot();
      if (newLogId) {
        this.recentNewLogId = newLogId;
        writeRecentLogHighlight(snapshot, newLogId);
      } else {
        const persistedHighlightId = readRecentLogHighlight(snapshot);
        if (persistedHighlightId) this.recentNewLogId = persistedHighlightId;
      }
      const highlightedRecentLogId = this.recentNewLogId;
      const draft = snapshot.timer.draft || {};
      const draftTags = Array.isArray(draft.tags) ? draft.tags.slice() : [];
      const hasActiveDraft = snapshot.timer.status !== TIMER_STATUS.IDLE;
      const shouldClearTimerForm = Boolean(snapshot.recoveryDraft && !hasActiveDraft);
      if (shouldClearTimerForm) this.hasUncommittedTimerForm = false;
      const now = Date.now();
      const planSelection = planOptionsForRange(service, snapshot, now, now);
      const selectableEvents = planSelection.options;
      const eventById = new Map(snapshot.calendarEvents.map((item) => [item.id, item]));
      const currentEvent = shouldClearTimerForm ? null : this.data.events[this.data.eventIndex];
      let currentPlan;
      if (shouldClearTimerForm) {
        currentPlan = { options: selectableEvents, index: 0 };
      } else if (snapshot.timer.status === TIMER_STATUS.IDLE || this.hasUncommittedTimerForm) {
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
        displayTitle: displayLogTitle(log),
        isCandidate: log.status === 'candidate',
        isNew: log.id === highlightedRecentLogId,
        tags: Array.isArray(log.tags) ? log.tags : [],
        tagScrollLeft: 0,
        tagMaxScrollLeft: 0
      }));
      const recoveryDraft = snapshot.recoveryDraft && {
        ...snapshot.recoveryDraft,
        ...recoveryDraftPresentation(snapshot.recoveryDraft)
      };
      const focusNewLog = Boolean(highlightedRecentLogId
        && this.focusedRecentLogId !== highlightedRecentLogId
        && recentLogs.some((log) => log.id === highlightedRecentLogId));
      if (focusNewLog) this.clearRecentScrollAnimation();
      if (focusNewLog) this.focusedRecentLogId = highlightedRecentLogId;
      const recentColumnIndex = focusNewLog
        ? 0
        : clampRecentColumnIndex(this.data.recentColumnIndex, recentLogs.length);
      const displayedTags = shouldClearTimerForm
        ? []
        : hasActiveDraft && !this.hasUncommittedTimerForm ? draftTags : this.data.tags;
      this.tagCandidateQueue = buildTagCandidateQueue(snapshot.timeLogs);
      this.setData({
        timer: snapshot.timer,
        recoveryDraft,
        events: currentPlan.options,
        eventIndex: currentPlan.index,
        recentLogs,
        recentColumnIndex,
        recentScrollLeft: focusNewLog
          ? 0
          : this.recentScrollAnimationId !== null && this.recentScrollAnimationId !== undefined
          ? this.data.recentScrollLeft
          : (this.data.recentColumnStep ? recentColumnIndex * this.data.recentColumnStep : 0),
        recentBoundaryOffset: focusNewLog ? 0 : this.data.recentBoundaryOffset,
        recentBoundaryIsDragging: focusNewLog ? false : this.data.recentBoundaryIsDragging,
        note: shouldClearTimerForm
          ? ''
          : snapshot.timer.status === TIMER_STATUS.IDLE || this.hasUncommittedTimerForm
          ? this.data.note
          : (draft.note || ''),
        tags: displayedTags,
        tagCandidates: availableTagCandidates(this.tagCandidateQueue, displayedTags),
        tagInputVisible: shouldClearTimerForm ? false : this.data.tagInputVisible,
        tagInputAutoFocus: shouldClearTimerForm ? false : this.data.tagInputAutoFocus
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
    const now = Date.now();
    const pauses = timer.status === TIMER_STATUS.PAUSED && timer.pausedAt
      ? (timer.pauses || []).concat({ startedAt: timer.pausedAt, endedAt: now })
      : timer.pauses;
    const seconds = elapsedSeconds(timer, now);
    const duration = calculateTimerDurationMinutes(timer.startedAt, now, pauses);
    const primaryLabel = timer.status === TIMER_STATUS.RUNNING ? '暂停' : '继续';
    const statusLabel = timer.status === TIMER_STATUS.RUNNING
      ? `计时中（${duration}分钟）`
      : '已暂停';
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
    const nextIndex = clampRecentColumnIndex(index, this.data.recentLogs.length);
    const targetScrollLeft = this.data.recentColumnStep ? nextIndex * this.data.recentColumnStep : 0;
    this.setData({ recentColumnIndex: nextIndex });
    if (!Number.isFinite(currentScrollLeft)) {
      this.setData({ recentScrollLeft: targetScrollLeft, recentScrollWithAnimation: false });
      return;
    }
    this.animateRecentScrollLeft(targetScrollLeft, {
      startScrollLeft: Math.max(0, currentScrollLeft),
      duration: RECENT_SNAP_ANIMATION_DURATION,
      easing: easeOutCubic
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
    this.markTimerFormChanged();
    this.setData({ note: event.detail.value });
    this.scheduleTimerDraftSync();
  },

  markTimerFormChanged() {
    if (this.data.timer.status !== TIMER_STATUS.IDLE) {
      this.hasUncommittedTimerForm = true;
    }
  },

  syncTimerDraft() {
    this.cancelTimerDraftSync();
    if (this.data.timer.status === TIMER_STATUS.IDLE) return;
    try {
      getService().updateTimerDraft(this.selectedInput());
      this.hasUncommittedTimerForm = false;
    } catch (error) {
      this.hasUncommittedTimerForm = true;
      showError(error);
    }
  },

  scheduleTimerDraftSync() {
    this.cancelTimerDraftSync();
    this.timerDraftSyncId = setTimeout(() => {
      this.timerDraftSyncId = null;
      this.syncTimerDraft();
    }, TIMER_DRAFT_DEBOUNCE_MS);
  },

  flushTimerDraftSync() {
    if (this.timerDraftSyncId === null || this.timerDraftSyncId === undefined) return;
    this.cancelTimerDraftSync();
    this.syncTimerDraft();
  },

  cancelTimerDraftSync() {
    if (this.timerDraftSyncId !== null && this.timerDraftSyncId !== undefined) {
      clearTimeout(this.timerDraftSyncId);
    }
    this.timerDraftSyncId = null;
  },

  openTagInput(event) {
    const inputVisibleKey = event.currentTarget.dataset.inputVisibleKey;
    const candidateKey = inputVisibleKey === 'manualTagInputVisible'
      ? 'manualTagCandidates'
      : 'tagCandidates';
    this.setData({
      [inputVisibleKey]: true,
      [tagInputFocusDataKey(inputVisibleKey)]: !(this.data[candidateKey] || []).length
    });
  },

  candidateData(tagsKey, tags) {
    const candidateQueue = tagsKey === 'manualTags'
      ? this.manualTagCandidateQueue
      : this.tagCandidateQueue;
    return {
      [candidateDataKey(tagsKey)]: availableTagCandidates(candidateQueue, tags)
    };
  },

  commitTag(tagsKey, inputVisibleKey, value) {
    const inputFocusKey = tagInputFocusDataKey(inputVisibleKey);
    const tag = normalizeTags([value])[0];
    if (!tag) {
      this.setData({ [inputVisibleKey]: false, [inputFocusKey]: false });
      return;
    }
    const currentTags = this.data[tagsKey] || [];
    if (currentTags.includes(tag)) {
      wx.showToast({ title: '标签已存在', icon: 'none' });
      return;
    }
    const nextTags = normalizeTags(currentTags.concat(tag));
    if (tagsKey === 'tags') this.markTimerFormChanged();
    this.setData({
      [tagsKey]: nextTags,
      [inputVisibleKey]: false,
      [inputFocusKey]: false,
      ...this.candidateData(tagsKey, nextTags)
    }, () => {
      if (tagsKey === 'tags') this.syncTimerDraft();
    });
  },

  addTag(event) {
    const { tagsKey, inputVisibleKey } = event.currentTarget.dataset;
    if (!this.data[inputVisibleKey]) return;
    try {
      this.commitTag(tagsKey, inputVisibleKey, event.detail.value);
    } catch (error) {
      showError(error);
    }
  },

  selectTagCandidate(event) {
    const { tagsKey, inputVisibleKey, tag } = event.currentTarget.dataset;
    try {
      this.commitTag(tagsKey, inputVisibleKey, tag);
    } catch (error) {
      showError(error);
    }
  },

  onTagCandidateTouchStart(event) {
    const point = touchPoint(event, 'touches');
    if (!point) return;
    const { tagsKey, inputVisibleKey } = event.currentTarget.dataset;
    this.tagCandidateTouch = {
      ...point,
      moved: false,
      dataset: {
        tagsKey,
        inputVisibleKey,
        tag: event.target && event.target.dataset ? event.target.dataset.tag : ''
      }
    };
    this.tagCandidateBlurGuard = {
      inputVisibleKey,
      expiresAt: Date.now() + TAG_CANDIDATE_BLUR_GUARD_MS
    };
  },

  onTagCandidateTouchMove(event) {
    const gesture = this.tagCandidateTouch;
    const point = touchPoint(event, 'touches');
    if (!gesture || !point) return;
    if (
      Math.abs(point.x - gesture.x) > TAG_CANDIDATE_TAP_SLOP ||
      Math.abs(point.y - gesture.y) > TAG_CANDIDATE_TAP_SLOP
    ) {
      gesture.moved = true;
    }
  },

  onTagCandidateTouchEnd(event) {
    const gesture = this.tagCandidateTouch;
    this.tagCandidateTouch = null;
    const point = touchPoint(event, 'changedTouches');
    if (!gesture || !point) return;
    this.tagCandidateBlurGuard = {
      inputVisibleKey: gesture.dataset.inputVisibleKey,
      expiresAt: Date.now() + TAG_CANDIDATE_BLUR_GUARD_MS
    };
    if (
      gesture.moved ||
      Math.abs(point.x - gesture.x) > TAG_CANDIDATE_TAP_SLOP ||
      Math.abs(point.y - gesture.y) > TAG_CANDIDATE_TAP_SLOP
    ) {
      return;
    }
    if (!gesture.dataset.tag) return;
    this.selectTagCandidate({ currentTarget: { dataset: gesture.dataset } });
  },

  onTagCandidateTouchCancel() {
    const gesture = this.tagCandidateTouch;
    this.tagCandidateTouch = null;
    if (gesture) {
      this.tagCandidateBlurGuard = {
        inputVisibleKey: gesture.dataset.inputVisibleKey,
        expiresAt: Date.now() + TAG_CANDIDATE_BLUR_GUARD_MS
      };
    }
  },

  onTagInputBlur(event) {
    const inputVisibleKey = event.currentTarget.dataset.inputVisibleKey;
    const activeGesture = this.tagCandidateTouch;
    const blurGuard = this.tagCandidateBlurGuard;
    if (
      (activeGesture && activeGesture.dataset.inputVisibleKey === inputVisibleKey) ||
      (blurGuard && blurGuard.inputVisibleKey === inputVisibleKey && Date.now() <= blurGuard.expiresAt)
    ) {
      return;
    }
    if (String(event.detail.value || '').trim()) {
      this.addTag(event);
      return;
    }
    this.setData({
      [inputVisibleKey]: false,
      [tagInputFocusDataKey(inputVisibleKey)]: false
    });
  },

  removeTag(event) {
    const { tagsKey } = event.currentTarget.dataset;
    const index = Number(event.currentTarget.dataset.index);
    if (tagsKey === 'tags') this.markTimerFormChanged();
    const nextTags = (this.data[tagsKey] || []).filter((_, itemIndex) => itemIndex !== index);
    this.setData({
      [tagsKey]: nextTags,
      ...this.candidateData(tagsKey, nextTags)
    }, () => {
      if (tagsKey === 'tags') this.syncTimerDraft();
    });
  },

  onPickerChange(event) {
    const key = event.currentTarget.dataset.key;
    if (key === 'eventIndex') this.markTimerFormChanged();
    this.setData({ [key]: Number(event.detail.value) }, () => {
      if (key === 'eventIndex') this.syncTimerDraft();
    });
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
      if (status === TIMER_STATUS.IDLE && this.data.recoveryDraft) return;
      if (status === TIMER_STATUS.IDLE) {
        service.startTimer(this.selectedInput());
        this.hasUncommittedTimerForm = false;
      }
      if (status === TIMER_STATUS.RUNNING) service.pauseTimer();
      if (status === TIMER_STATUS.PAUSED) service.resumeTimer();
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  onFinishTimer() {
    try {
      const service = getService();
      const result = service.finishTimer(this.selectedInput());
      this.cancelTimerDraftSync();
      this.hasUncommittedTimerForm = false;
      if (result && result.state === 'draft') {
        this.refresh();
        return;
      }
      this.setData({ eventIndex: 0, note: '', tags: [], tagInputVisible: false });
      showSaved('记录已生成');
      this.refresh({ newLogId: result.log.id });
    } catch (error) {
      showError(error);
    }
  },

  planOptionsForManualFields() {
    const startedAt = resolvePageTimestamp(
      this.manualOriginalStartedAt,
      this.data.manualStartTimeEdited,
      this.data.manualStartDate,
      this.data.manualStartTime
    );
    const endedAt = resolvePageTimestamp(
      this.manualOriginalEndedAt,
      this.data.manualEndTimeEdited,
      this.data.manualEndDate,
      this.data.manualEndTime
    );
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
    this.recoveryCandidatePreview = null;
    this.manualEditingCandidate = false;
    this.manualOriginalStartedAt = originalTimestampForFields(
      this.manualOriginalStartedAt,
      this.data.manualStartDate,
      this.data.manualStartTime
    );
    this.manualOriginalEndedAt = originalTimestampForFields(
      this.manualOriginalEndedAt,
      this.data.manualEndDate,
      this.data.manualEndTime
    );
    const currentEvent = this.data.events[this.data.eventIndex];
    const planSelection = this.planOptionsForManualFields();
    const matchedIndex = findPlanAssociationIndex(planSelection.options, currentEvent);
    const currentPlan = matchedIndex > 0
      ? { options: planSelection.options, index: matchedIndex }
      : currentEvent && ['event', 'origin'].includes(currentEvent.associationType)
        ? optionsWithSelected(planSelection.options, currentEvent)
        : { options: planSelection.options, index: 0 };
    const snapshot = this.currentSnapshot || (this.currentService || getService()).snapshot();
    this.manualTagCandidateQueue = buildTagCandidateQueue(snapshot.timeLogs);
    this.manualPlanSelectionRange = planSelection.range;
    this.setData({
      showManual: true,
      manualMode: 'manual',
      manualEditingCandidate: false,
      manualLogId: null,
      manualStartTimeEdited: false,
      manualEndTimeEdited: false,
      manualPausedDurationSeconds: 0,
      manualNote: '',
      manualTags: [],
      manualTagCandidates: availableTagCandidates(this.manualTagCandidateQueue, []),
      manualTagInputVisible: false,
      manualEvents: currentPlan.options,
      manualEventIndex: currentPlan.index
    });
  },

  openRecoveryManual() {
    const recoveryDraft = this.data.recoveryDraft || {};
    const timer = recoveryDraft.timer || {};
    const candidatePreview = isCandidatePreview(recoveryDraft.candidatePreview)
      ? recoveryDraft.candidatePreview
      : null;
    const startedAt = candidatePreview
      ? candidatePreview.startedAt
      : Number.isFinite(timer.startedAt) && timer.startedAt > 0
        ? timer.startedAt
        : Date.now() - 60 * 60 * 1_000;
    const endedAt = candidatePreview ? candidatePreview.endedAt : startedAt + 60 * 60 * 1_000;
    const start = editableTimeFields(startedAt);
    const end = editableTimeFields(endedAt);
    const draft = timer.draft || {};
    const originalTags = Array.isArray(draft.tags) ? draft.tags.slice() : [];
    const service = this.currentService || getService();
    const snapshot = this.currentSnapshot || service.snapshot();
    const planSelection = planOptionsForRange(service, snapshot, startedAt, endedAt);
    const currentPlan = optionsForCurrentDraft(planSelection.options, draft, this.eventById);
    this.manualTagCandidateQueue = buildTagCandidateQueue(snapshot.timeLogs);
    this.manualPlanSelectionRange = planSelection.range;
    this.recoveryCandidatePreview = candidatePreview;
    this.manualEditingCandidate = false;
    this.manualOriginalStartedAt = startedAt;
    this.manualOriginalEndedAt = endedAt;
    this.setData({
      showManual: true,
      manualMode: 'recovery',
      manualEditingCandidate: false,
      manualLogId: null,
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualStartTimeEdited: false,
      manualEndDate: end.date,
      manualEndTime: end.time,
      manualEndTimeEdited: false,
      manualPausedDurationSeconds: candidatePreview
        ? (candidatePreview.pausedDurationSeconds || 0)
        : 0,
      manualNote: draft.note || '',
      manualTags: originalTags,
      manualTagCandidates: availableTagCandidates(this.manualTagCandidateQueue, originalTags),
      manualTagInputVisible: false,
      manualEvents: currentPlan.options,
      manualEventIndex: currentPlan.index
    });
  },

  onDiscardRecoveryDraft() {
    if (!this.data.recoveryDraft) return;
    this.setData({ showDiscardRecoveryConfirm: true });
  },

  confirmDiscardRecoveryDraft() {
    try {
      getService().discardRecoveryDraft();
      this.setData({ showDiscardRecoveryConfirm: false });
      this.refresh();
      showSaved('已放弃并删除恢复草稿');
    } catch (error) {
      showError(error);
    }
  },

  cancelDiscardRecoveryDraft() {
    this.setData({ showDiscardRecoveryConfirm: false });
  },

  openRecentLogEditor(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.recentLogs.find((log) => log.id === id);
    if (!item) return;
    const start = editableTimeFields(item.startedAt);
    const end = editableTimeFields(item.endedAt);
    const service = this.currentService || getService();
    const snapshot = this.currentSnapshot || service.snapshot();
    const planSelection = planOptionsForRange(service, snapshot, item.startedAt, item.endedAt);
    const currentPlan = optionsForCurrentDraft(planSelection.options, item, this.eventById);
    const originalTags = Array.isArray(item.tags) ? item.tags.slice() : [];
    this.manualTagCandidateQueue = buildTagCandidateQueue(snapshot.timeLogs, item.id);
    this.manualPlanSelectionRange = planSelection.range;
    this.recoveryCandidatePreview = null;
    const manualEditingCandidate = item.status === 'candidate';
    this.manualEditingCandidate = manualEditingCandidate;
    this.manualOriginalStartedAt = item.startedAt;
    this.manualOriginalEndedAt = item.endedAt;
    this.setData({
      showManual: true,
      manualMode: 'edit',
      manualEditingCandidate,
      manualLogId: item.id,
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualStartTimeEdited: false,
      manualEndDate: end.date,
      manualEndTime: end.time,
      manualEndTimeEdited: false,
      manualPausedDurationSeconds: item.pausedDurationSeconds || 0,
      manualNote: item.note || '',
      manualTags: originalTags,
      manualTagCandidates: availableTagCandidates(this.manualTagCandidateQueue, originalTags),
      manualTagInputVisible: false,
      manualEvents: currentPlan.options,
      manualEventIndex: currentPlan.index
    });
  },

  confirmDeleteRecentLog(event) {
    const id = event.currentTarget.dataset.id;
    const item = this.data.recentLogs.find((log) => log.id === id);
    if (!item) return;
    wx.showModal({
      title: item.isCandidate ? '删除候选记录' : '删除时间记录',
      content: item.isCandidate
        ? '删除后不会生成实际投入，且无法恢复。'
        : '删除后这条记录将无法恢复。',
      confirmColor: '#9a5550',
      success: (result) => {
        if (!result.confirm) return;
        try {
          getService().deleteLog(id, true);
          showSaved('记录已删除');
          this.refresh();
        } catch (error) {
          showError(error);
        }
      }
    });
  },

  closeManual() {
    this.recoveryCandidatePreview = null;
    this.manualEditingCandidate = false;
    this.manualTagCandidateQueue = [];
    this.setData({
      showManual: false,
      manualMode: 'manual',
      manualEditingCandidate: false,
      manualLogId: null,
      manualStartTimeEdited: false,
      manualEndTimeEdited: false,
      manualTagCandidates: [],
      manualTagInputVisible: false
    });
  },

  onManualField(event) {
    const key = event.currentTarget.dataset.key;
    const updates = { [key]: event.detail.value };
    if (key === 'manualStartDate') updates.manualStartTimeEdited = true;
    if (key === 'manualEndDate') updates.manualEndTimeEdited = true;
    this.setData(updates, () => {
      if (['manualStartDate', 'manualStartTime', 'manualEndDate', 'manualEndTime'].includes(key)) {
        this.refreshManualPlanOptions();
      }
    });
  },

  onManualTimeChange(event) {
    const { key, editedKey } = event.currentTarget.dataset;
    this.setData({ [key]: event.detail.value, [editedKey]: true }, () => {
      this.refreshManualPlanOptions();
    });
  },

  onManualPausedDurationChange(event) {
    this.setData({ manualPausedDurationSeconds: event.detail.value });
  },

  onManualSave() {
    try {
      const startedAt = resolvePageTimestamp(
        this.manualOriginalStartedAt,
        this.data.manualStartTimeEdited,
        this.data.manualStartDate,
        this.data.manualStartTime
      );
      const endedAt = resolvePageTimestamp(
        this.manualOriginalEndedAt,
        this.data.manualEndTimeEdited,
        this.data.manualEndDate,
        this.data.manualEndTime
      );
      const input = {
        ...this.selectedManualInput(),
        startedAt,
        endedAt,
        pausedDurationSeconds: this.data.manualPausedDurationSeconds,
        note: this.data.manualNote
      };
      const isEdit = this.data.manualMode === 'edit';
      const result = this.data.manualMode === 'recovery'
        ? { log: getService().createRecoveryConfirmedLog(input) }
        : isEdit
          ? getService().updateLog(this.data.manualLogId, input)
          : getService().createManualLog(input);
      const wasRecovery = this.data.manualMode === 'recovery';
      const wasCandidateEdit = isEdit && this.manualEditingCandidate;
      this.recoveryCandidatePreview = null;
      this.manualEditingCandidate = false;
      this.setData({
        showManual: false,
        manualMode: 'manual',
        manualEditingCandidate: false,
        manualLogId: null,
        manualStartTimeEdited: false,
        manualEndTimeEdited: false,
        manualPausedDurationSeconds: 0,
        manualNote: '',
        manualTags: [],
        manualTagCandidates: [],
        manualTagInputVisible: false
      });
      showSaved(wasRecovery
        ? '恢复记录已确认'
        : isEdit
          ? (wasCandidateEdit ? '候选已编辑并确认' : '记录已更新')
          : '补录已保存');
      this.refresh(isEdit && !wasCandidateEdit ? undefined : { newLogId: result.log.id });
    } catch (error) {
      showError(error);
    }
  },

  noop() {
    // 阻止弹层点击穿透。
  }
});
