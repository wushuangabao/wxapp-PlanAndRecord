const { formatDateTime, toDateInput, toTimeInput } = require('../domain/time');

const RECENT_LOG_HIGHLIGHT_STORAGE_KEY = 'plan-and-record.recent-log-highlight';

function getService() {
  const bootstrap = getApp().globalData.bootstrap;
  if (!bootstrap || !bootstrap.applicationService) {
    throw new Error('应用服务尚未初始化');
  }
  return bootstrap.applicationService;
}

function showError(error) {
  wx.showToast({ title: error && error.message ? error.message : '操作失败，请重试', icon: 'none', duration: 3000 });
}

function showSaved(message = '已保存') {
  wx.showToast({ title: message, icon: 'success' });
}

function selectorData(snapshot) {
  return {
    projects: [{ id: '', title: '未关联项目' }].concat(snapshot.projects.filter((item) => item.status === 'active')),
    tasks: [{ id: '', title: '未关联任务' }].concat(snapshot.tasks.filter((item) => item.status !== 'completed')),
    events: [{ id: '', title: '未关联计划块' }].concat(snapshot.calendarEvents)
  };
}

function defaultDateTime(timestamp = Date.now()) {
  return {
    date: toDateInput(timestamp),
    time: toTimeInput(timestamp)
  };
}

function profileIdForSnapshot(snapshot) {
  const profileId = snapshot && snapshot.localProfile && snapshot.localProfile.id;
  return typeof profileId === 'string' && profileId ? profileId : null;
}

function readRecentLogHighlight(snapshot) {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return null;
  try {
    const stored = wx.getStorageSync(RECENT_LOG_HIGHLIGHT_STORAGE_KEY);
    if (typeof stored === 'string' && stored) return stored;
    if (!stored || typeof stored !== 'object' || typeof stored.logId !== 'string' || !stored.logId) return null;
    const profileId = profileIdForSnapshot(snapshot);
    if (profileId && stored.profileId && stored.profileId !== profileId) return null;
    return stored.logId;
  } catch (error) {
    return null;
  }
}

function writeRecentLogHighlight(snapshot, logId) {
  if (typeof wx === 'undefined' || typeof wx.setStorageSync !== 'function') return false;
  if (typeof logId !== 'string' || !logId) return false;
  const profileId = profileIdForSnapshot(snapshot);
  try {
    wx.setStorageSync(RECENT_LOG_HIGHLIGHT_STORAGE_KEY, profileId ? { profileId, logId } : { logId });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  RECENT_LOG_HIGHLIGHT_STORAGE_KEY,
  getService,
  showError,
  showSaved,
  selectorData,
  defaultDateTime,
  formatDateTime,
  readRecentLogHighlight,
  writeRecentLogHighlight
};
