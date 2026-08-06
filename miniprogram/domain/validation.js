const { MAX_PLAN_PRIORITY, MAX_TITLE_LENGTH, REPEAT_FREQUENCY } = require('./constants');
const { DomainError } = require('./errors');
const { calculateLogTiming, isFiniteTimestamp } = require('./time');

function requiredTitle(value, label = '标题') {
  if (typeof value !== 'string') {
    throw new DomainError('TITLE_REQUIRED', `${label}不能为空`);
  }
  const title = value.trim();
  if (!title) {
    throw new DomainError('TITLE_REQUIRED', `${label}不能为空`);
  }
  if (Array.from(title).length > MAX_TITLE_LENGTH) {
    throw new DomainError('TITLE_TOO_LONG', `${label}不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return title;
}

function limitTitleCodePoints(value) {
  return Array.from(typeof value === 'string' ? value : '').slice(0, MAX_TITLE_LENGTH).join('');
}

function cloneSnapshotValue(value) {
  if (Array.isArray(value)) return value.map(cloneSnapshotValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).reduce((result, key) => {
    result[key] = cloneSnapshotValue(value[key]);
    return result;
  }, {});
}

function trimProvidedTitle(target) {
  if (target && Object.prototype.hasOwnProperty.call(target, 'title') && typeof target.title === 'string') {
    target.title = target.title.trim();
  }
}

function normalizeSnapshotTitles(database) {
  const normalized = cloneSnapshotValue(database);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return normalized;

  if (Array.isArray(normalized.wishes)) normalized.wishes.forEach(trimProvidedTitle);
  if (Array.isArray(normalized.projects)) normalized.projects.forEach(trimProvidedTitle);
  if (Array.isArray(normalized.tasks)) normalized.tasks.forEach(trimProvidedTitle);
  if (Array.isArray(normalized.calendarEvents)) normalized.calendarEvents.forEach(trimProvidedTitle);
  if (Array.isArray(normalized.repeatRules)) normalized.repeatRules.forEach(trimProvidedTitle);
  if (Array.isArray(normalized.occurrenceExceptions)) {
    normalized.occurrenceExceptions.forEach((exception) => {
      if (exception && exception.override && typeof exception.override === 'object') {
        trimProvidedTitle(exception.override);
      }
    });
  }
  return normalized;
}

function validPriority(value) {
  if (value === undefined || value === null || value === '') {
    return 1;
  }
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 1 || priority > MAX_PLAN_PRIORITY) {
    throw new DomainError('PRIORITY_INVALID', `计划优先级必须为 1 到 ${MAX_PLAN_PRIORITY} 的整数`);
  }
  return priority;
}

function validInterval(value) {
  const interval = Number(value || 1);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new DomainError('REPEAT_INTERVAL_INVALID', '重复间隔必须是正整数');
  }
  return interval;
}

function validTimeRange(startedAt, endedAt, label = '时间区间', { allowSameTime = false } = {}) {
  const invalidOrder = allowSameTime ? endedAt < startedAt : endedAt <= startedAt;
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt) || invalidOrder) {
    const relation = allowSameTime ? '不能早于' : '必须晚于';
    throw new DomainError('TIME_RANGE_INVALID', `${label}的结束时间${relation}开始时间`);
  }
}

function validLogTiming(startedAt, endedAt, pausedDurationSeconds = 0) {
  const timing = calculateLogTiming(startedAt, endedAt, pausedDurationSeconds);
  if (!isFiniteTimestamp(startedAt)
    || !isFiniteTimestamp(endedAt)
    || !Number.isInteger(pausedDurationSeconds)
    || pausedDurationSeconds < 0
    || timing.intervalTotalSeconds <= pausedDurationSeconds) {
    throw new DomainError('LOG_TIMING_INVALID', '至少要包含 1 秒有效时间~');
  }
  return timing;
}

function validRepeatFrequency(frequency) {
  if (!Object.keys(REPEAT_FREQUENCY).some((key) => REPEAT_FREQUENCY[key] === frequency)) {
    throw new DomainError('REPEAT_FREQUENCY_INVALID', '仅支持每日、每周和每月重复');
  }
  return frequency;
}

function validNullableString(value, label = '可选字段') {
  if (value !== null && typeof value !== 'string') {
    throw new DomainError('NULLABLE_STRING_INVALID', `${label}必须是字符串或 null`);
  }
  return value;
}

function canonicalizeRepeatPattern(input) {
  const frequency = validRepeatFrequency(input && input.frequency);
  const interval = input && input.interval;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new DomainError('REPEAT_INTERVAL_INVALID', '重复间隔必须是正整数');
  }

  if (frequency === REPEAT_FREQUENCY.DAILY) {
    return { frequency, interval, weekdays: [], monthDay: null };
  }

  if (frequency === REPEAT_FREQUENCY.WEEKLY) {
    const weekdays = input && input.weekdays;
    if (!Array.isArray(weekdays)
      || weekdays.length === 0
      || !weekdays.every((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)
      || new Set(weekdays).size !== weekdays.length) {
      throw new DomainError('REPEAT_WEEKDAYS_INVALID', '每周重复必须选择不重复的有效星期');
    }
    return {
      frequency,
      interval,
      weekdays: weekdays.slice().sort((first, second) => first - second),
      monthDay: null
    };
  }

  const monthDay = input && input.monthDay;
  if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) {
    throw new DomainError('REPEAT_MONTH_DAY_INVALID', '每月重复日期必须是 1 到 31 的整数');
  }
  return { frequency, interval, weekdays: [], monthDay };
}

module.exports = {
  requiredTitle,
  limitTitleCodePoints,
  normalizeSnapshotTitles,
  validPriority,
  validInterval,
  validTimeRange,
  validLogTiming,
  validRepeatFrequency,
  validNullableString,
  canonicalizeRepeatPattern
};
