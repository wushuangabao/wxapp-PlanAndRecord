const { TIMER_STATUS } = require('../../domain/constants');
const { calculateDurationMinutes, parseLocalDateTime } = require('../../domain/time');
const { defaultDateTime, formatDateTime, getService, selectorData, showError, showSaved } = require('../../utils/page');

function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

Page({
  data: {
    timer: { status: TIMER_STATUS.IDLE },
    elapsed: '00:00',
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
    manualDate: '',
    manualStartTime: '',
    manualEndTime: '',
    manualNote: '',
    recentLogs: []
  },

  onLoad() {
    const end = defaultDateTime();
    const start = defaultDateTime(Date.now() - 60 * 60 * 1000);
    this.setData({ manualDate: end.date, manualStartTime: start.time, manualEndTime: end.time });
  },

  onShow() {
    this.refresh();
    this.startTicker();
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => this.updateElapsed(), 30 * 1000);
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
        ...selectors,
        recentLogs,
        note: snapshot.timer.draft && snapshot.timer.draft.note ? snapshot.timer.draft.note : this.data.note
      });
      this.updateElapsed();
    } catch (error) {
      showError(error);
    }
  },

  updateElapsed() {
    const timer = this.data.timer;
    if (!timer || !timer.startedAt || timer.status === TIMER_STATUS.IDLE) {
      this.setData({ elapsed: '00:00', statusLabel: '准备开始', primaryLabel: '开始记录' });
      return;
    }
    const endedAt = timer.status === TIMER_STATUS.ENDED ? timer.endedAt : Date.now();
    const pauses = (timer.pauses || []).slice();
    if (timer.status === TIMER_STATUS.PAUSED && timer.pausedAt) {
      pauses.push({ startedAt: timer.pausedAt, endedAt });
    }
    const duration = calculateDurationMinutes(timer.startedAt, endedAt, pauses);
    const primaryLabel = timer.status === TIMER_STATUS.RUNNING ? '暂停' : timer.status === TIMER_STATUS.PAUSED ? '继续' : '生成记录';
    const statusLabel = timer.status === TIMER_STATUS.RUNNING ? '计时中' : timer.status === TIMER_STATUS.PAUSED ? '已暂停' : '已结束，等待确认';
    this.setData({ elapsed: formatDuration(duration), statusLabel, primaryLabel });
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
    this.setData({ showManual: true });
  },

  closeManual() {
    this.setData({ showManual: false });
  },

  onManualField(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  onManualSave() {
    try {
      const startedAt = parseLocalDateTime(this.data.manualDate, this.data.manualStartTime);
      const endedAt = parseLocalDateTime(this.data.manualDate, this.data.manualEndTime);
      const result = getService().createManualLog({ ...this.selectedInput(), startedAt, endedAt, note: this.data.manualNote });
      this.setData({ showManual: false, manualNote: '' });
      showSaved(result.hasOverlap ? '已保存：存在重叠时间' : '补录已保存');
      this.refresh();
    } catch (error) {
      showError(error);
    }
  },

  noop() {
    // 阻止弹层点击穿透。
  }
});
