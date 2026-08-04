function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function validTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

function timePickerState(timestamp) {
  if (!validTimestamp(timestamp)) {
    throw new Error('时间戳无效');
  }
  const date = new Date(timestamp);
  const indices = [date.getHours(), date.getMinutes(), date.getSeconds()];
  return {
    value: indices.map(twoDigits).join(':'),
    indices
  };
}

function resolveEditedTimestamp(input) {
  const value = input || {};
  if (value.edited === false && validTimestamp(value.originalTimestamp)) {
    return value.originalTimestamp;
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.date || '');
  const timeMatch = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value.time || '');
  if (!dateMatch || !timeMatch) {
    throw new Error('日期或时间格式无效');
  }
  const parts = [...dateMatch.slice(1), ...timeMatch.slice(1)].map(Number);
  const [year, month, day, hours, minutes, seconds] = parts;
  if (month < 1 || month > 12
    || day < 1 || day > 31
    || hours < 0 || hours > 23
    || minutes < 0 || minutes > 59
    || seconds < 0 || seconds > 59) {
    throw new Error('日期或时间格式无效');
  }
  const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
  if (date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hours
    || date.getMinutes() !== minutes
    || date.getSeconds() !== seconds) {
    throw new Error('日期或时间格式无效');
  }
  return date.getTime();
}

function splitDurationSeconds(total) {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('暂停时长必须是非负整数秒');
  }
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60
  };
}

function joinDurationSeconds(parts) {
  const value = parts || {};
  if (!Number.isInteger(value.hours) || value.hours < 0) {
    throw new Error('暂停小时必须是非负整数');
  }
  if (!Number.isInteger(value.minutes) || value.minutes < 0 || value.minutes > 59) {
    throw new Error('暂停分钟必须是 0 到 59 的整数');
  }
  if (!Number.isInteger(value.seconds) || value.seconds < 0 || value.seconds > 59) {
    throw new Error('暂停秒必须是 0 到 59 的整数');
  }
  return value.hours * 3600 + value.minutes * 60 + value.seconds;
}

module.exports = {
  timePickerState,
  resolveEditedTimestamp,
  splitDurationSeconds,
  joinDurationSeconds
};
