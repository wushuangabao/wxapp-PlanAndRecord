const { TIMER_STATUS } = require('../../domain/constants');
const { calculateTimerDurationMinutes, parseLocalDateTime, sumPausedMilliseconds } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, selectorData, showError, showSaved } = require('../../utils/page');

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

Page({
  data: {
    timer: { status: TIMER_STATUS.IDLE },
    elapsed: '00:00:00',
    elapsedMinutes: 0,
    statusLabel: '准备开始',
    primaryLabel: '开始记录',
    categories: [],
    projects: [],
    tasks: [],
    events: [],
    categoryIndex: 0,
    projectIndex: 0,
    taskIndex: 0,
    eventIndex: 0,
    note: '',
    showManual: false,
    manualStartDate: '',
    manualStartTime: '',
    manualEndDate: '',
    manualEndTime: '',
    manualNote: '',
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
      const selectors = selectorData(snapshot);
      const recentLogs = snapshot.timeLogs.slice(-5).reverse().map((log) => ({
        ...log,
        displayTime: `${formatDateTime(log.startedAt)} · ${log.durationMinutes} 分钟`,
        displayTitle: log.taskNameSnapshot || log.note || '未命名记录'
      }));
      this.setData({
        timer: snapshot.timer,
        recoveryDraft: snapshot.recoveryDraft,
        ...selectors,
        recentLogs,
        note: snapshot.timer.draft && snapshot.timer.draft.note ? snapshot.timer.draft.note : this.data.note
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

  onPickerChange(event) {
    this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) });
  },

  selectedInput() {
    const getId = (items, index) => (items[index] ? items[index].id : undefined);
    return {
      categoryId: getId(this.data.categories, this.data.categoryIndex),
      projectId: getId(this.data.projects, this.data.projectIndex),
      taskId: getId(this.data.tasks, this.data.taskIndex),
      calendarEventId: getId(this.data.events, this.data.eventIndex),
      note: this.data.note
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

  openManual() {
    this.setData({ showManual: true, manualMode: 'manual' });
  },

  openRecoveryManual() {
    const timer = this.data.recoveryDraft && this.data.recoveryDraft.timer ? this.data.recoveryDraft.timer : {};
    const startedAt = Number.isFinite(timer.startedAt) && timer.startedAt > 0 ? timer.startedAt : Date.now() - 60 * 60 * 1_000;
    const endedAt = Number.isFinite(timer.endedAt) && timer.endedAt > startedAt ? timer.endedAt : startedAt + 60 * 60 * 1_000;
    const start = defaultDateTime(startedAt);
    const end = defaultDateTime(endedAt);
    this.setData({
      showManual: true,
      manualMode: 'recovery',
      manualStartDate: start.date,
      manualStartTime: start.time,
      manualEndDate: end.date,
      manualEndTime: end.time,
      manualNote: timer.draft && timer.draft.note ? timer.draft.note : ''
    });
  },

  closeManual() {
    this.setData({ showManual: false });
  },

  onManualField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onManualSave() {
    try {
      const startedAt = parseLocalDateTime(this.data.manualStartDate, this.data.manualStartTime);
      const endedAt = parseLocalDateTime(this.data.manualEndDate, this.data.manualEndTime);
      const input = { ...this.selectedInput(), startedAt, endedAt, note: this.data.manualNote };
      const result = this.data.manualMode === 'recovery'
        ? { log: getService().createRecoveryCandidate(input), hasOverlap: false }
        : getService().createManualLog(input);
      const wasRecovery = this.data.manualMode === 'recovery';
      this.setData({ showManual: false, manualMode: 'manual', manualNote: '' });
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
