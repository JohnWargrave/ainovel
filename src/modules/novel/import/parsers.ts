import JSZip from 'jszip';
import mammoth from 'mammoth';
import iconv from 'iconv-lite';
import { HTMLElement, parse as parseHtml } from 'node-html-parser';
import { AppError } from '../../../lib/errors.js';
import type { NovelImportFormat } from '../../../db/types.js';
import { countWords, normalizeContent } from '../text.js';
import { detectImageType } from '../storage.js';

export interface ParsedChapter {
  title: string;
  content: string;
}

export interface ParsedNovel {
  title: string | null;
  author: string | null;
  description: string | null;
  language: string | null;
  tags: string[];
  cover: { data: Buffer; contentType: string; ext: string } | null;
  chapters: ParsedChapter[];
}

export interface ParseOptions {
  // Admin-supplied line pattern for chapter headings in TXT/MD/DOCX. Matched per line.
  chapterPattern?: string | null;
  fallbackTitle: string;
}

// One heading per line: "Chương 12: ...", "Chapter 3", "Hồi 5", "第十章 ...".
const DEFAULT_HEADING =
  /^\s*(?:(?:chương|chuong|chapter|hồi|hoi|quyển|quyen)\s+[0-9ivxlcdm]+\b.*|第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章回节].*)$/iu;

const MAX_PATTERN_LENGTH = 200;
const MAX_HEADING_LINE_LENGTH = 200;

function headingMatcher(pattern: string | null | undefined): (line: string) => boolean {
  if (!pattern)
    return (line) => line.length <= MAX_HEADING_LINE_LENGTH && DEFAULT_HEADING.test(line);
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new AppError('INVALID_CHAPTER_PATTERN', 'Chapter pattern is too long', 400);
  }
  let regex: RegExp;
  try {
    // Admin-only input, applied to bounded single lines below.
    // eslint-disable-next-line security/detect-non-literal-regexp
    regex = new RegExp(pattern, 'iu');
  } catch {
    throw new AppError(
      'INVALID_CHAPTER_PATTERN',
      'Chapter pattern is not a valid regular expression',
      400,
    );
  }
  return (line) => line.length <= MAX_HEADING_LINE_LENGTH && regex.test(line);
}

// UTF-8 (with or without BOM) and UTF-16 are detected; anything that is not valid UTF-8 is read as
// Windows-1258, the legacy Vietnamese code page most old TXT novels use.
export function decodeText(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return iconv.decode(data.subarray(2), 'utf-16le');
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff)
    return iconv.decode(data.subarray(2), 'utf-16be');
  const body =
    data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
      ? data.subarray(3)
      : data;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return iconv.decode(body, 'windows-1258');
  }
}

// Splits plain text into chapters on heading lines. Text before the first heading becomes a
// "prologue" chapter only if it is substantial; otherwise it is treated as front matter and dropped.
export function splitChapters(text: string, isHeading: (line: string) => boolean): ParsedChapter[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const chapters: { title: string; lines: string[] }[] = [];
  const preface: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed !== '' && isHeading(trimmed)) {
      chapters.push({ title: trimmed, lines: [] });
    } else if (chapters.length === 0) {
      preface.push(line);
    } else {
      chapters[chapters.length - 1]?.lines.push(line);
    }
  }
  const result = chapters.map((chapter) => ({
    title: chapter.title,
    content: normalizeContent(chapter.lines.join('\n')),
  }));
  const prefaceText = normalizeContent(preface.join('\n'));
  if (result.length === 0) {
    return prefaceText === '' ? [] : [{ title: '', content: prefaceText }];
  }
  if (countWords(prefaceText) >= 200) result.unshift({ title: 'Mở đầu', content: prefaceText });
  return result;
}

function emptyNovel(fallbackTitle: string): ParsedNovel {
  return {
    title: fallbackTitle,
    author: null,
    description: null,
    language: null,
    tags: [],
    cover: null,
    chapters: [],
  };
}

function parseTxt(data: Buffer, options: ParseOptions): ParsedNovel[] {
  const novel = emptyNovel(options.fallbackTitle);
  novel.chapters = splitChapters(decodeText(data), headingMatcher(options.chapterPattern));
  return [novel];
}

