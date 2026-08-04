const { MAX_TAGS_PER_LOG, MAX_TAG_LENGTH } = require('./constants');
const { DomainError } = require('./errors');

function normalizeTag(value) {
  if (typeof value !== 'string') {
    throw new DomainError('TAGS_INVALID', '标签必须是字符串');
  }

  return value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function tagLengthUnits(tag) {
  return Array.from(tag).reduce(
    (units, character) => {
      const codePoint = character.codePointAt(0);
      return units + (codePoint >= 0x21 && codePoint <= 0x7E ? 1 : 2);
    },
    0
  );
}

function normalizeTags(tags, options = {}) {
  if (!Array.isArray(tags)) {
    throw new DomainError('TAGS_INVALID', '标签必须是字符串数组');
  }

  const enforceLimits = options.enforceLimits !== false;
  const normalizedTags = [];
  const seen = new Set();

  tags.forEach((value) => {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag)) {
      return;
    }
    if (enforceLimits && tagLengthUnits(tag) > MAX_TAG_LENGTH * 2) {
      throw new DomainError(
        'TAG_TOO_LONG',
        `字数太多了~`
      );
    }
    seen.add(tag);
    normalizedTags.push(tag);
  });

  if (enforceLimits && normalizedTags.length > MAX_TAGS_PER_LOG) {
    throw new DomainError(
      'TAG_COUNT_EXCEEDED',
      `一条记录最多添加 ${MAX_TAGS_PER_LOG} 个标签，请先移除一个标签后再添加`
    );
  }

  return normalizedTags;
}

function parseTagsText(value, options = {}) {
  const text = value === undefined || value === null ? '' : String(value);
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"' && current.trim() === '') {
      current = '';
      quoted = true;
    } else if (character === ',' || character === '，') {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }

  if (quoted) {
    throw new DomainError('TAGS_TEXT_INVALID', '标签中的双引号没有闭合');
  }
  values.push(current);
  return normalizeTags(values, options);
}

function formatTagsText(tags) {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    throw new DomainError('TAGS_INVALID', '标签必须是字符串数组');
  }
  return tags.map((tag) => (
    /[,，"]/.test(tag)
      ? `"${tag.replace(/"/g, '""')}"`
      : tag
  )).join('，');
}

function tagsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((tag, index) => tag === right[index]);
}

module.exports = {
  normalizeTag,
  normalizeTags,
  parseTagsText,
  formatTagsText,
  tagsEqual
};
