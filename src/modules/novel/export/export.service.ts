import JSZip from 'jszip';
import type { Selectable } from 'kysely';
import { db } from '../../../db/index.js';
import type { DB } from '../../../db/types.js';
import { AppError } from '../../../lib/errors.js';
import { getObjectStorage } from '../storage.js';
import { slugify } from '../text.js';

export type ExportFormat = 'json' | 'zip' | 'epub' | 'txt';

export interface ExportFile {
  filename: string;
  contentType: string;
  body: Buffer;
}

// Bumped only on breaking changes; the importer reads every version it knows.
const EXPORT_VERSION = 1;

type ExportChapter = Pick<
  Selectable<DB['novel_chapters']>,
  'chapter_no' | 'title' | 'content' | 'is_vip' | 'unlock_coin_price' | 'status' | 'publish_at'
>;

interface Loaded {
  novel: Selectable<DB['novels']>;
  chapters: ExportChapter[];
  categories: { slug: string; name: string }[];
}

async function loadNovel(novelId: string): Promise<Loaded> {
  const novel = await db
    .selectFrom('novels')
    .selectAll()
    .where('id', '=', novelId)
    .executeTakeFirst();
  if (!novel) throw new AppError('NOVEL_NOT_FOUND', 'Novel not found', 404);
  const [chapters, categories] = await Promise.all([
    db
      .selectFrom('novel_chapters')
      .select([
        'chapter_no',
        'title',
        'content',
        'is_vip',
        'unlock_coin_price',
        'status',
        'publish_at',
      ])
      .where('novel_id', '=', novelId)
      .orderBy('chapter_no')
      .execute(),
    db
      .selectFrom('novel_category_links')
      .innerJoin('novel_categories', 'novel_categories.id', 'novel_category_links.category_id')
      .select(['novel_categories.slug', 'novel_categories.name'])
      .where('novel_category_links.novel_id', '=', novelId)
      .execute(),
  ]);
  return { novel, chapters, categories };
}

function metadata({ novel, categories }: Loaded): Record<string, unknown> {
  return {
    title: novel.title,
    slug: novel.slug,
    alt_titles: novel.alt_titles,
    author: novel.author,
    translator: novel.translator,
    description: novel.description,
    language: novel.language,
    tags: novel.tags,
    completion_status: novel.completion_status,
    categories,
    vip_from_chapter: novel.vip_from_chapter,
    default_unlock_coin: novel.default_unlock_coin,
    allow_ad_unlock: novel.allow_ad_unlock,
    rating: novel.rating === null ? null : Number(novel.rating),
    ai_generated: novel.ai_generated,
    editor_reviewed: novel.editor_reviewed,
  };
}

function chapterMeta(chapter: ExportChapter): Record<string, unknown> {
  return {
    chapter_no: chapter.chapter_no,
    title: chapter.title,
    is_vip: chapter.is_vip,
    unlock_coin_price: chapter.unlock_coin_price,
    status: chapter.status,
    publish_at: chapter.publish_at ? new Date(chapter.publish_at).toISOString() : null,
  };
}

function buildJson(loaded: Loaded): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        format: 'ainovel-novel',
        version: EXPORT_VERSION,
        exported_at: new Date().toISOString(),
        novel: metadata(loaded),
        chapters: loaded.chapters.map((chapter) => ({
          ...chapterMeta(chapter),
          content: chapter.content,
        })),
      },
      null,
      2,
    ),
  );
}

async function coverFile(coverKey: string | null): Promise<{ name: string; data: Buffer } | null> {
  if (!coverKey) return null;
  try {
    const data = await getObjectStorage().get(coverKey);
    return { name: `cover.${coverKey.split('.').pop() ?? 'jpg'}`, data };
  } catch {
    // A missing cover must not block a content backup.
    return null;
  }
}