// Markdown: "# Title" (first, single) names the novel; "## Heading" lines split chapters. Without
// level-2 headings, falls back to the plain-text heading rules.
function parseMarkdown(data: Buffer, options: ParseOptions): ParsedNovel[] {
  const text = decodeText(data);
  const novel = emptyNovel(options.fallbackTitle);
  const lines = text.split(/\r?\n/u);
  const h1 = lines.filter((line) => /^#\s+\S/u.test(line));
  const h2 = lines.filter((line) => /^##\s+\S/u.test(line));
  let body = text;
  const [heading] = h1;
  if (heading !== undefined && h1.length === 1 && h2.length > 0) {
    novel.title = heading.replace(/^#\s+/u, '').trim();
    body = lines.filter((line) => line !== heading).join('\n');
  }
  const strip = (value: string): string =>
    value
      .replace(/^#{1,6}\s+/gmu, '')
      .replace(/\*\*(.+?)\*\*/gu, '$1')
      .replace(/__(.+?)__/gu, '$1');
  const matcher =
    h2.length > 0
      ? (line: string) => /^##\s+\S/u.test(line)
      : headingMatcher(options.chapterPattern);
  novel.chapters = splitChapters(body, matcher).map((chapter) => ({
    title: strip(chapter.title).trim(),
    content: normalizeContent(strip(chapter.content)),
  }));
  return [novel];
}

function htmlToText(root: HTMLElement): string {
  for (const node of root.querySelectorAll('script, style, img, svg')) node.remove();
  const paragraphs = root.structuredText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return normalizeContent(paragraphs.join('\n\n'));
}

function dropLeadingTitle(content: string, title: string): string {
  if (title === '') return content;
  const [first, ...rest] = content.split('\n\n');
  return first?.trim() === title.trim() ? rest.join('\n\n') : content;
}

async function parseDocx(data: Buffer, options: ParseOptions): Promise<ParsedNovel[]> {
  const novel = emptyNovel(options.fallbackTitle);
  const { value: html } = await mammoth.convertToHtml({ buffer: data });
  const root = parseHtml(html);
  const blocks = root.childNodes.filter((node): node is HTMLElement => node instanceof HTMLElement);
  const hasHeadings = blocks.some((node) => /^h[12]$/iu.test(node.rawTagName));
  if (!hasHeadings) {
    novel.chapters = splitChapters(
      blocks.map((node) => node.text).join('\n'),
      headingMatcher(options.chapterPattern),
    );
    return [novel];
  }
  const chapters: { title: string; paragraphs: string[] }[] = [];
  for (const node of blocks) {
    if (/^h[12]$/iu.test(node.rawTagName)) {
      chapters.push({ title: node.text.trim(), paragraphs: [] });
    } else if (chapters.length > 0) {
      chapters[chapters.length - 1]?.paragraphs.push(node.text);
    }
  }
  novel.chapters = chapters.map((chapter) => ({
    title: chapter.title,
    content: normalizeContent(chapter.paragraphs.join('\n\n')),
  }));
  return [novel];
}

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    const name = match[1];
    if (name !== undefined) attributes[name.toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

function xmlText(xml: string, tag: string): string | null {
  // Tag names are fixed literals from this file (dc:title, dc:creator, ...).
  // eslint-disable-next-line security/detect-non-literal-regexp
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'iu').exec(xml);
  if (!match?.[1]) return null;
  const text = parseHtml(match[1]).text.trim();
  return text === '' ? null : text;
}

function resolvePath(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const segment of decodeURIComponent(href.split('#')[0] ?? '').split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

async function parseEpub(data: Buffer, options: ParseOptions): Promise<ParsedNovel[]> {
  const zip = await JSZip.loadAsync(data);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const rootPath = container
    ? xmlAttributes(/<rootfile\b[^>]*>/iu.exec(container)?.[0] ?? '')['full-path']
    : undefined;
  const opf = rootPath ? await zip.file(rootPath)?.async('string') : undefined;
  if (!rootPath || !opf)
    throw new AppError('IMPORT_PARSE_FAILED', 'Not a valid EPUB: package document missing', 400);

  const manifest = new Map<string, { href: string; type: string; properties: string }>();
  for (const match of opf.matchAll(/<item\b[^>]*>/giu)) {
    const attrs = xmlAttributes(match[0]);
    if (attrs['id'] && attrs['href']) {
      manifest.set(attrs['id'], {
        href: resolvePath(rootPath, attrs['href']),
        type: attrs['media-type'] ?? '',
        properties: attrs['properties'] ?? '',
      });
    }
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/giu)]
    .map((match) => xmlAttributes(match[0]))
    .filter((attrs) => attrs['linear'] !== 'no')
    .map((attrs) => attrs['idref'])
    .filter((id): id is string => typeof id === 'string');

  // Chapter titles from the table of contents (EPUB3 nav or EPUB2 NCX), keyed by file path.
  const tocTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find((item) =>
    item.properties.split(/\s+/u).includes('nav'),
  );
  const ncxItem = [...manifest.values()].find((item) => item.type === 'application/x-dtbncx+xml');
  if (navItem) {
    const nav = await zip.file(navItem.href)?.async('string');
    for (const anchor of nav ? parseHtml(nav).querySelectorAll('nav a') : []) {
      const href = anchor.getAttribute('href');
      if (href) tocTitles.set(resolvePath(navItem.href, href), anchor.text.trim());
    }
  } else if (ncxItem) {
    const ncx = await zip.file(ncxItem.href)?.async('string');
    for (const match of ncx?.matchAll(
      /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)>/giu,
    ) ?? []) {
      const src = xmlAttributes(match[2] ?? '')['src'];
      if (src) tocTitles.set(resolvePath(ncxItem.href, src), parseHtml(match[1] ?? '').text.trim());
    }
  }

  const novel = emptyNovel(options.fallbackTitle);
  novel.title = xmlText(opf, 'dc:title') ?? options.fallbackTitle;
  novel.author = xmlText(opf, 'dc:creator');
  novel.description = xmlText(opf, 'dc:description');
  novel.language = xmlText(opf, 'dc:language');
  novel.tags = [...opf.matchAll(/<dc:subject\b[^>]*>([\s\S]*?)<\/dc:subject>/giu)]
    .map((match) => parseHtml(match[1] ?? '').text.trim())
    .filter((tag) => tag !== '')
    .slice(0, 20);

  const coverMeta = /<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/iu.exec(opf)?.[0];
  const coverItem =
    [...manifest.values()].find((item) => item.properties.split(/\s+/u).includes('cover-image')) ??
    (coverMeta ? manifest.get(xmlAttributes(coverMeta)['content'] ?? '') : undefined);
  if (coverItem) {
    const coverData = await zip.file(coverItem.href)?.async('nodebuffer');
    const type = coverData ? detectImageType(coverData) : null;
    if (coverData && type) novel.cover = { data: coverData, ...type };
  }

  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item || item === navItem || !/html|xml/iu.test(item.type)) continue;
    const html = await zip.file(item.href)?.async('string');
    if (!html) continue;
    const root = parseHtml(html);
    const body = root.querySelector('body') ?? root;
    const heading = body.querySelector('h1, h2, h3')?.text.trim() ?? '';
    const title = tocTitles.get(item.href) ?? heading;
    const content = dropLeadingTitle(htmlToText(body), title);
    // Cover pages, title pages and similar near-empty documents are not chapters.
    if (countWords(content) < 20 && !tocTitles.has(item.href)) continue;
    novel.chapters.push({ title, content });
  }
  return [novel];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function jsonChapters(value: unknown): ParsedChapter[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: unknown) => {
      const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      return {
        no:
          typeof record['chapter_no'] === 'number' ? record['chapter_no'] : Number.MAX_SAFE_INTEGER,
        title: readString(record['title']) ?? '',
        content: normalizeContent(typeof record['content'] === 'string' ? record['content'] : ''),
      };
    })
    .sort((a, b) => a.no - b.no)
    .map(({ title, content }) => ({ title, content }));
}

