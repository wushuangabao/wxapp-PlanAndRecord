const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;
const { TIMER_STATUS } = require('./constants');

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

function calculateIntervalTotalSeconds(startedAt, endedAt) {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt)) {
    return 0;
  }
  return Math.floor((endedAt - startedAt) / SECOND_MS);
}

function calculatePausedDurationSeconds(pauses) {
  const milliseconds = (pauses || []).reduce(
    (total, pause) => total + pause.endedAt - pause.startedAt,
    0
  );
  return Math.floor(milliseconds / SECOND_MS);
}

function calculateLogTiming(startedAt, endedAt, pausedDurationSeconds = 0) {
  const intervalTotalSeconds = calculateIntervalTotalSeconds(startedAt, endedAt);
  const activeDurationSeconds = intervalTotalSeconds - pausedDurationSeconds;
  return {
    intervalTotalSeconds,
    pausedDurationSeconds,
    activeDurationSeconds,
    durationMinutes: Math.ceil(activeDurationSeconds / 60)
  };
}

function calculateDurationMinutes(startedAt, endedAt, pauses) {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt) || endedAt <= startedAt) {
    return 0;
  }
  return toMinutes(Math.max(0, endedAt - startedAt - sumPausedMilliseconds(pauses, endedAt)));
}

function calculateLogDurationMinutes(startedAt, endedAt, pauses) {
  const pausedDurationSeconds = calculatePausedDurationSeconds(pauses);
  const timing = calculateLogTiming(startedAt, endedAt, pausedDurationSeconds);
  return timing.intervalTotalSeconds > pausedDurationSeconds ? timing.durationMinutes : 0;
}

function calculateTimerDurationMinutes(startedAt, endedAt, pauses) {
  return calculateLogDurationMinutes(startedAt, endedAt, pauses);
}

function validOrderedPauses(pauses, startedAt, capturedNow) {
  if (!Array.isArray(pauses)
    || !isFiniteTimestamp(startedAt)
    || !isFiniteTimestamp(capturedNow)
    || capturedNow < startedAt) {
    return false;
  }
  let precedingEnd = startedAt;
  return pauses.every((pause) => {
    if (!pause || typeof pause !== 'object'
      || !isFiniteTimestamp(pause.startedAt)
      || !isFiniteTimestamp(pause.endedAt)
      || pause.endedAt < pause.startedAt
      || pause.startedAt < precedingEnd
      || pause.endedAt > capturedNow) {
      return false;
    }
    precedingEnd = pause.endedAt;
    return true;
  });
}

function validActivePause(timer, capturedNow) {
  if (!timer || !Array.isArray(timer.pauses)) return false;
  if (timer.status === TIMER_STATUS.RUNNING) return timer.pausedAt === null;
  if (timer.status !== TIMER_STATUS.PAUSED || !isFiniteTimestamp(timer.pausedAt)) return false;
  const precedingEnd = timer.pauses.length
    ? timer.pauses[timer.pauses.length - 1].endedAt
    : timer.startedAt;
  return timer.pausedAt >= precedingEnd && timer.pausedAt <= capturedNow;
}

function inspectTimerAt(timer, capturedNow) {
  if (!timer || typeof timer !== 'object'
    || !isFiniteTimestamp(timer.startedAt)
    || !isFiniteTimestamp(capturedNow)) {
    return { valid: false, reason: '计时器时间戳无效，请手工修正并确认记录' };
  }
  if (capturedNow < timer.startedAt) {
    return { valid: false, reason: '系统时钟早于计时开始时间，请手工修正并确认记录' };
  }
  if (!validOrderedPauses(timer.pauses, timer.startedAt, capturedNow)) {
    return { valid: false, reason: '暂停区间不自洽，请手工修正并确认记录' };
  }
  if (!validActivePause(timer, capturedNow)) {
    return { valid: false, reason: '计时状态与暂停时间不一致，请手工修正并确认记录' };
  }
  return { valid: true };
}

function moveTimerToRecoveryDraft(database, timer, capturedNow, reason) {
  const originalTimer = JSON.parse(JSON.stringify(timer));
  database.timer = {
    status: TIMER_STATUS.IDLE,
    startedAt: null,
    pausedAt: null,
    pauses: [],
    draft: {}
  };
  database.recoveryDraft = {
    reason,
    timer: originalTimer,
    createdAt: capturedNow
  };
  return { state: 'draft', recoveryDraft: database.recoveryDraft };
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

module.exports = {
  MINUTE_MS,
  SECOND_MS,
  isFiniteTimestamp,
  toMinutes,
  toTimerMinutes,
  sumPausedMilliseconds,
  calculateIntervalTotalSeconds,
  calculatePausedDurationSeconds,
  calculateLogTiming,
  calculateDurationMinutes,
  calculateLogDurationMinutes,
  calculateTimerDurationMinutes,
  validOrderedPauses,
  validActivePause,
  inspectTimerAt,
  moveTimerToRecoveryDraft,
  localDateKey,
  formatDateTime,
  startOfLocalDay,
  endOfLocalDay,
  parseLocalDateTime,
  toDateInput,
  toTimeInput
};
