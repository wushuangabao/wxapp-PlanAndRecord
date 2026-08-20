const { formatLunarDateLabel } = require('../../utils/lunar-date');

Component({
  properties: {
    timestamp: {
      type: Number,
      value: 0
    },
    compact: {
      type: Boolean,
      value: false
    }
  },

  data: {
    label: ''
  },

  observers: {
    timestamp(value) {
      this.setData({
        label: formatLunarDateLabel(value)
      });
    }
  }
});
