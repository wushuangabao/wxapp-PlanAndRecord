const { localDateKey, startOfLocalDay } = require('../domain/time');

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

function createRow(start, end, label, index, rowHeight) {
  const top = index * rowHeight;
  return {
    key: `${start}`,
    start,
    end,
    label,
    index,
    top,
    style: `top: ${top}rpx; height: ${rowHeight}rpx;`
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
      const label = view === 'week'
        ? `${WEEKDAY_NAMES[startDate.getDay()]}·${startDate.getDate()}号`
        : `${startDate.getDate()}号`;
      rows.push(createRow(startDate.getTime(), endDate.getTime(), label, index, rowHeight));
    }
  }
  return {
    rows,
    rowHeight,
    canvasHeight: rows.length * rowHeight
  };
}

function currentTimeLinePosition(timestamp, range, grid) {
  if (!Number.isFinite(timestamp) || timestamp < range.start || timestamp > range.end) {
    return null;
  }
  const rowIndex = grid.rows.findIndex((row) => timestamp >= row.start && timestamp < row.end);
  if (rowIndex < 0) return null;
  const row = grid.rows[rowIndex];
  const duration = row.end - row.start;
  const progress = duration > 0 ? (timestamp - row.start) / duration : 0;
  return (rowIndex + Math.max(0, Math.min(1, progress))) * grid.rowHeight;
}

function visualType(item) {
  if (item.virtual || item.type === 'plan') return 'plan';
  return item.type === 'candidate' ? 'candidate' : 'confirmed';
}

function rowIndexForTimestamp(rows, timestamp) {
  const index = rows.findIndex((row) => timestamp >= row.start && timestamp < row.end);
  return index < 0 ? rows.length - 1 : index;
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
  return {
    ...item,
    visualType: visualType(item),
    continuesBefore: item.startedAt < range.start,
    continuesAfter: item.endedAt > rangeEndExclusive,
    blockTop: adjustedTop,
    blockBottom: Math.min(grid.canvasHeight, adjustedTop + unclippedHeight)
  };
}

function assignLanes(blocks) {
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
    const ordinary = withLanes.filter((block) => block.lane < visibleLaneLimit);
    const hidden = withLanes.filter((block) => block.lane >= visibleLaneLimit);
    const soloHiddenKeys = new Set();
    const aggregates = [];

    if (hidden.length) {
      const boundaries = Array.from(new Set(hidden.flatMap((block) => [
        block.blockTop,
        block.blockBottom
      ]))).sort((left, right) => left - right);
      let openAggregate = null;
      for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
        const segmentTop = boundaries[boundaryIndex];
        const segmentBottom = boundaries[boundaryIndex + 1];
        if (segmentBottom <= segmentTop) continue;
        const activeHidden = hidden.filter((block) => (
          block.blockTop < segmentBottom && block.blockBottom > segmentTop
        ));
        if (activeHidden.length === 1) {
          soloHiddenKeys.add(activeHidden[0].sourceKey);
          openAggregate = null;
          continue;
        }
        if (activeHidden.length < 2) {
          openAggregate = null;
          continue;
        }
        const hiddenKey = activeHidden.map((block) => block.sourceKey).sort().join('|');
        if (openAggregate && openAggregate.hiddenKey === hiddenKey
          && openAggregate.blockBottom === segmentTop) {
          openAggregate.blockBottom = segmentBottom;
          continue;
        }
        openAggregate = {
          id: `aggregate_${groupIndex}_${aggregates.length}_${Math.round(segmentTop)}`,
          type: 'aggregate',
          title: `+${activeHidden.length}`,
          displayKind: '重叠条目',
          displayTime: '',
          visualType: 'aggregate',
          isAggregate: true,
          isSegmented: true,
          aggregateItems: activeHidden,
          hiddenCount: activeHidden.length,
          continuesBefore: false,
          continuesAfter: false,
          blockTop: segmentTop,
          blockBottom: segmentBottom,
          lane: MAX_VISIBLE_LANES - 1,
          hiddenKey
        };
        aggregates.push(openAggregate);
      }
    }

    hidden.forEach((block) => {
      if (soloHiddenKeys.has(block.sourceKey)) {
        ordinary.push({ ...block, lane: MAX_VISIBLE_LANES - 1 });
      }
    });
    ordinary.forEach((block) => rendered.push({
      ...block,
      isSegmented: false,
      renderKey: block.id,
      blockStyle: blockStyle(block, block.lane, renderedLaneCount)
    }));
    aggregates.forEach((aggregate) => {
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
function buildCalendarBlocks(items, range, view, grid = buildTimeRows(range, view)) {
  return assignLanes((items || [])
    .map((item) => rawBlock(item, range, view, grid))
    .filter(Boolean));
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
  buildTimeRows,
  currentTimeLinePosition,
  defaultPlanDate,
  formatRangeLabel
};
