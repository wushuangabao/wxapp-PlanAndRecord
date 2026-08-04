const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  timePickerState,
  resolveEditedTimestamp,
  splitDurationSeconds,
  joinDurationSeconds
} = require('../miniprogram/utils/log-time-editor');

test('未编辑的有效时间戳原样返回并保留毫秒', () => {
  const originalTimestamp = new Date(2026, 7, 4, 9, 8, 7, 987).getTime();

  assert.equal(resolveEditedTimestamp({
    originalTimestamp,
    edited: false,
    date: '2026-08-05',
    time: '10:11:12'
  }), originalTimestamp);
});

test('编辑后的日期时间严格按本地秒级值解析并清零毫秒', () => {
  const resolved = resolveEditedTimestamp({
    originalTimestamp: new Date(2026, 7, 4, 9, 8, 7, 987).getTime(),
    edited: true,
    date: '2026-08-05',
    time: '10:11:12'
  });

  const date = new Date(resolved);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 5);
  assert.equal(date.getHours(), 10);
  assert.equal(date.getMinutes(), 11);
  assert.equal(date.getSeconds(), 12);
  assert.equal(date.getMilliseconds(), 0);
});

test('时间选择状态包含 HH:mm:ss 与对应三列索引', () => {
  const timestamp = new Date(2026, 7, 4, 9, 8, 7, 987).getTime();

  assert.deepEqual(timePickerState(timestamp), {
    value: '09:08:07',
    indices: [9, 8, 7]
  });
});

test('3723 秒可以精确拆分并重新合成', () => {
  const parts = splitDurationSeconds(3723);

  assert.deepEqual(parts, { hours: 1, minutes: 2, seconds: 3 });
  assert.equal(joinDurationSeconds(parts), 3723);
});

test('暂停时长的分钟或秒达到 60 时拒绝合成', () => {
  assert.throws(
    () => joinDurationSeconds({ hours: 0, minutes: 60, seconds: 0 }),
    /分钟/
  );
  assert.throws(
    () => joinDurationSeconds({ hours: 0, minutes: 0, seconds: 60 }),
    /秒/
  );
});

function loadComponent(relativePath) {
  const componentPath = require.resolve(relativePath);
  const originalComponent = global.Component;
  let definition;
  global.Component = (value) => { definition = value; };
  delete require.cache[componentPath];
  require(componentPath);
  global.Component = originalComponent;
  return definition;
}

function componentHarness(definition, properties = {}) {
  const events = [];
  const instance = {
    data: { ...definition.data },
    properties,
    setData(updates) { Object.assign(this.data, updates); },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  };
  Object.entries(definition.methods || {}).forEach(([name, method]) => {
    instance[name] = method.bind(instance);
  });
  return { instance, events };
}

test('秒级时间组件只使用一个三列 multiSelector 并一次发出 HH:mm:ss', () => {
  const definition = loadComponent('../miniprogram/components/second-time-picker/index.js');
  const harness = componentHarness(definition, { value: '09:08:07' });

  definition.properties.value.observer.call(harness.instance, '09:08:07');
  assert.deepEqual(harness.instance.data.indices, [9, 8, 7]);
  harness.instance.onPickerChange({ detail: { value: [10, 11, 12] } });
  assert.deepEqual(harness.events, [{ name: 'change', detail: { value: '10:11:12' } }]);

  const wxml = fs.readFileSync(
    path.join(__dirname, '../miniprogram/components/second-time-picker/index.wxml'),
    'utf8'
  );
  assert.equal((wxml.match(/<picker\b/g) || []).length, 1);
  assert.match(wxml, /mode="multiSelector"/);
  assert.doesNotMatch(wxml, /<input\b/);
});

test('暂停时长组件精确拆分秒数，非法 60 会回退且不发出 change', () => {
  const definition = loadComponent('../miniprogram/components/pause-duration-input/index.js');
  const harness = componentHarness(definition, { value: 3723 });

  definition.properties.value.observer.call(harness.instance, 3723);
  assert.deepEqual(
    {
      hours: harness.instance.data.hours,
      minutes: harness.instance.data.minutes,
      seconds: harness.instance.data.seconds
    },
    { hours: '1', minutes: '2', seconds: '3' }
  );
  harness.instance.onPartInput({ currentTarget: { dataset: { key: 'minutes' } }, detail: { value: '60' } });
  harness.instance.onPartBlur({ currentTarget: { dataset: { key: 'minutes' } } });
  assert.equal(harness.instance.data.minutes, '2');
  assert.deepEqual(harness.events, []);

  harness.instance.onPartInput({ currentTarget: { dataset: { key: 'seconds' } }, detail: { value: '4' } });
  harness.instance.onPartBlur({ currentTarget: { dataset: { key: 'seconds' } } });
  assert.deepEqual(harness.events, [{ name: 'change', detail: { value: 3724 } }]);

  const wxml = fs.readFileSync(
    path.join(__dirname, '../miniprogram/components/pause-duration-input/index.wxml'),
    'utf8'
  );
  assert.equal((wxml.match(/type="number"/g) || []).length, 3);
  assert.doesNotMatch(wxml, /<picker\b/);
});
