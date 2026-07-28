const { MAX_PLAN_PRIORITY, MAX_TITLE_LENGTH, REPEAT_FREQUENCY } = require('./constants');
const { DomainError } = require('./errors');
const { isFiniteTimestamp } = require('./time');

function requiredTitle(value, label = '标题') {
  const title = String(value || '').trim();
  if (!title) {
    throw new DomainError('TITLE_REQUIRED', `${label}不能为空`);
  }
  if (title.length > MAX_TITLE_LENGTH) {
    throw new DomainError('TITLE_TOO_LONG', `${label}不能超过 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return title;
}

function validPercentage(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) {
    throw new DomainError('PERCENTAGE_INVALID', `${label}必须是 0 到 100 的整数`);
  }
  return number;
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

function validTimeRange(startedAt, endedAt, label = '时间区间') {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt) || endedAt <= startedAt) {
    throw new DomainError('TIME_RANGE_INVALID', `${label}的结束时间必须晚于开始时间`);
  }
}

function validRepeatFrequency(frequency) {
  if (!Object.keys(REPEAT_FREQUENCY).some((key) => REPEAT_FREQUENCY[key] === frequency)) {
    throw new DomainError('REPEAT_FREQUENCY_INVALID', '仅支持每日、每周和每月重复');
  }
  return frequency;
}

module.exports = {
  requiredTitle,
  validPercentage,
  validPriority,
  validInterval,
  validTimeRange,
  validRepeatFrequency
};
