const { createBootstrapState } = require('./services/bootstrap');

App({
  globalData: {
    bootstrap: null
  },

  onLaunch() {
    this.globalData.bootstrap = createBootstrapState();
  },

  onShow() {
    if (this.globalData.bootstrap) {
      const recovery = this.globalData.bootstrap.applicationService.recoverTimer(Date.now());
      this.globalData.bootstrap.recovery = recovery;
    }
  }
});
