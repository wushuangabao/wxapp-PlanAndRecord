const MINUTE_MS = 60 * 1000;

function isFiniteTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

function toMinutes(milliseconds) {
  return Math.max(0, Math.round(milliseconds / MINUTE_MS));
}

function toTimerMinutes(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(milliseconds / MINUTE_MS));
}

function sumPausedMilliseconds(pauses, now) {
  return (pauses || []).reduce((total, pause) => {
    if (!isFiniteTimestamp(pause.startedAt)) {
      return total;
    }
    const endedAt = isFiniteTimestamp(pause.endedAt) ? pause.endedAt : now;
    return endedAt >= pause.startedAt ? total + endedAt - pause.startedAt : total;
  }, 0);
}

function calculateDurationMinutes(startedAt, endedAt, pauses) {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return toMinutes(Math.max(0, endedAt - startedAt - sumPausedMilliseconds(pauses, endedAt)));
}

function calculateTimerDurationMinutes(startedAt, endedAt, pauses) {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return toTimerMinutes(Math.max(0, endedAt - startedAt - sumPausedMilliseconds(pauses, endedAt)));
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatDateTime(timestamp) {
  if (!isFiniteTimestamp(timestamp)) {
    return '';
  }
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function endOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

function parseLocalDateTime(dateValue, timeValue) {
  if (!dateValue || !timeValue) {
    return NaN;
  }
  const timestamp = new Date(`${dateValue}T${timeValue}:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function toDateInput(timestamp) {
  return localDateKey(timestamp);
}

function toTimeInput(timestamp) {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function overlapMinutes(first, second) {
  const startedAt = Math.max(first.startedAt, second.startedAt);
  const endedAt = Math.min(first.endedAt, second.endedAt);
  return endedAt > startedAt ? toMinutes(endedAt - startedAt) : 0;
}

module.exports = {
  MINUTE_MS,
  isFiniteTimestamp,
  toMinutes,
  toTimerMinutes,
  sumPausedMilliseconds,
  calculateDurationMinutes,
  calculateTimerDurationMinutes,
  localDateKey,
  formatDateTime,
  startOfLocalDay,
  endOfLocalDay,
  parseLocalDateTime,
  toDateInput,
  toTimeInput,
  overlapMinutes
};
