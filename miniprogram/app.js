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
      this.globalData.bootstrap.recovery = this.globalData.bootstrap.applicationService.recoverTimer(Date.now());
    }
  }
});
