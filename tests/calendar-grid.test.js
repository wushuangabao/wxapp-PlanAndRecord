const test = require('node:test');
const assert = require('node:assert/strict');

const { rangeForView, shiftAnchor } = require('../miniprogram/utils/date-range');
const {
  MAX_VISIBLE_LANES,
  buildCalendarBlocks,
  currentTimeLinePosition,
  buildTimeRows,
  defaultPlanDate,
  formatRangeLabel
} = require('../miniprogram/utils/calendar-grid');

test('周范围固定为周一至周日', () => {
  const range = rangeForView(new Date(2026, 7, 8, 12, 0).getTime(), 'week');
  const start = new Date(range.start);
  const end = new Date(range.end);
  assert.deepEqual(
    [start.getFullYear(), start.getMonth(), start.getDate(), start.getDay()],
    [2026, 7, 3, 1]
  );
  assert.deepEqual(
    [end.getFullYear(), end.getMonth(), end.getDate(), end.getDay()],
    [2026, 7, 9, 0]
  );
});

test('当前时间线按所在刻度行的实际时间比例定位，范围外不显示', () => {
  const dayRange = rangeForView(new Date(2026, 7, 8, 12, 0).getTime(), 'day');
  const dayGrid = buildTimeRows(dayRange, 'day');
  assert.equal(
    currentTimeLinePosition(new Date(2026, 7, 8, 8, 30).getTime(), dayRange, dayGrid),
    dayGrid.rowHeight * 8.5
  );

  const weekRange = rangeForView(new Date(2026, 7, 8, 12, 0).getTime(), 'week');
  const weekGrid = buildTimeRows(weekRange, 'week');
  assert.equal(
    currentTimeLinePosition(new Date(2026, 7, 4, 12, 0).getTime(), weekRange, weekGrid),
    weekGrid.rowHeight * 1.5
  );
  assert.equal(
    currentTimeLinePosition(new Date(2026, 7, 10, 12, 0).getTime(), weekRange, weekGrid),
    null
  );
});

test('周标题按同月、跨月和跨年消除日期歧义', () => {
  assert.equal(
    formatRangeLabel(rangeForView(new Date(2026, 7, 8).getTime(), 'week'), 'week'),
    '2026年8月3日–9日'
  );
  assert.equal(
    formatRangeLabel(rangeForView(new Date(2026, 8, 1).getTime(), 'week'), 'week'),
    '2026年8月31日–9月6日'
  );
  assert.equal(
    formatRangeLabel(rangeForView(new Date(2027, 0, 1).getTime(), 'week'), 'week'),
    '2026年12月28日–2027年1月3日'
  );
});

test('四种视图生成对应时间刻度', () => {
  const anchor = new Date(2026, 7, 8).getTime();
  assert.equal(buildTimeRows(rangeForView(anchor, 'year'), 'year').rows.length, 12);
  assert.equal(buildTimeRows(rangeForView(anchor, 'month'), 'month').rows.length, 31);
  const week = buildTimeRows(rangeForView(anchor, 'week'), 'week');
  assert.equal(week.rows.length, 7);
  assert.equal(week.rowHeight, 128);
  assert.equal(week.canvasHeight, 896);
  assert.equal(week.rows[0].label, '周一·3号');
  assert.equal(week.rows[6].label, '周日·9号');
  const day = buildTimeRows(rangeForView(anchor, 'day'), 'day');
  assert.equal(day.rows.length, 24);
  assert.equal(day.rows[0].label, '00:00');
  assert.equal(day.rows[23].label, '23:00');
  assert.equal(day.rows[0].style, 'top: 0rpx; height: 88rpx;');
  assert.equal(day.rows[9].style, 'top: 792rpx; height: 88rpx;');
  assert.equal(day.rows[23].style, 'top: 2024rpx; height: 88rpx;');
  assert.equal(day.rows[23].top + day.rowHeight, day.canvasHeight);
  assert.equal('terminalLabel' in day, false);
});

