const APP_SCHEMA_VERSION = 1;
const MAX_ACTIVE_PROJECTS = 5;
const MAX_PLAN_PRIORITY = 3;
const MAX_TAGS_PER_LOG = 10;
const MAX_TAG_LENGTH = 5;
const MAX_TITLE_LENGTH = 25;
const MAX_TIMER_SPAN_MS = 24 * 60 * 60 * 1000;

const LOG_STATUS = {
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed'
};

const LOG_SOURCE = {
  TIMER: 'timer',
  RULE: 'rule',
  OCR: 'ocr',
  FILE: 'file',
  MANUAL: 'manual'
};

const TIMER_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused'
};

const TASK_STATUS = {
  TODO: 'todo',
  COMPLETED: 'completed'
};

const PROJECT_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived'
};

const REPEAT_FREQUENCY = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly'
};

module.exports = {
  APP_SCHEMA_VERSION,
  MAX_ACTIVE_PROJECTS,
  MAX_PLAN_PRIORITY,
  MAX_TAGS_PER_LOG,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TIMER_SPAN_MS,
  LOG_STATUS,
  LOG_SOURCE,
  TIMER_STATUS,
  TASK_STATUS,
  PROJECT_STATUS,
  REPEAT_FREQUENCY
};
