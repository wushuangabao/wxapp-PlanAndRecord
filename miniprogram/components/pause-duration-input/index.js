const { splitDurationSeconds, joinDurationSeconds } = require('../../utils/log-time-editor');

function stringParts(value) {
  let parts;
  try {
    parts = splitDurationSeconds(value);
  } catch (error) {
    parts = splitDurationSeconds(0);
  }
  return {
    hours: String(parts.hours),
    minutes: String(parts.minutes),
    seconds: String(parts.seconds),
    lastValidHours: String(parts.hours),
    lastValidMinutes: String(parts.minutes),
    lastValidSeconds: String(parts.seconds)
  };
}

Component({
  properties: {
    value: {
      type: Number,
      value: 0,
      observer(value) {
        this.setData(stringParts(value));
      }
    }
  },

  data: stringParts(0),

  methods: {
    onPartInput(event) {
      this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
    },

    onPartBlur() {
      try {
        const parts = {
          hours: Number(this.data.hours),
          minutes: Number(this.data.minutes),
          seconds: Number(this.data.seconds)
        };
        const value = joinDurationSeconds(parts);
        const normalized = stringParts(value);
        this.setData(normalized);
        this.triggerEvent('change', { value });
      } catch (error) {
        this.setData({
          hours: this.data.lastValidHours,
          minutes: this.data.lastValidMinutes,
          seconds: this.data.lastValidSeconds
        });
      }
    }
  }
});
