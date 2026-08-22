const { localDateKey, startOfLocalDay } = require('../domain/time');
const { resolveRestDayMark, restDayAriaSuffix } = require('./cn-holidays');

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const ROW_HEIGHTS = {
  year: 88,
  month: 80,
  week: 128,
  day: 88
};
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MIN_BLOCK_HEIGHT = 54;
const MAX_VISIBLE_LANES = 6;
const LANE_GAP_PERCENT = 2;
// 750rpx 视口扣除页面横向留白、画布边框、138rpx 时间轴和块列表内边距。
const COARSE_BLOCK_LIST_WIDTH_RPX = 538;
const COARSE_BLOCK_MAX_WIDTH_RPX = 300;
const COARSE_BLOCK_GAP_RPX = 8;
const COARSE_BLOCK_TITLE_HORIZONTAL_PADDING_RPX = 16;
// 块宽保持不变，把原内边距预算中的 8rpx 留给字体度量与像素取整误差。
const COARSE_BLOCK_TEXT_RENDERING_TOLERANCE_RPX = 8;

function formatDateParts(timestamp) {
  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: WEEKDAY_NAMES[date.getDay()]
  };
}

function formatRangeLabel(range, view) {
  const start = formatDateParts(range.start);
  const end = formatDateParts(range.end);
  if (view === 'year') return `${start.year}年`;
  if (view === 'month') return `${start.year}年${start.month}月`;
  if (view === 'day') return `${start.year}年${start.month}月${start.day}日 · ${start.weekday}`;
  if (start.year !== end.year) {
    return `${start.year}年${start.month}月${start.day}日–${end.year}年${end.month}月${end.day}日`;
  }
  if (start.month !== end.month) {
    return `${start.year}年${start.month}月${start.day}日–${end.month}月${end.day}日`;
  }
  return `${start.year}年${start.month}月${start.day}日–${end.day}日`;
}

function createRow(start, end, label, index, rowHeight, restDay = null) {
  const top = index * rowHeight;
  return {
    key: `${start}`,
    start,
    end,
    label,
    index,
    top,
    style: `top: ${top}rpx; height: ${rowHeight}rpx;`,
    restDayKind: restDay ? restDay.kind : '',
    restDayName: restDay && restDay.name ? restDay.name : '',
    restDayAria: restDayAriaSuffix(restDay)
  };
}

function buildTimeRows(range, view) {
  const rowHeight = ROW_HEIGHTS[view] || ROW_HEIGHTS.week;
  const rows = [];
  if (view === 'year') {
    const date = new Date(range.start);
    for (let index = 0; index < 12; index += 1) {
      const start = new Date(date.getFullYear(), index, 1).getTime();
      const end = new Date(date.getFullYear(), index + 1, 1).getTime();
      rows.push(createRow(start, end, `${index + 1}月`, index, rowHeight));
    }
  } else if (view === 'day') {
    for (let index = 0; index < 24; index += 1) {
      const start = new Date(range.start);
      start.setHours(index, 0, 0, 0);
      const end = new Date(range.start);
      end.setHours(index + 1, 0, 0, 0);
      rows.push(createRow(
        start.getTime(),
        end.getTime(),
        `${String(index).padStart(2, '0')}:00`,
        index,
        rowHeight
      ));
    }
  } else {
    const count = view === 'week'
      ? 7
      : new Date(new Date(range.start).getFullYear(), new Date(range.start).getMonth() + 1, 0).getDate();
    for (let index = 0; index < count; index += 1) {
      const startDate = new Date(range.start);
      startDate.setDate(startDate.getDate() + index);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      const label = `${WEEKDAY_NAMES[startDate.getDay()]}·${startDate.getDate()}号`;
      rows.push(createRow(
        startDate.getTime(),
        endDate.getTime(),
        label,
        index,
        rowHeight,
        resolveRestDayMark(startDate.getTime(), view)
      ));
    }
  }
  return {
    rows,
    rowHeight,
    canvasHeight: rows.length * rowHeight
  };
}

function currentTimeLinePlacement(timestamp, range, grid) {
  if (!Number.isFinite(timestamp) || timestamp < range.start || timestamp > range.end) {
    return null;
  }
  const rowIndex = grid.rows.findIndex((row) => timestamp >= row.start && timestamp < row.end);
  if (rowIndex < 0) return null;
  const row = grid.rows[rowIndex];
  const duration = row.end - row.start;
  const progress = duration > 0 ? (timestamp - row.start) / duration : 0;
  return {
    rowIndex,
    progress: Math.max(0, Math.min(1, progress))
  };
}

function currentTimeLinePosition(timestamp, range, grid) {
  const placement = currentTimeLinePlacement(timestamp, range, grid);
  if (!placement) return null;
  const row = grid.rows[placement.rowIndex];
  return row.top + placement.progress * grid.rowHeight;
}

