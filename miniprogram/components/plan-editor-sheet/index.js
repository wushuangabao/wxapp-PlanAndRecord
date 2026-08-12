const { parseLocalDateTime } = require('../../domain/time');
const { limitTitleCodePoints } = require('../../domain/validation');
const { defaultPlanDate } = require('../../utils/calendar-grid');
const { defaultDateTime, getService, showError } = require('../../utils/page');
const { createdPlanTarget } = require('../../utils/plan-editor-target');

const FREQUENCY_VALUES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_UNITS = ['天', '周', '月'];
const WEEKDAY_OPTIONS = [
  { label: '一', value: 1 },
  { label: '二', value: 2 },
  { label: '三', value: 3 },
  { label: '四', value: 4 },
  { label: '五', value: 5 },
  { label: '六', value: 6 },
  { label: '日', value: 0 }
];
const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => ({
  label: String(index + 1),
  value: index + 1
}));
const TASK_OPTION_ROW_HEIGHT_RPX = 96;
const TASK_OPTION_GAP_RPX = 12;
const TASK_PICKER_MAX_LIST_HEIGHT_RPX = 600;

function defaultRepeatWeekdays(now = Date.now()) {
  return [new Date(now).getDay()];
}

function defaultRepeatMonthDays(now = Date.now()) {
  return [new Date(now).getDate()];
}

function weekdayOptionsWithSelection(weekdays) {
  return WEEKDAY_OPTIONS.map((option) => ({
    ...option,
    checked: weekdays.includes(option.value)
  }));
}

function monthDayOptionsWithSelection(monthDays) {
  return MONTH_DAY_OPTIONS.map((option) => ({
    ...option,
    checked: monthDays.includes(option.value)
  }));
}

function repeatOccurrenceText(frequencyIndex, weekdays, monthDays) {
  const selectedCount = frequencyIndex === 1
    ? weekdays.length
    : frequencyIndex === 2
      ? monthDays.length
      : 1;
  return selectedCount === 1 ? '一次' : `${selectedCount}次`;
}

function repeatIntervalFromGap(value) {
  if (typeof value === 'string' && !value.trim()) {
    throw new Error('重复间隔必须是非负整数');
  }
  const gap = Number(value);
  if (!Number.isSafeInteger(gap) || gap < 0 || !Number.isSafeInteger(gap + 1)) {
    throw new Error('重复间隔必须是非负整数');
  }
  return gap + 1;
}

function taskPickerListHeight(options) {
  const optionCount = (options || []).filter((item) => item && item.id).length;
  if (!optionCount) return 0;
  return Math.min(
    TASK_PICKER_MAX_LIST_HEIGHT_RPX,
    optionCount * TASK_OPTION_ROW_HEIGHT_RPX + (optionCount - 1) * TASK_OPTION_GAP_RPX
  );
}

function blankData(now = Date.now()) {
  const repeatWeekdays = defaultRepeatWeekdays(now);
  const repeatMonthDays = defaultRepeatMonthDays(now);
  return {
    title: '',
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    priority: 1,
    hasAnyTasks: false,
    repeatEnabled: false,
    frequencyIndex: 0,
    repeatGap: '0',
    repeatWeekdays,
    repeatMonthDays,
    repeatOccurrenceText: '一次',
    frequencyUnits: FREQUENCY_UNITS,
    weekdayOptions: weekdayOptionsWithSelection(repeatWeekdays),
    monthDayOptions: monthDayOptionsWithSelection(repeatMonthDays),
    planFormTasks: [],
    planFormTaskIndex: 0,
    isTaskPickerOpen: false,
    taskPickerListHeight: 0,
    planEditor: null,
    newTaskProjectId: null
  };
}

