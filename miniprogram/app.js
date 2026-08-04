const { createBootstrapState } = require('./services/bootstrap');

App({
  globalData: {
    bootstrap: null
  },

  onLaunch() {
    this.rebuildBootstrap();
  },

  onShow() {
    if (this.globalData.bootstrap && this.globalData.bootstrap.mode === 'ready') {
      const recovery = this.globalData.bootstrap.applicationService.recoverTimer();
      this.globalData.bootstrap.recovery = recovery;
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