function jsonNovel(value: unknown, fallbackTitle: string): ParsedNovel {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const meta =
    record['novel'] && typeof record['novel'] === 'object'
      ? (record['novel'] as Record<string, unknown>)
      : record;
  return {
    title: readString(meta['title']) ?? fallbackTitle,
    author: readString(meta['author']),
    description: readString(meta['description']),
    language: readString(meta['language']),
    tags: Array.isArray(meta['tags'])
      ? meta['tags'].filter((tag): tag is string => typeof tag === 'string').slice(0, 50)
      : [],
    cover: null,
    chapters: jsonChapters(record['chapters']),
  };
}

function parseJson(data: Buffer, options: ParseOptions): ParsedNovel[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeText(data));
  } catch {
    throw new AppError('IMPORT_PARSE_FAILED', 'File is not valid JSON', 400);
  }
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (Array.isArray(record['novels'])) {
    return record['novels'].map((entry: unknown) => jsonNovel(entry, options.fallbackTitle));
  }
  return [jsonNovel(value, options.fallbackTitle)];
}

// The system's own export format: one directory (or the root) per novel holding novel.json, a
// chapters/ folder and an optional cover.*. A ZIP of bare .txt/.md files is also accepted: one
// chapter per file, ordered by file name.
async function parseZip(data: Buffer, options: ParseOptions): Promise<ParsedNovel[]> {
  const zip = await JSZip.loadAsync(data);
  const manifests = Object.keys(zip.files).filter((path) => /(^|\/)novel\.json$/u.test(path));
  if (manifests.length > 0) {
    const novels: ParsedNovel[] = [];
    for (const path of manifests.sort()) {
      const dir = path.slice(0, path.length - 'novel.json'.length);
      const manifestFile = zip.file(path);
      if (!manifestFile) continue;
      const manifest = JSON.parse(decodeText(await manifestFile.async('nodebuffer'))) as Record<
        string,
        unknown
      >;
      const novel = jsonNovel(manifest, options.fallbackTitle);
      const entries = Array.isArray(manifest['chapters'])
        ? (manifest['chapters'] as unknown[])
        : [];
      const chapters: ParsedChapter[] = [];
      for (const entry of entries) {
        const record = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        const file = readString(record['file']);
        const inline = typeof record['content'] === 'string' ? record['content'] : null;
        const body = file ? await zip.file(`${dir}${file}`)?.async('nodebuffer') : undefined;
        chapters.push({
          title: readString(record['title']) ?? '',
          content: normalizeContent(body ? decodeText(body) : (inline ?? '')),
        });
      }
      novel.chapters = chapters;
      const coverPath = Object.keys(zip.files).find(
        (candidate) =>
          candidate.startsWith(`${dir}cover.`) && !candidate.slice(dir.length).includes('/'),
      );
      if (coverPath) {
        const coverData = await zip.file(coverPath)?.async('nodebuffer');
        const type = coverData ? detectImageType(coverData) : null;
        if (coverData && type) novel.cover = { data: coverData, ...type };
      }
      novels.push(novel);
    }
    return novels;
  }

  const textFiles = Object.values(zip.files)
    .filter(
      (file) => !file.dir && /\.(txt|md)$/iu.test(file.name) && !file.name.startsWith('__MACOSX/'),
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (textFiles.length === 0) {
    throw new AppError(
      'IMPORT_PARSE_FAILED',
      'ZIP contains neither novel.json nor .txt/.md chapters',
      400,
    );
  }
  const novel = emptyNovel(options.fallbackTitle);
  for (const file of textFiles) {
    const text = decodeText(await file.async('nodebuffer'));
    const [firstLine = '', ...rest] = text.replace(/\r\n?/gu, '\n').split('\n');
    const name =
      file.name
        .split('/')
        .pop()
        ?.replace(/\.(txt|md)$/iu, '') ?? '';
    const titleFromLine = firstLine.replace(/^#+\s*/u, '').trim();
    novel.chapters.push(
      titleFromLine !== '' && titleFromLine.length <= MAX_HEADING_LINE_LENGTH
        ? { title: titleFromLine, content: normalizeContent(rest.join('\n')) }
        : { title: name, content: normalizeContent(text) },
    );
  }
  return [novel];
}

export async function parseImport(
  format: NovelImportFormat,
  data: Buffer,
  options: ParseOptions,
): Promise<ParsedNovel[]> {
  switch (format) {
    case 'txt':
      return parseTxt(data, options);
    case 'md':
      return parseMarkdown(data, options);
    case 'docx':
      return parseDocx(data, options);
    case 'epub':
      return parseEpub(data, options);
    case 'json':
      return parseJson(data, options);
    case 'zip':
      return parseZip(data, options);
  }
}

export function formatFromFilename(filename: string): NovelImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'epub':
    case 'txt':
    case 'md':
    case 'docx':
    case 'json':
    case 'zip':
      return ext;
    case 'markdown':
      return 'md';
    default:
      return null;
  }
}

export function chapterWarnings(
  chapter: ParsedChapter,
  previous: ParsedChapter | undefined,
): string[] {
  const warnings: string[] = [];
  const words = countWords(chapter.content);
  if (words === 0) warnings.push('empty');
  else if (words < 100) warnings.push('very_short');
  if (words > 50_000) warnings.push('very_long');
  if (chapter.title === '') warnings.push('missing_title');
  if (previous && previous.title !== '' && previous.title === chapter.title)
    warnings.push('duplicate_title');
  if (chapter.content.includes('\ufffd')) warnings.push('encoding');
  return warnings;
}
