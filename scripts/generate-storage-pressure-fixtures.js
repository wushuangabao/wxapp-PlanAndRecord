const fs = require('node:fs');
const path = require('node:path');

const { createInitialDatabase } = require('../miniprogram/domain/entities');
const {
  IMPORT_MODE,
  createImportAnalysis,
  resolveImportAnalysis
} = require('../miniprogram/repository/json-import');
const { parseJsonSnapshot } = require('../miniprogram/repository/json-snapshot');
const {
  DATABASE_STORAGE_LIMIT_BYTES,
  buildStorageUsage,
  utf8ByteLength
} = require('../miniprogram/repository/storage-capacity');

const GENERATED_AT = 1785974400000;
const LOG_STARTED_AT = 1704067200000;
const OUTPUTS = [
  {
    fileName: 'plan-and-record-storage-warning-94pct.json',
    title: '容量预警数据（94%）',
    targetBytes: Math.floor(DATABASE_STORAGE_LIMIT_BYTES * 0.94)
  },
  {
    fileName: 'plan-and-record-storage-over-limit-102pct.json',
    title: '容量超限数据（102%）',
    targetBytes: Math.floor(DATABASE_STORAGE_LIMIT_BYTES * 1.02)
  }
];

function createFixture(slug, title) {
  return {
    schemaVersion: 1,
    localProfile: {
      id: `profile_${slug}`,
      createdAt: GENERATED_AT,
      updatedAt: GENERATED_AT
    },
    wishes: [{
      id: `wish_${slug}`,
      title,
      createdAt: GENERATED_AT,
      updatedAt: GENERATED_AT
    }],
    projects: [],
    tasks: [],
    calendarEvents: [],
    repeatRules: [],
    occurrenceExceptions: [],
    timeLogs: [],
    timer: {
      status: 'idle',
      startedAt: null,
      pausedAt: null,
      pauses: [],
      draft: {}
    },
    recoveryDraft: null,
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT
  };
}

function createPressureLog(slug, index) {
  const startedAt = LOG_STARTED_AT + index * 120000;
  const sequence = String(index + 1).padStart(5, '0');
  return {
    id: `log_${slug}_${sequence}`,
    schemaVersion: 1,
    startedAt,
    endedAt: startedAt + 60000,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    projectId: null,
    projectNameSnapshot: null,
    taskId: null,
    taskNameSnapshot: null,
    calendarEventId: null,
    calendarEventSummarySnapshot: null,
    note: `storage-pressure-${sequence}`,
    status: 'confirmed',
    source: 'file',
    originRuleId: null,
    originOccurrenceId: null,
    originRuleSummarySnapshot: null,
    tags: ['压力测试'],
    createdAt: startedAt + 60000,
    updatedAt: startedAt + 60000
  };
}

function replacementDatabase(fixture) {
  const imported = parseJsonSnapshot(JSON.stringify(fixture));
  const local = createInitialDatabase(GENERATED_AT);
  const analysis = createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.REPLACE,
    now: GENERATED_AT
  });
  return resolveImportAnalysis(analysis).database;
}

function replacementBytes(fixture) {
  return buildStorageUsage(replacementDatabase(fixture)).databaseBytes;
}

function appendLogAndTrackSize(fixture, slug, index, rawBytes) {
  const log = createPressureLog(slug, index);
  const logBytes = utf8ByteLength(JSON.stringify(log));
  const separatorBytes = fixture.timeLogs.length ? 1 : 0;
  fixture.timeLogs.push(log);
  return rawBytes + separatorBytes + logBytes;
}

function fitFixtureToTarget(output) {
  const slug = output.fileName.includes('warning') ? 'pressure_warning' : 'pressure_over_limit';
  const fixture = createFixture(slug, output.title);
  let rawBytes = utf8ByteLength(JSON.stringify(fixture));
  const rootReplacementDelta = replacementBytes(fixture) - rawBytes;
  const targetRawBytes = output.targetBytes - rootReplacementDelta;

  for (let index = 0; ; index += 1) {
    const nextLog = createPressureLog(slug, index);
    const nextBytes = utf8ByteLength(JSON.stringify(nextLog)) + (fixture.timeLogs.length ? 1 : 0);
    if (rawBytes + nextBytes > targetRawBytes - 2048) break;
    rawBytes = appendLogAndTrackSize(fixture, slug, index, rawBytes);
  }

  if (!fixture.timeLogs.length) {
    rawBytes = appendLogAndTrackSize(fixture, slug, 0, rawBytes);
  }

  const paddingLog = fixture.timeLogs[fixture.timeLogs.length - 1];
  paddingLog.note += 'x'.repeat(targetRawBytes - rawBytes);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const difference = output.targetBytes - replacementBytes(fixture);
    if (difference === 0) break;
    if (difference > 0) {
      paddingLog.note += 'x'.repeat(difference);
    } else {
      paddingLog.note = paddingLog.note.slice(0, difference);
    }
  }

  const database = replacementDatabase(fixture);
  const usage = buildStorageUsage(database);
  if (usage.databaseBytes !== output.targetBytes) {
    throw new Error(`无法把 ${output.fileName} 调整到目标字节数`);
  }

  const outputPath = path.join(__dirname, '..', 'docs', output.fileName);
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture)}\n`, 'utf8');
  return {
    fileName: output.fileName,
    timeLogCount: fixture.timeLogs.length,
    fileBytes: fs.statSync(outputPath).size,
    databaseBytes: usage.databaseBytes,
    percent: usage.percent,
    warning: usage.warning,
    exceeded: usage.exceeded
  };
}

const summaries = OUTPUTS.map(fitFixtureToTarget);
process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