test('粗粒度按整月或整日排布，日视图按小时精确排布并标记跨范围', () => {
  const yearRange = rangeForView(new Date(2026, 5, 1).getTime(), 'year');
  const yearGrid = buildTimeRows(yearRange, 'year');
  const yearBlocks = buildCalendarBlocks([{
    id: 'cross-year',
    type: 'plan',
    title: '跨年计划',
    startedAt: new Date(2025, 11, 15).getTime(),
    endedAt: new Date(2026, 1, 2).getTime()
  }], yearRange, 'year', yearGrid);
  assert.equal(yearBlocks[0].blockTop, 0);
  assert.equal(yearBlocks[0].blockBottom, yearGrid.rowHeight * 2);
  assert.equal(yearBlocks[0].continuesBefore, true);

  const dayRange = rangeForView(new Date(2026, 7, 8).getTime(), 'day');
  const dayGrid = buildTimeRows(dayRange, 'day');
  const dayBlocks = buildCalendarBlocks([{
    id: 'precise',
    type: 'confirmed',
    title: '精确计划',
    startedAt: new Date(2026, 7, 8, 9, 30).getTime(),
    endedAt: new Date(2026, 7, 8, 10, 30).getTime()
  }], dayRange, 'day', dayGrid);
  assert.equal(dayBlocks[0].blockTop, dayGrid.rowHeight * 9.5);
  assert.equal(dayBlocks[0].blockBottom, dayGrid.rowHeight * 10.5);
  assert.equal(dayBlocks[0].blockTop - dayGrid.rows[9].top, dayGrid.rowHeight * 0.5);

  const shortBlocks = buildCalendarBlocks([{
    id: 'short',
    type: 'plan',
    title: '短计划',
    startedAt: new Date(2026, 7, 8, 16, 50).getTime(),
    endedAt: new Date(2026, 7, 8, 17, 0).getTime()
  }, {
    id: 'near-end',
    type: 'plan',
    title: '临近午夜',
    startedAt: new Date(2026, 7, 8, 23, 55).getTime(),
    endedAt: new Date(2026, 7, 9, 0, 0).getTime()
  }], dayRange, 'day', dayGrid);
  const shortBlock = shortBlocks.find((item) => item.id === 'short');
  const nearEndBlock = shortBlocks.find((item) => item.id === 'near-end');
  assert.equal(shortBlock.blockBottom - shortBlock.blockTop, 54);
  assert.equal(nearEndBlock.blockBottom - nearEndBlock.blockTop, 54);
  assert.equal(nearEndBlock.blockBottom, dayGrid.canvasHeight);
});

test('重叠条目超过可见轨道上限时用最后一条轨道聚合为 +N', () => {
  const range = rangeForView(new Date(2026, 7, 8).getTime(), 'day');
  const grid = buildTimeRows(range, 'day');
  const overlappingItems = Array.from({ length: 9 }, (_, index) => ({
    id: `overlap-${index + 1}`,
    type: 'plan',
    title: `重叠计划 ${index + 1}`,
    displayTime: `2026-08-08 09:00 – 2026-08-08 10:00`,
    startedAt: new Date(2026, 7, 8, 9, 0).getTime(),
    endedAt: new Date(2026, 7, 8, 10, 0).getTime()
  }));
  const blocks = buildCalendarBlocks(overlappingItems, range, 'day', grid);

  assert.equal(blocks.length, MAX_VISIBLE_LANES);
  assert.deepEqual(
    blocks.filter((item) => !item.isAggregate).map((item) => item.id),
    ['overlap-1', 'overlap-2', 'overlap-3', 'overlap-4', 'overlap-5']
  );
  const aggregate = blocks.find((item) => item.isAggregate);
  assert.equal(aggregate.title, '+4');
  assert.equal(aggregate.hiddenCount, 4);
  assert.deepEqual(
    aggregate.aggregateItems.map((item) => item.id),
    ['overlap-6', 'overlap-7', 'overlap-8', 'overlap-9']
  );
  assert.equal(aggregate.lane, MAX_VISIBLE_LANES - 1);
  blocks.forEach((item) => assert.match(item.blockStyle, /width: \d+\.\d{2}%;/));

  const boundaryBlocks = buildCalendarBlocks(
    overlappingItems.slice(0, MAX_VISIBLE_LANES),
    range,
    'day',
    grid
  );
  assert.equal(boundaryBlocks.length, MAX_VISIBLE_LANES);
  assert.equal(boundaryBlocks.some((item) => item.isAggregate), false);
});

