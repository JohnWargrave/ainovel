// Text helpers shared by the CMS editor, the importers and the reader. Chapter content is stored as
// plain text: paragraphs separated by one blank line, no markup.

// CJK scripts have no spaces between words; counting each character as one word keeps the
// reading-time estimate sane for them instead of treating a whole paragraph as one word.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/gu;

export function countWords(text: string): number {
  const cjkCount = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ').trim();
  const wordCount = rest === '' ? 0 : rest.split(/\s+/u).length;
  return cjkCount + wordCount;
}

// Normalizes line endings and whitespace, drops control characters, and collapses runs of blank
// lines so every paragraph boundary is exactly one empty line.
export function normalizeContent(text: string): string {
  return (
    text
      .replace(/\r\n?/gu, '\n')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufeff]/gu, '')
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/gu, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim()
  );
}

export function slugify(input: string): string {
  const slug = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[\u0111\u0110]/gu, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  return slug === '' ? 'novel' : slug;
}

// Lower-cased and accent-folded so "tien hiep" finds "Tiên Hiệp".
export function foldForSearch(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[\u0111\u0110]/gu, 'd')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export function buildSearchText(novel: {
  title: string;
  alt_titles?: readonly string[];
  author?: string | null;
}): string {
  return foldForSearch([novel.title, ...(novel.alt_titles ?? []), novel.author ?? ''].join(' '));
}