async function buildZip(loaded: Loaded): Promise<Buffer> {
  const zip = new JSZip();
  const pad = String(Math.max(loaded.chapters.length, 1)).length + 1;
  const entries = loaded.chapters.map((chapter) => {
    const file = `chapters/${String(chapter.chapter_no).padStart(Math.max(pad, 4), '0')}.txt`;
    zip.file(file, chapter.content);
    return { ...chapterMeta(chapter), file };
  });
  zip.file(
    'novel.json',
    JSON.stringify(
      {
        format: 'ainovel-novel',
        version: EXPORT_VERSION,
        exported_at: new Date().toISOString(),
        novel: metadata(loaded),
        chapters: entries,
      },
      null,
      2,
    ),
  );
  const cover = await coverFile(loaded.novel.cover_key);
  if (cover) zip.file(cover.name, cover.data);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function chapterHeading(chapter: { chapter_no: number; title: string }): string {
  return chapter.title === '' ? `Chương ${String(chapter.chapter_no)}` : chapter.title;
}

async function buildEpub(loaded: Loaded): Promise<Buffer> {
  const { novel, chapters } = loaded;
  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed (EPUB OCF spec).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const lang = escapeXml(novel.language);
  const files = chapters.map((chapter, index) => {
    const id = `c${String(index + 1)}`;
    const href = `${id}.xhtml`;
    const body = chapter.content
      .split('\n\n')
      .map((paragraph) => `<p>${escapeXml(paragraph).replace(/\n/gu, '<br/>')}</p>`)
      .join('\n');
    zip.file(
      `OEBPS/${href}`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>${escapeXml(chapterHeading(chapter))}</title></head><body><h2>${escapeXml(chapterHeading(chapter))}</h2>\n${body}\n</body></html>`,
    );
    return { id, href, title: chapterHeading(chapter) };
  });
  const cover = await coverFile(novel.cover_key);
  const coverType = cover?.name.endsWith('.png')
    ? 'image/png'
    : cover?.name.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';
  if (cover) zip.file(`OEBPS/${cover.name}`, cover.data);
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}"><head><title>${escapeXml(novel.title)}</title></head><body><nav epub:type="toc"><ol>${files.map((file) => `<li><a href="${file.href}">${escapeXml(file.title)}</a></li>`).join('')}</ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${novel.id}"/></head><docTitle><text>${escapeXml(novel.title)}</text></docTitle><navMap>${files.map((file, index) => `<navPoint id="n${String(index + 1)}" playOrder="${String(index + 1)}"><navLabel><text>${escapeXml(file.title)}</text></navLabel><content src="${file.href}"/></navPoint>`).join('')}</navMap></ncx>`,
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${novel.id}</dc:identifier>
<dc:title>${escapeXml(novel.title)}</dc:title>
<dc:language>${lang}</dc:language>
${novel.author ? `<dc:creator>${escapeXml(novel.author)}</dc:creator>` : ''}
${novel.description ? `<dc:description>${escapeXml(novel.description)}</dc:description>` : ''}
${novel.tags.map((tag) => `<dc:subject>${escapeXml(tag)}</dc:subject>`).join('\n')}
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')}</meta>
${cover ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
${cover ? `<item id="cover-image" href="${cover.name}" media-type="${coverType}" properties="cover-image"/>` : ''}
${files.map((file) => `<item id="${file.id}" href="${file.href}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
${files.map((file) => `<itemref idref="${file.id}"/>`).join('\n')}
</spine>
</package>`,
  );
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/epub+zip',
  });
}

function buildTxt({ novel, chapters }: Loaded): Buffer {
  const header = [
    novel.title,
    novel.author ? `Tác giả: ${novel.author}` : '',
    novel.description ?? '',
  ]
    .filter((line) => line !== '')
    .join('\n\n');
  const body = chapters
    .map((chapter) => {
      // Keep a heading the TXT importer recognises, so an exported file re-imports chapter by chapter.
      const heading = /^(chương|chapter)\s+\d+/iu.test(chapter.title)
        ? chapter.title
        : `Chương ${String(chapter.chapter_no)}${chapter.title ? `: ${chapter.title}` : ''}`;
      return `${heading}\n\n${chapter.content}`;
    })
    .join('\n\n\n');
  return Buffer.from(`${header}\n\n\n${body}\n`, 'utf8');
}

export async function exportNovel(novelId: string, format: ExportFormat): Promise<ExportFile> {
  const loaded = await loadNovel(novelId);
  const base = slugify(loaded.novel.slug || loaded.novel.title);
  switch (format) {
    case 'json':
      return { filename: `${base}.json`, contentType: 'application/json', body: buildJson(loaded) };
    case 'zip':
      return {
        filename: `${base}.zip`,
        contentType: 'application/zip',
        body: await buildZip(loaded),
      };
    case 'epub':
      return {
        filename: `${base}.epub`,
        contentType: 'application/epub+zip',
        body: await buildEpub(loaded),
      };
    case 'txt':
      return {
        filename: `${base}.txt`,
        contentType: 'text/plain; charset=utf-8',
        body: buildTxt(loaded),
      };
  }
}

function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  // Leading =,+,-,@ would be evaluated as a formula by spreadsheet apps (CSV injection).
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return /[",\n\r]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

export async function exportCatalogCsv(): Promise<ExportFile> {
  const rows = await db
    .selectFrom('novels')
    .select([
      'novels.id',
      'novels.slug',
      'novels.title',
      'novels.author',
      'novels.status',
      'novels.completion_status',
      'novels.language',
      'novels.chapter_count',
      'novels.word_count',
      'novels.is_featured',
      'novels.vip_from_chapter',
      'novels.default_unlock_coin',
      'novels.published_at',
      'novels.updated_at',
      (eb) =>
        eb
          .selectFrom('novel_library')
          .select((inner) => inner.fn.countAll<string>().as('c'))
          .whereRef('novel_library.novel_id', '=', 'novels.id')
          .where('novel_library.in_bookshelf', '=', true)
          .as('bookshelf_count'),
      (eb) =>
        eb
          .selectFrom('novel_chapter_unlocks')
          .select((inner) => inner.fn.countAll<string>().as('c'))
          .whereRef('novel_chapter_unlocks.novel_id', '=', 'novels.id')
          .as('unlock_count'),
    ])
    .orderBy('novels.title')
    .execute();
  const header = [
    'id',
    'slug',
    'title',
    'author',
    'status',
    'completion_status',
    'language',
    'chapter_count',
    'word_count',
    'is_featured',
    'vip_from_chapter',
    'default_unlock_coin',
    'published_at',
    'updated_at',
    'bookshelf_count',
    'unlock_count',
  ];
  const lines = rows.map((row) =>
    [
      row.id,
      row.slug,
      row.title,
      row.author,
      row.status,
      row.completion_status,
      row.language,
      row.chapter_count,
      row.word_count,
      row.is_featured,
      row.vip_from_chapter,
      row.default_unlock_coin,
      row.published_at ? new Date(row.published_at).toISOString() : '',
      new Date(row.updated_at).toISOString(),
      row.bookshelf_count ?? 0,
      row.unlock_count ?? 0,
    ]
      .map(csvCell)
      .join(','),
  );
  // BOM so Excel opens UTF-8 Vietnamese titles correctly.
  return {
    filename: `novels-${new Date().toISOString().slice(0, 10)}.csv`,
    contentType: 'text/csv; charset=utf-8',
    body: Buffer.from(`\ufeff${[header.join(','), ...lines].join('\r\n')}\r\n`, 'utf8'),
  };
}