Component({
  properties: {
    visible: { type: Boolean, value: false },
    variant: { type: String, value: 'calendar' },
    mode: { type: String, value: 'create' },
    initialValue: { type: Object, value: null }
  },

  data: blankData(),

  observers: {
    visible(value) {
      if (value) this.resetFromInitialValue();
    }
  },

  methods: {
    resetFromInitialValue() {
      const now = Date.now();
      const initialValue = this.properties.initialValue || {};
      const variant = this.properties.variant || 'calendar';
      const mode = variant === 'plans-todo' ? 'create' : (this.properties.mode || 'create');
      const reset = blankData(now);

      if (mode === 'edit' && initialValue.plan) {
        const plan = initialValue.plan;
        const start = defaultDateTime(plan.startedAt);
        const end = defaultDateTime(plan.endedAt);
        const tasks = Array.isArray(initialValue.taskOptions) ? initialValue.taskOptions.slice() : [];
        this.validTaskIds = new Set(tasks.filter((item) => item && item.id).map((item) => item.id));
        this.setData({
          ...reset,
          title: plan.title || '',
          startDate: start.date,
          startTime: start.time,
          endDate: end.date,
          endTime: end.time,
          priority: plan.priority ?? 1,
          planFormTasks: tasks,
          planFormTaskIndex: Number(initialValue.taskIndex) || 0,
          planEditor: plan
        });
        return;
      }

      const start = defaultDateTime(now + 60 * 60 * 1_000);
      const end = defaultDateTime(now + 2 * 60 * 60 * 1_000);
      const anchorDate = Number(initialValue.anchorDate);
      const date = defaultPlanDate(Number.isFinite(anchorDate) ? anchorDate : now, now);
      const wrapsDay = end.time <= start.time;
      const tasks = variant === 'calendar' && Array.isArray(initialValue.taskOptions)
        ? initialValue.taskOptions.slice()
        : [];
      this.validTaskIds = new Set(tasks.filter((item) => item && item.id).map((item) => item.id));
      this.setData({
        ...reset,
        title: initialValue.title || '',
        startDate: date,
        endDate: date,
        startTime: wrapsDay ? '09:00' : start.time,
        endTime: wrapsDay ? '10:00' : end.time,
        priority: initialValue.priority ?? 1,
        hasAnyTasks: Boolean(initialValue.hasAnyTasks),
        planFormTasks: tasks,
        planFormTaskIndex: Number(initialValue.taskIndex) || 0,
        newTaskProjectId: initialValue.newTaskProjectId || null,
        repeatEnabled: false
      });
    },

    cancel() {
      this.triggerEvent('cancel');
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
      const taskIndex = Number(event.currentTarget.dataset.index);
      this.setData({ planFormTaskIndex: taskIndex, isTaskPickerOpen: false });
      if ((this.properties.variant || 'calendar') === 'calendar'
        && (this.properties.mode || 'create') === 'create') {
        this.triggerEvent('taskindexchange', { taskIndex });
      }
    },

    onField(event) {
      this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
    },

    onTitleField(event) {
      this.setData({
        [event.currentTarget.dataset.key]: limitTitleCodePoints(event.detail.value)
      });
    },

    onSwitch(event) {
      this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
    },

    onPicker(event) {
      const key = event.currentTarget.dataset.key;
      const value = Number(event.detail.value);
      const updates = { [key]: value };
      if (key === 'frequencyIndex') {
        updates.repeatOccurrenceText = repeatOccurrenceText(
          value,
          this.data.repeatWeekdays,
          this.data.repeatMonthDays
        );
      }
      this.setData(updates);
    },

    onRepeatGapInput(event) {
      const rawValue = event.detail.value;
      const repeatGap = String(rawValue === undefined || rawValue === null ? '' : rawValue);
      if (!/^\d*$/.test(repeatGap)) {
        return String(this.data.repeatGap === undefined || this.data.repeatGap === null
          ? ''
          : this.data.repeatGap);
      }
      this.setData({ repeatGap });
      return repeatGap;
    },

    onWeekdaysChange(event) {
      const repeatWeekdays = event.detail.value.map(Number);
      this.setData({
        repeatWeekdays,
        repeatOccurrenceText: repeatOccurrenceText(
          this.data.frequencyIndex,
          repeatWeekdays,
          this.data.repeatMonthDays
        ),
        weekdayOptions: weekdayOptionsWithSelection(repeatWeekdays)
      });
    },

    onMonthDaysChange(event) {
      const repeatMonthDays = event.detail.value.map(Number).sort((left, right) => left - right);
      this.setData({
        repeatMonthDays,
        repeatOccurrenceText: repeatOccurrenceText(
          this.data.frequencyIndex,
          this.data.repeatWeekdays,
          repeatMonthDays
        ),
        monthDayOptions: monthDayOptionsWithSelection(repeatMonthDays)
      });
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
        const variant = this.properties.variant || 'calendar';
        const input = {
          title: this.data.title,
          startedAt,
          endedAt,
          priority: this.data.priority
        };
        let operation;
        let result;

        if (variant === 'plans-todo') {
          result = service.createCalendarEventWithNewTask({
            ...input,
            taskProjectId: this.data.newTaskProjectId || undefined
          });
          operation = 'create-event';
        } else {
          const task = this.data.planFormTasks[this.data.planFormTaskIndex];
          const shouldCreateTask = !this.data.hasAnyTasks
            || (task && task.optionType === 'create');
          if (!shouldCreateTask && (!task || !task.id)) throw new Error('请选择任务');
          if (!shouldCreateTask) input.taskId = task.id;

          if (this.data.repeatEnabled) {
            input.frequency = FREQUENCY_VALUES[this.data.frequencyIndex];
            input.interval = repeatIntervalFromGap(this.data.repeatGap);
            input.weekdays = input.frequency === 'weekly' ? this.data.repeatWeekdays : [];
            input.monthDays = input.frequency === 'monthly' ? this.data.repeatMonthDays : [];
            result = shouldCreateTask
              ? service.createRecurringPlanWithNewTask(input)
              : service.createRecurringPlan(input);
            operation = 'create-recurring';
          } else {
            result = shouldCreateTask
              ? service.createCalendarEventWithNewTask(input)
              : service.createCalendarEvent(input);
            operation = 'create-event';
          }
        }

        this.triggerEvent('success', {
          operation,
          result,
          revealTarget: createdPlanTarget(result)
        });
      } catch (error) {
        showError(error);
      }
    },

    savePlanEditor() {
      try {
        const task = this.data.planFormTasks[this.data.planFormTaskIndex];
        if (!task || !task.id || !this.validTaskIds || !this.validTaskIds.has(task.id)) {
          throw new Error('请选择任务');
        }
        const result = getService().updateCalendarEvent(this.data.planEditor.id, {
          title: this.data.title,
          startedAt: parseLocalDateTime(this.data.startDate, this.data.startTime),
          endedAt: parseLocalDateTime(this.data.endDate, this.data.endTime),
          priority: this.data.priority,
          taskId: task.id
        });
        this.triggerEvent('success', {
          operation: 'update-event',
          result,
          revealTarget: null
        });
      } catch (error) {
        showError(error);
      }
    },

    noop() {
    }
  }
});
