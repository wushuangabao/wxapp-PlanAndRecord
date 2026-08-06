const { createBootstrapState } = require('./services/bootstrap');
const { showError } = require('./utils/page');

App({
  globalData: {
    bootstrap: null,
    storageWarningShown: false
  },

  onLaunch() {
    this.rebuildBootstrap();
  },

  onShow() {
    if (this.globalData.bootstrap && this.globalData.bootstrap.mode === 'ready') {
      const bootstrap = this.globalData.bootstrap;
      const applicationService = bootstrap.applicationService;
      if (bootstrap.recoveryError) {
        const recoveryError = bootstrap.recoveryError;
        bootstrap.recoveryError = null;
        showError(recoveryError);
        return;
      }
      let recovery;
      try {
        recovery = applicationService.recoverTimer();
      } catch (error) {
        if (!error || error.code !== 'STORAGE_CAPACITY_EXCEEDED') throw error;
        showError(error);
        return;
      }
      bootstrap.recovery = recovery;
      this.showStorageWarningIfNeeded(applicationService);
    }
  },

  showStorageWarningIfNeeded(applicationService) {
    if (!applicationService || typeof applicationService.storageUsage !== 'function') return;
    let usage;
    try {
      usage = applicationService.storageUsage();
    } catch (error) {
      console.warn('本地资料库用量读取失败');
      return;
    }
    if (!usage || usage.warning !== true) {
      this.globalData.storageWarningShown = false;
      return;
    }
    if (this.globalData.storageWarningShown) return;
    this.globalData.storageWarningShown = true;

    const handleDisplayFailure = () => {
      this.globalData.storageWarningShown = false;
      console.warn('本地资料库容量提示失败');
    };
    try {
      wx.showModal({
        title: '本地资料库空间接近上限',
        content: '本地已使用 90% 及以上空间，超出后将无法保存新记录。建议先到用户页导出 JSON 备份，再清理不需要的数据。',
        confirmText: '去备份',
        cancelText: '稍后',
        success: (result) => {
          if (result.confirm) wx.switchTab({ url: '/pages/profile/index' });
        },
        fail: handleDisplayFailure
      });
    } catch (error) {
      handleDisplayFailure();
    }
  },

  rebuildBootstrap() {
    const bootstrap = createBootstrapState();
    this.globalData.bootstrap = bootstrap;
    if (bootstrap.mode === 'data-recovery') {
      wx.reLaunch({ url: '/pages/data-recovery/index' });
    }
    return bootstrap;
  }
});