function visualType(item) {
  if (item.virtual || item.type === 'plan') return 'plan';
  return item.type === 'candidate' ? 'candidate' : 'confirmed';
}

function planPriorityClass(item, type = visualType(item)) {
  if (type !== 'plan') return '';
  const priority = Number(item.priority);
  const safePriority = Number.isInteger(priority) && priority >= 1 && priority <= 3
    ? priority
    : 1;
  return `plan-priority-${safePriority}`;
}

function rowIndexForTimestamp(rows, timestamp) {
  const index = rows.findIndex((row) => timestamp >= row.start && timestamp < row.end);
  return index < 0 ? rows.length - 1 : index;
}

function coarseCharacterWidthRpx(character) {
  const codePoint = character.codePointAt(0);
  if (/\s/.test(character)) return 8;
  if ((codePoint >= 0x2e80 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || codePoint > 0xffff) return 24;
  if (/[A-Z]/.test(character)) return 16;
  if (/[a-z0-9]/.test(character)) return 14;
  return 12;
}

function coarseBlockWidthRpx(block) {
  const borderWidth = visualType(block) === 'candidate' ? 4 : 7;
  const titleWidth = Array.from(String(block.title || '')).reduce(
    (width, character) => width + coarseCharacterWidthRpx(character),
    0
  );
  return Math.min(
    COARSE_BLOCK_MAX_WIDTH_RPX,
    COARSE_BLOCK_TITLE_HORIZONTAL_PADDING_RPX
      + COARSE_BLOCK_TEXT_RENDERING_TOLERANCE_RPX
      + borderWidth
      + titleWidth
  );
}

function yearViewVirtualRuleKey(item) {
  if (!item.virtual) return null;
  return item.ruleId || item.originRuleId || null;
}

function coarseCollapsedVisibleLineCount(view) {
  return view === 'week' ? 2 : 1;
}

function packCoarseBlocks(blocks) {
  const lines = [];
  blocks.forEach((block) => {
    const blockWidth = coarseBlockWidthRpx(block);
    const sizedBlock = { ...block, coarseWidth: blockWidth };
    let targetLine = lines.find((line) => (
      line.width + COARSE_BLOCK_GAP_RPX + blockWidth <= COARSE_BLOCK_LIST_WIDTH_RPX
    ));
    if (!targetLine) {
      targetLine = { width: 0, blocks: [] };
      lines.push(targetLine);
    }
    targetLine.width += (targetLine.blocks.length ? COARSE_BLOCK_GAP_RPX : 0) + blockWidth;
    targetLine.blocks.push(sizedBlock);
  });
  return {
    blocks: lines.flatMap((line, coarseLineIndex) => line.blocks.map((block) => ({
      ...block,
      coarseLineIndex
    }))),
    lineCount: lines.length
  };
}

function buildCoarseCalendarRows(items, range, view, grid = buildTimeRows(range, view)) {
  if (view === 'day') return grid.rows.map((row) => ({ ...row, blocks: [] }));
  const rows = grid.rows.map((row) => ({ ...row, blocks: [] }));
  const seenRuleIdsByRow = view === 'year' ? rows.map(() => new Set()) : null;
  (items || []).forEach((item, sourceIndex) => {
    if (!Number.isFinite(item.startedAt)
      || !Number.isFinite(item.endedAt)
      || item.endedAt <= item.startedAt) return;
    let segmentIndex = 0;
    rows.forEach((row, rowIndex) => {
      if (item.endedAt <= row.start || item.startedAt >= row.end) return;
      if (seenRuleIdsByRow) {
        const ruleKey = yearViewVirtualRuleKey(item);
        if (ruleKey) {
          if (seenRuleIdsByRow[rowIndex].has(ruleKey)) return;
          seenRuleIdsByRow[rowIndex].add(ruleKey);
        }
      }
      const type = visualType(item);
      row.blocks.push({
        ...item,
        visualType: type,
        priorityClass: planPriorityClass(item, type),
        rowIndex: row.index,
        renderKey: `${item.id || 'calendar-item'}:coarse:${row.index}:${sourceIndex}`,
        isFirstVisibleSegment: segmentIndex === 0,
        continuesBefore: item.startedAt < row.start,
        continuesAfter: item.endedAt > row.end
      });
      segmentIndex += 1;
    });
  });
  return rows.map((row) => {
    const packed = packCoarseBlocks(row.blocks);
    return {
      ...row,
      blocks: packed.blocks,
      coarseLineCount: packed.lineCount
    };
  });
}

function rawBlock(item, range, view, grid) {
  const rangeEndExclusive = range.end + 1;
  const visibleStart = Math.max(item.startedAt, range.start);
  const visibleEnd = Math.min(item.endedAt, rangeEndExclusive);
  if (!Number.isFinite(visibleStart) || !Number.isFinite(visibleEnd) || visibleEnd <= visibleStart) {
    return null;
  }
  let top;
  let bottom;
  if (view === 'day') {
    top = ((visibleStart - range.start) / HOUR_MS) * grid.rowHeight;
    bottom = ((visibleEnd - range.start) / HOUR_MS) * grid.rowHeight;
  } else {
    const startIndex = rowIndexForTimestamp(grid.rows, visibleStart);
    const endIndex = rowIndexForTimestamp(grid.rows, Math.max(visibleStart, visibleEnd - 1));
    top = startIndex * grid.rowHeight;
    bottom = (endIndex + 1) * grid.rowHeight;
  }
  const unclippedHeight = Math.max(MIN_BLOCK_HEIGHT, bottom - top);
  const adjustedTop = Math.min(top, Math.max(0, grid.canvasHeight - unclippedHeight));
  const type = visualType(item);
  return {
    ...item,
    visualType: type,
    priorityClass: planPriorityClass(item, type),
    continuesBefore: item.startedAt < range.start,
    continuesAfter: item.endedAt > rangeEndExclusive,
    blockTop: adjustedTop,
    blockBottom: Math.min(grid.canvasHeight, adjustedTop + unclippedHeight)
  };
}

function assignLanes(blocks, { protectedItemId } = {}) {
  if (!blocks.length) return [];
  const sources = blocks.map((block, sourceIndex) => ({
    ...block,
    sourceIndex,
    sourceKey: `${block.id || 'calendar-item'}:${sourceIndex}`
  }));
  const groups = [];
  let currentGroup = [];
  let currentGroupBottom = -Infinity;

  function widthForLaneCount(laneCount) {
    return (100 - LANE_GAP_PERCENT * (laneCount + 1)) / laneCount;
  }

  function blockStyle(block, lane, laneCount) {
    const width = widthForLaneCount(laneCount);
    const left = LANE_GAP_PERCENT + lane * (width + LANE_GAP_PERCENT);
    const height = Math.max(1, block.blockBottom - block.blockTop);
    return `top: ${block.blockTop.toFixed(2)}rpx; height: ${height.toFixed(2)}rpx; left: ${left.toFixed(2)}%; width: ${width.toFixed(2)}%;`;
  }

  function overlaps(left, right) {
    return left.blockTop < right.blockBottom && left.blockBottom > right.blockTop;
  }

  function hiddenPresentation(hidden, groupIndex) {
    const ordinaryPieces = [];
    const aggregates = [];
    if (!hidden.length) return { ordinaryPieces, aggregates };

    const components = [];
    let component = [];
    let componentBottom = -Infinity;
    hidden
      .slice()
      .sort((left, right) => (
        left.blockTop - right.blockTop
          || right.blockBottom - left.blockBottom
          || left.sourceIndex - right.sourceIndex
      ))
      .forEach((block) => {
        if (component.length && block.blockTop >= componentBottom) {
          components.push(component);
          component = [];
          componentBottom = -Infinity;
        }
        component.push(block);
        componentBottom = Math.max(componentBottom, block.blockBottom);
      });
    if (component.length) components.push(component);

    // 最后一轨按重叠连通分量呈现：单项仍是普通块；两项以上合成一个覆盖
    // 成员区间并集的 +N 块。每个可操作入口都至少继承一个原块的最小高度。
    components.forEach((connected, componentIndex) => {
      const aggregateItems = connected
        .slice()
        .sort((left, right) => left.sourceIndex - right.sourceIndex);
      if (aggregateItems.length === 1) {
        const block = aggregateItems[0];
        ordinaryPieces.push({
          ...block,
          lane: MAX_VISIBLE_LANES - 1,
          isSegmented: false
        });
        return;
      }
      const blockTop = Math.min(...aggregateItems.map((block) => block.blockTop));
      const blockBottom = Math.max(
        blockTop + MIN_BLOCK_HEIGHT,
        ...aggregateItems.map((block) => block.blockBottom)
      );
      aggregates.push({
        id: `aggregate_${groupIndex}_${componentIndex}_${Math.round(blockTop)}`,
        type: 'aggregate',
        title: `+${aggregateItems.length}`,
        displayKind: '重叠条目',
        displayTime: '',
        visualType: 'aggregate',
        isAggregate: true,
        isSegmented: false,
        aggregateItems,
        hiddenCount: aggregateItems.length,
        continuesBefore: false,
        continuesAfter: false,
        blockTop,
        blockBottom,
        lane: MAX_VISIBLE_LANES - 1
      });
    });
    return { ordinaryPieces, aggregates };
  }

  sources
    .slice()
    .sort((left, right) => (
      left.blockTop - right.blockTop
        || right.blockBottom - left.blockBottom
        || left.sourceIndex - right.sourceIndex
    ))
    .forEach((block) => {
      if (currentGroup.length && block.blockTop >= currentGroupBottom) {
        groups.push(currentGroup);
        currentGroup = [];
        currentGroupBottom = -Infinity;
      }
      currentGroup.push(block);
      currentGroupBottom = Math.max(currentGroupBottom, block.blockBottom);
    });
  if (currentGroup.length) groups.push(currentGroup);

  const rendered = [];
  groups.forEach((group, groupIndex) => {
    const lanes = [];
    const withLanes = group
      .slice()
      .sort((left, right) => (
        right.blockBottom - left.blockBottom
          || left.blockTop - right.blockTop
          || left.sourceIndex - right.sourceIndex
      ))
      .map((block) => {
        let lane = lanes.findIndex((laneBlocks) => (
          laneBlocks.every((laneBlock) => !overlaps(laneBlock, block))
        ));
        if (lane < 0) {
          lane = lanes.length;
          lanes.push([]);
        }
        const withLane = { ...block, lane };
        lanes[lane].push(withLane);
        return withLane;
      });
    const renderedLaneCount = Math.min(lanes.length, MAX_VISIBLE_LANES);
    const visibleLaneLimit = lanes.length > MAX_VISIBLE_LANES
      ? MAX_VISIBLE_LANES - 1
      : MAX_VISIBLE_LANES;
    let ordinary = withLanes.filter((block) => block.lane < visibleLaneLimit);
    let hidden = withLanes.filter((block) => block.lane >= visibleLaneLimit);
    let presentation = hiddenPresentation(hidden, groupIndex);
    const protectedBlock = hidden.find((block) => block.id === protectedItemId);
    const protectedIsAggregated = protectedBlock && presentation.aggregates.some((aggregate) => (
      aggregate.aggregateItems.some((block) => block.sourceKey === protectedBlock.sourceKey)
    ));

    if (protectedIsAggregated) {
      const replacement = Array.from({ length: visibleLaneLimit }, (_, lane) => ({
        lane,
        conflicts: ordinary.filter((block) => block.lane === lane && overlaps(block, protectedBlock))
      }))
        .filter((candidate) => candidate.conflicts.length > 0)
        .sort((left, right) => (
          left.conflicts.length - right.conflicts.length || right.lane - left.lane
        ))[0];
      if (replacement) {
        const displacedKeys = new Set(replacement.conflicts.map((block) => block.sourceKey));
        ordinary = ordinary
          .filter((block) => !displacedKeys.has(block.sourceKey))
          .concat({ ...protectedBlock, lane: replacement.lane });
        hidden = withLanes.filter((block) => (
          block.sourceKey !== protectedBlock.sourceKey
            && (block.lane >= visibleLaneLimit || displacedKeys.has(block.sourceKey))
        ));
        presentation = hiddenPresentation(hidden, groupIndex);
      }
    }

    ordinary.concat(presentation.ordinaryPieces).forEach((block) => rendered.push({
      ...block,
      isSegmented: Boolean(block.isSegmented),
      renderKey: block.renderKey || block.id,
      blockStyle: blockStyle(block, block.lane, renderedLaneCount)
    }));
    presentation.aggregates.forEach((aggregate) => {
      const { hiddenKey, ...cleanAggregate } = aggregate;
      rendered.push({
        ...cleanAggregate,
        renderKey: aggregate.id,
        blockStyle: blockStyle(aggregate, aggregate.lane, renderedLaneCount)
      });
    });
  });

  return rendered
    .sort((left, right) => left.blockTop - right.blockTop || left.lane - right.lane)
    .map((piece) => {
      const {
        sourceIndex,
        sourceKey,
        ...cleanPiece
      } = piece;
      if (piece.isAggregate) {
        const aggregateItems = piece.aggregateItems.map((item) => {
          const { sourceIndex: ignoredIndex, sourceKey: ignoredKey, ...cleanItem } = item;
          return cleanItem;
        });
        return {
          ...cleanPiece,
          aggregateItems
        };
      }
      return cleanPiece;
    });
}
function buildCalendarBlocks(items, range, view, grid = buildTimeRows(range, view), options = {}) {
  return assignLanes((items || [])
    .map((item) => rawBlock(item, range, view, grid))
    .filter(Boolean), options);
}

function defaultPlanDate(anchor, now = Date.now()) {
  const selected = startOfLocalDay(anchor) < startOfLocalDay(now) ? now : anchor;
  return localDateKey(selected);
}

module.exports = {
  DAY_MS,
  MAX_VISIBLE_LANES,
  ROW_HEIGHTS,
  buildCalendarBlocks,
  buildCoarseCalendarRows,
  buildTimeRows,
  coarseCollapsedVisibleLineCount,
  currentTimeLinePlacement,
  currentTimeLinePosition,
  defaultPlanDate,
  formatRangeLabel
};
