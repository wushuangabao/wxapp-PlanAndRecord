const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeRepeatPattern,
  requiredTitle,
  limitTitleCodePoints,
  normalizeSnapshotTitles
} = require('../miniprogram/domain/validation');

const EMOJI = '🙂';

test('requiredTitle 以 Unicode 码点校验并保存 trim 后的标题', () => {
  assert.equal(requiredTitle(`  ${EMOJI.repeat(25)}  `), EMOJI.repeat(25));
  assert.throws(
    () => requiredTitle(EMOJI.repeat(26)),
    (error) => error.code === 'TITLE_TOO_LONG'
  );
});

test('requiredTitle 拒绝空白和非字符串标题', () => {
  assert.throws(() => requiredTitle('   '), (error) => error.code === 'TITLE_REQUIRED');
  assert.throws(() => requiredTitle(123), (error) => error.code === 'TITLE_REQUIRED');
  assert.throws(() => requiredTitle(null), (error) => error.code === 'TITLE_REQUIRED');
});

test('limitTitleCodePoints 将 26 个 emoji 截断为 25 个完整码点', () => {
  const limited = limitTitleCodePoints(EMOJI.repeat(26));
  assert.equal(limited, EMOJI.repeat(25));
  assert.equal(Array.from(limited).length, 25);
});

test('normalizeSnapshotTitles 深拷贝并只 trim 已提供的当前实体标题', () => {
  const input = {
    wishes: [{ title: '  愿望  ', untouched: { value: 1 } }],
    projects: [{
      title: '  项目  '
    }],
    tasks: [{ title: '  任务  ' }],
    calendarEvents: [{ title: '  计划  ' }],
    repeatRules: [{ title: '  重复  ' }]
  };

  const normalized = normalizeSnapshotTitles(input);

  assert.notEqual(normalized, input);
  assert.notEqual(normalized.wishes[0], input.wishes[0]);
  assert.equal(normalized.wishes[0].title, '愿望');
  assert.equal(normalized.projects[0].title, '项目');
  assert.equal(normalized.tasks[0].title, '任务');
  assert.equal(normalized.calendarEvents[0].title, '计划');
  assert.equal(normalized.repeatRules[0].title, '重复');
  assert.equal(input.wishes[0].title, '  愿望  ');
});

test('canonicalizeRepeatPattern 按频率清除无关字段并规范重复日期顺序', () => {
  assert.deepEqual(
    canonicalizeRepeatPattern({
      frequency: 'daily', interval: 2, weekdays: [5, 1], monthDays: [18]
    }),
    { frequency: 'daily', interval: 2, weekdays: [], monthDays: [] }
  );
  assert.deepEqual(
    canonicalizeRepeatPattern({
      frequency: 'weekly', interval: 3, weekdays: [6, 1, 4], monthDays: [18]
    }),
    { frequency: 'weekly', interval: 3, weekdays: [1, 4, 6], monthDays: [] }
  );
  assert.deepEqual(
    canonicalizeRepeatPattern({
      frequency: 'monthly', interval: 1, weekdays: [6, 1], monthDays: [31, 1, 15]
    }),
    { frequency: 'monthly', interval: 1, weekdays: [], monthDays: [1, 15, 31] }
  );
});

test('canonicalizeRepeatPattern 拒绝非法频率专属字段和非正间隔', () => {
  const invalidPatterns = [
    [{ frequency: 'weekly', interval: 1, weekdays: [], monthDays: [] }, 'REPEAT_WEEKDAYS_INVALID'],
    [{ frequency: 'weekly', interval: 1, weekdays: [1, 1], monthDays: [] }, 'REPEAT_WEEKDAYS_INVALID'],
    [{ frequency: 'weekly', interval: 1, weekdays: [7], monthDays: [] }, 'REPEAT_WEEKDAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: [] }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: '15' }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: [1, 1] }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: ['15'] }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: [0] }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDays: [32] }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'monthly', interval: 1, weekdays: [], monthDay: 15 }, 'REPEAT_MONTH_DAYS_INVALID'],
    [{ frequency: 'daily', interval: 0, weekdays: [], monthDays: [] }, 'REPEAT_INTERVAL_INVALID'],
    [{ frequency: 'daily', interval: -1, weekdays: [], monthDays: [] }, 'REPEAT_INTERVAL_INVALID'],
    [{ frequency: 'daily', interval: Number.MAX_SAFE_INTEGER + 1, weekdays: [], monthDays: [] }, 'REPEAT_INTERVAL_INVALID']
  ];

  invalidPatterns.forEach(([pattern, code]) => {
    assert.throws(
      () => canonicalizeRepeatPattern(pattern),
      (error) => error.code === code
    );
  });
});
