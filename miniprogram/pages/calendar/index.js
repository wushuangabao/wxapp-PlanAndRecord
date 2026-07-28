const { parseLocalDateTime } = require('../../domain/time');
const { rangeForView, shiftAnchor } = require('../../utils/date-range');
const { defaultDateTime, formatDateTime, getService, selectorData, showError, showSaved } = require('../../utils/page');

const VIEW_LABELS = { day: '日', week: '周', month: '月', year: '年' };
const FREQUENCY_VALUES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = ['每日', '每周', '每月'];

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
    projects: [],
    tasks: [],
    projectIndex: 0,
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
      const timeline = service.timeline(range.start, range.end).map((item) => ({
        ...item,
        displayTime: `${formatDateTime(item.startedAt)} – ${formatDateTime(item.endedAt)}`,
        displayKind: item.type === 'plan' ? '计划' : item.type === 'candidate' ? '候选' : '实际',
        priority: item.priority || 1
      }));
      this.setData({
        ...selectorData(snapshot),
        timeline,
        rangeLabel: `${formatDateTime(range.start).slice(0, 10)} ～ ${formatDateTime(range.end).slice(0, 10)}`
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
      const project = this.data.projects[this.data.projectIndex];
      const task = this.data.tasks[this.data.taskIndex];
      const input = { title: this.data.title, startedAt, endedAt, priority: this.data.priority, projectId: project && project.id, taskId: task && task.id };
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
      getService().startTimer({ calendarEventId: item.id, projectId: item.projectId, taskId: item.taskId });
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
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },

  chooseEditorPriority(event) {
    this.setData({ editorPriority: Number(event.currentTarget.dataset.priority) });
  },

  saveOccurrenceOverride() {
    try {
      const item = this.data.editor;
      getService().overrideOccurrence(item.ruleId, item.occurrenceStart, {
        title: this.data.editorTitle,
        startedAt: parseLocalDateTime(this.data.editorDate, this.data.editorStart),
        endedAt: parseLocalDateTime(this.data.editorDate, this.data.editorEnd),
        priority: this.data.editorPriority,
        projectId: item.projectId,
        projectNameSnapshot: item.projectNameSnapshot,
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
    this.setData({ logEditor: item, logDate: start.date, logStart: start.time, logEnd: end.time, logNote: item.note || '' });
  },

  closeLogEditor() {
    this.setData({ logEditor: null });
  },

  saveLogEditor() {
    try {
      const item = this.data.logEditor;
      getService().updateLog(item.id, {
        startedAt: parseLocalDateTime(this.data.logDate, this.data.logStart),
        endedAt: parseLocalDateTime(this.data.logDate, this.data.logEnd),
        note: this.data.logNote
      });
      this.closeLogEditor();
      showSaved(item.type === 'candidate' ? '候选已编辑并确认' : '记录已更新');
      this.refresh();
    } catch (error) { showError(error); }
  }
});
