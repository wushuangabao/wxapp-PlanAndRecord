function touchPointFromEvent(event, key = 'changedTouches') {
  const list = event && event[key];
  const touch = list && list[0];
  if (!touch) return null;
  const x = Number(touch.clientX);
  const y = Number(touch.clientY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function rectArea(rect) {
  const width = Number(rect && rect.width);
  const height = Number(rect && rect.height);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    return Math.max(0, width) * Math.max(0, height);
  }
  const left = Number(rect && rect.left);
  const right = Number(rect && rect.right);
  const top = Number(rect && rect.top);
  const bottom = Number(rect && rect.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function isPointInsideRect(point, rect) {
  if (!point || !rect) return false;
  const left = Number(rect.left);
  const right = Number(rect.right);
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  if (![left, right, top, bottom].every(Number.isFinite)) return false;
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

function findRectContainingPoint(rects, point) {
  if (!point || !Array.isArray(rects) || !rects.length) return null;
  const hits = rects.filter((rect) => isPointInsideRect(point, rect));
  if (!hits.length) return null;
  return hits.reduce((smallest, rect) => (
    rectArea(rect) <= rectArea(smallest) ? rect : smallest
  ));
}

function shouldCommitLongPressRelease(event, rect, key = 'changedTouches') {
  if (!rect) return true;
  const point = touchPointFromEvent(event, key);
  if (!point) return true;
  return isPointInsideRect(point, rect);
}

function queryNodeRects(selector, callback, wxApi = typeof wx === 'undefined' ? null : wx) {
  if (!selector || !wxApi || typeof wxApi.createSelectorQuery !== 'function') {
    callback(null);
    return;
  }
  wxApi.createSelectorQuery()
    .selectAll(selector)
    .boundingClientRect((rects) => {
      callback(Array.isArray(rects) ? rects : null);
    })
    .exec();
}

function captureTargetRectFromTouch(selector, event, key, onRect, wxApi) {
  const point = touchPointFromEvent(event, key);
  queryNodeRects(selector, (rects) => {
    onRect(findRectContainingPoint(rects, point));
  }, wxApi);
}

module.exports = {
  captureTargetRectFromTouch,
  findRectContainingPoint,
  isPointInsideRect,
  shouldCommitLongPressRelease,
  touchPointFromEvent
};
