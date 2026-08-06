const { formatDateTime, toDateInput, toTimeInput } = require('../domain/time');

function getService() {
  const bootstrap = getApp().globalData.bootstrap;
  if (bootstrap && bootstrap.mode === 'data-recovery') {
    throw new Error('本地资料库正等待恢复，应用服务不可用');
  }
  if (!bootstrap || !bootstrap.applicationService) {
    throw new Error('应用服务尚未初始化');
  }
  return bootstrap.applicationService;
}

function getPreferenceStore() {
  const bootstrap = getApp().globalData.bootstrap;
  if (!bootstrap || !bootstrap.preferences) {
    throw new Error('界面设置存储尚未初始化');
  }
  return bootstrap.preferences;
}

function getRecoveryService() {
  const bootstrap = getApp().globalData.bootstrap;
  if (!bootstrap || bootstrap.mode !== 'data-recovery' || !bootstrap.recoveryService) {
    throw new Error('当前不处于数据恢复模式');
  }
  return bootstrap.recoveryService;
}

function showStorageCapacityExit() {
  let bootstrap = null;
  try {
    bootstrap = getApp().globalData.bootstrap;
  } catch (error) {
    // 启动状态不可用时按普通页面降级。
  }
  const inRecovery = bootstrap && bootstrap.mode === 'data-recovery';
  const showUnavailable = (error) => {
    const message = error && (error.errMsg || error.message);
    if (typeof message === 'string' && /cancel/i.test(message)) return;
    wx.showToast({
      title: inRecovery
        ? '无法显示存储处理选项，请在恢复页导出原始数据'
        : '无法显示存储处理选项，请前往用户页导出备份',
      icon: 'none'
    });
  };
  try {
    wx.showActionSheet({
      alertText: '本地资料库空间不足，请先备份或选择后续存储方式',
      itemList: inRecovery
        ? ['前往恢复页导出原始数据', '转为云端存储']
        : ['导出 JSON 备份', '转为云端存储'],
      success(result) {
        if (result.tapIndex === 0) {
          if (inRecovery) {
            wx.reLaunch({ url: '/pages/data-recovery/index' });
          } else {
            wx.switchTab({ url: '/pages/profile/index' });
          }
          return;
        }
        if (result.tapIndex !== 1) return;
        try {
          if (!bootstrap || !bootstrap.ports || !bootstrap.ports.sync) {
            throw new Error('当前版本暂不支持云端存储');
          }
          bootstrap.ports.sync.execute();
        } catch (error) {
          wx.showToast({
            title: error && error.code === 'FEATURE_UNAVAILABLE' && error.message
              ? error.message
              : '当前版本暂不支持云端存储',
            icon: 'none'
          });
        }
      },
      fail: showUnavailable
    });
  } catch (error) {
    showUnavailable();
  }
}

function showError(error) {
  if (error && error.code === 'STORAGE_CAPACITY_EXCEEDED') {
    showStorageCapacityExit();
    return;
  }
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
  const profileId = profileIdForSnapshot(snapshot);
  if (!profileId) return null;
  try {
    const stored = getPreferenceStore().read('RECENT_LOG_HIGHLIGHT', profileId, null);
    return stored && typeof stored.logId === 'string' && stored.logId ? stored.logId : null;
  } catch (error) {
    return null;
  }
}

function writeRecentLogHighlight(snapshot, logId) {
  if (typeof logId !== 'string' || !logId) return false;
  const profileId = profileIdForSnapshot(snapshot);
  if (!profileId) return false;
  try {
    return getPreferenceStore().write('RECENT_LOG_HIGHLIGHT', profileId, { logId });
  } catch (error) {
    return false;
  }
}

module.exports = {
  getService,
  getRecoveryService,
  getPreferenceStore,
  showStorageCapacityExit,
  showError,
  showSaved,
  selectorData,
  defaultDateTime,
  formatDateTime,
  readRecentLogHighlight,
  writeRecentLogHighlight
};
