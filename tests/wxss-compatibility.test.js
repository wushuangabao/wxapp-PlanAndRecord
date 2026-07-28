const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function listWxssFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? listWxssFiles(entryPath)
      : entry.name.endsWith('.wxss') ? [entryPath] : [];
  });
}

test('WXSS 不使用微信编译器不支持的通配选择器', () => {
  const miniprogramRoot = path.join(__dirname, '..', 'miniprogram');
  const unsupportedUniversalSelector = /(^|[,{]\s*|[>+~]\s*)\*(?=[\s.#:[>+~,{])/m;

  for (const filePath of listWxssFiles(miniprogramRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      source,
      unsupportedUniversalSelector,
      `${path.relative(miniprogramRoot, filePath)} 包含微信 WXSS 编译器不支持的通配选择器`
    );
  }
});