test('传递重叠按实际拥挤区段分别聚合，不隐藏中间独占的长条目', () => {
  const range = rangeForView(new Date(2026, 7, 8, 12, 0).getTime(), 'day');
  const grid = buildTimeRows(range, 'day');
  const timestamp = (hour) => new Date(2026, 7, 8, hour, 0).getTime();
  const items = [{
    id: 'bridge',
    type: 'plan',
    title: '连接两个拥挤时段的长计划',
    startedAt: timestamp(9),
    endedAt: timestamp(12)
  }];
  for (let index = 1; index <= 6; index += 1) {
    items.push({
      id: `early-${index}`,
      type: 'plan',
      title: `早间计划 ${index}`,
      startedAt: timestamp(9),
      endedAt: timestamp(10)
    });
    items.push({
      id: `late-${index}`,
      type: 'plan',
      title: `午间计划 ${index}`,
      startedAt: timestamp(11),
      endedAt: timestamp(12)
    });
  }

  const blocks = buildCalendarBlocks(items, range, 'day', grid);
  const aggregates = blocks.filter((item) => item.isAggregate);
  const bridgeBlocks = blocks.filter((item) => item.id === 'bridge');

  assert.equal(aggregates.length, 2);
  assert.deepEqual(aggregates.map((item) => item.title), ['+2', '+2']);
  assert.ok(aggregates.every((item) => item.blockBottom - item.blockTop === grid.rowHeight));
  assert.equal(aggregates.some((item) => (
    item.blockTop < grid.rowHeight * 10 && item.blockBottom > grid.rowHeight * 11
  )), false);
  assert.equal(bridgeBlocks.length, 1);
  assert.equal(bridgeBlocks[0].blockTop, grid.rowHeight * 9);
  assert.equal(bridgeBlocks[0].blockBottom, grid.rowHeight * 12);
  assert.equal(bridgeBlocks[0].lane, 0);
  assert.equal(bridgeBlocks[0].isSegmented, false);
  assert.equal(new Set(blocks.map((item) => item.renderKey)).size, blocks.length);
});

test('错峰开始的重叠计划保持为连续矩形，仅聚合提示按拥挤区段变化', () => {
  const range = rangeForView(new Date(2026, 7, 8, 12, 0).getTime(), 'day');
  const grid = buildTimeRows(range, 'day');
  const plan = (id, hour, minute, endHour, endMinute) => ({
    id,
    type: 'plan',
    title: id,
    startedAt: new Date(2026, 7, 8, hour, minute).getTime(),
    endedAt: new Date(2026, 7, 8, endHour, endMinute).getTime()
  });
  const items = [
    plan('plan-1', 20, 55, 21, 55),
    plan('plan-2', 20, 57, 21, 57),
    plan('plan-3', 21, 0, 22, 0),
    plan('plan-4', 21, 7, 22, 7),
    plan('plan-5', 21, 7, 22, 7),
    plan('plan-6', 21, 20, 22, 20),
    plan('plan-7', 21, 26, 22, 26)
  ];

  const blocks = buildCalendarBlocks(items, range, 'day', grid);
  items.forEach((item) => {
    const itemBlocks = blocks.filter((block) => block.id === item.id);
    assert.ok(itemBlocks.length <= 1);
    if (itemBlocks.length) assert.equal(itemBlocks[0].isSegmented, false);
  });
  assert.ok(blocks.some((item) => item.isAggregate && item.title === '+2'));
  assert.equal(new Set(blocks.map((item) => item.renderKey)).size, blocks.length);
});

test('新增计划在历史范围回填今天，在今天或未来范围保留锚点日期', () => {
  const now = new Date(2026, 7, 8, 12, 0).getTime();
  assert.equal(defaultPlanDate(new Date(2026, 7, 1).getTime(), now), '2026-08-08');
  assert.equal(defaultPlanDate(new Date(2026, 7, 8).getTime(), now), '2026-08-08');
  assert.equal(defaultPlanDate(new Date(2026, 7, 20).getTime(), now), '2026-08-20');
});

test('月和年翻页会把月末日期收敛到目标范围而不跳过月份', () => {
  const january31 = new Date(2026, 0, 31, 9, 0).getTime();
  const february = new Date(shiftAnchor(january31, 'month', 1));
  assert.deepEqual(
    [february.getFullYear(), february.getMonth(), february.getDate()],
    [2026, 1, 28]
  );

  const leapDay = new Date(2024, 1, 29, 9, 0).getTime();
  const nextYear = new Date(shiftAnchor(leapDay, 'year', 1));
  assert.deepEqual(
    [nextYear.getFullYear(), nextYear.getMonth(), nextYear.getDate()],
    [2025, 1, 28]
  );
});
