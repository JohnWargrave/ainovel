import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import { normalizeContent } from '../text.js';

// Crawls a novel the operator holds the rights to from a site laid out as a table-of-contents page
// linking to one page per chapter, and produces the JSON shape the novel importer accepts.
// It honours robots.txt, keeps a fixed delay between requests, stays on the start URL's host and
// stops (rather than retrying around it) when the site refuses access.

export interface CrawlSelectors {
  title: string;
  author?: string;
  description?: string;
  // Anchors on the table-of-contents page, in reading order.
  chapter_links: string;
  // Link to the next table-of-contents page, for sites that paginate the chapter list.
  toc_next?: string;
  chapter_title?: string;
  chapter_content: string;
  // Elements inside the chapter content to drop (ads, nav buttons, share widgets).
  remove?: string[];
}

export interface CrawlConfig {
  start_url: string;
  selectors: CrawlSelectors;
  language?: string;
  tags?: string[];
  delay_ms?: number;
  user_agent?: string;
  max_chapters?: number;
  max_toc_pages?: number;
}

export interface CrawledChapter {
  chapter_no: number;
  title: string;
  content: string;
  source_url: string;
}

export interface CrawledNovel {
  title: string;
  author: string | null;
  description: string | null;
  language: string | null;
  tags: string[];
  source_url: string;
  chapters: CrawledChapter[];
}

export class CrawlBlockedError extends Error {}

const DEFAULT_USER_AGENT = 'AINovelImporter/0.1 (+rights-holder content import)';
const DEFAULT_DELAY_MS = 1500;
const MIN_DELAY_MS = 500;

// --- robots.txt -----------------------------------------------------------------------------

interface RobotsRule {
  allow: boolean;
  path: string;
}

// Groups for the given agent token (matched case-insensitively as a substring, per the RFC 9309
// convention) win over the "*" group. Rules are path prefixes; "*" and a trailing "$" are honoured.
export function parseRobots(text: string, userAgent: string): RobotsRule[] {
  const agent = userAgent.split('/')[0]?.toLowerCase() ?? '';
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/iu.exec(line);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim() ?? '';
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      if (value !== '') current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const specific = groups.filter((group) =>
    group.agents.some((name) => name !== '*' && agent !== '' && agent.includes(name)),
  );
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith('$');
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  // Built from escaped robots.txt text, not user input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`, 'u').test(path);
}

// Longest matching rule wins; on a tie, allow wins.
export function isAllowed(rules: RobotsRule[], url: URL): boolean {
  const path = url.pathname + url.search;
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

// --- page extraction ------------------------------------------------------------------------

function textOf(root: HTMLElement, selector: string | undefined): string | null {
  if (!selector) return null;
  const text = root.querySelector(selector)?.text.replace(/\s+/gu, ' ').trim();
  return text ? text : null;
}

export function extractToc(
  html: string,
  pageUrl: URL,
  selectors: CrawlSelectors,
): { title: string | null; author: string | null; description: string | null; links: URL[]; next: URL | null } {
  const root = parseHtml(html);
  const links: URL[] = [];
  for (const anchor of root.querySelectorAll(selectors.chapter_links)) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      const url = new URL(href, pageUrl);
      url.hash = '';
      links.push(url);
    } catch {
      // Malformed href; skip it.
    }
  }
  const nextHref = selectors.toc_next
    ? root.querySelector(selectors.toc_next)?.getAttribute('href')
    : undefined;
  const description = selectors.description
    ? root.querySelector(selectors.description)?.structuredText
    : undefined;
  return {
    title: textOf(root, selectors.title),
    author: textOf(root, selectors.author),
    description: description ? normalizeContent(description) || null : null,
    links,
    next: nextHref ? new URL(nextHref, pageUrl) : null,
  };
}

export function extractChapter(
  html: string,
  selectors: CrawlSelectors,
): { title: string | null; content: string } {
  const root = parseHtml(html);
  const body = root.querySelector(selectors.chapter_content);
  if (!body) return { title: textOf(root, selectors.chapter_title), content: '' };
  for (const node of body.querySelectorAll(['script', 'style', ...(selectors.remove ?? [])].join(', '))) {
    node.remove();
  }
  // <br> separated text renders as single newlines; keep them as paragraph breaks.
  for (const br of body.querySelectorAll('br')) br.replaceWith('\n');
  const paragraphs = body.structuredText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return {
    title: textOf(root, selectors.chapter_title),
    content: normalizeContent(paragraphs.join('\n\n')),
  };
}

// --- crawl loop -----------------------------------------------------------------------------

export interface CrawlDeps {
  fetchText: (url: URL, userAgent: string) => Promise<{ status: number; body: string }>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  // Called after every chapter so the CLI can persist progress for resuming.
  onProgress?: (novel: CrawledNovel) => Promise<void>;
}

export async function crawlNovel(
  config: CrawlConfig,
  deps: CrawlDeps,
  resume?: CrawledNovel,
): Promise<CrawledNovel> {
  const start = new URL(config.start_url);
  const userAgent = config.user_agent ?? DEFAULT_USER_AGENT;
  const delay = Math.max(config.delay_ms ?? DEFAULT_DELAY_MS, MIN_DELAY_MS);
  let lastRequest = 0;

  const get = async (url: URL): Promise<string> => {
    const wait = lastRequest + delay - Date.now();
    if (wait > 0) await deps.sleep(wait);
    lastRequest = Date.now();
    const { status, body } = await deps.fetchText(url, userAgent);
    if (status === 401 || status === 403 || status === 429) {
      throw new CrawlBlockedError(
        `${url.href} answered HTTP ${status}; the site is refusing automated access. ` +
          'Ask the site owner for an export or an allow-listed crawler instead.',
      );
    }
    if (status < 200 || status >= 300) throw new Error(`${url.href} answered HTTP ${status}`);
    return body;
  };

  const robotsUrl = new URL('/robots.txt', start);
  const robots = await deps.fetchText(robotsUrl, userAgent).catch(() => ({ status: 0, body: '' }));
  lastRequest = Date.now();
  const rules = robots.status >= 200 && robots.status < 300 ? parseRobots(robots.body, userAgent) : [];
  const checkAllowed = (url: URL): void => {
    if (url.host !== start.host) throw new Error(`${url.href} is outside ${start.host}`);
    if (!isAllowed(rules, url)) {
      throw new CrawlBlockedError(`robots.txt disallows ${url.pathname}; not crawling it.`);
    }
  };

  // Table of contents, following pagination.
  const links: URL[] = [];
  const seen = new Set<string>();
  let meta: Pick<CrawledNovel, 'title' | 'author' | 'description'> = {
    title: '',
    author: null,
    description: null,
  };
  let tocUrl: URL | null = start;
  const visitedToc = new Set<string>();
  for (let page = 0; tocUrl && page < (config.max_toc_pages ?? 200); page += 1) {
    if (visitedToc.has(tocUrl.href)) break;
    visitedToc.add(tocUrl.href);
    checkAllowed(tocUrl);
    deps.log(`toc ${tocUrl.href}`);
    const toc = extractToc(await get(tocUrl), tocUrl, config.selectors);
    if (page === 0) {
      meta = { title: toc.title ?? '', author: toc.author, description: toc.description };
    }
    for (const link of toc.links) {
      if (link.host !== start.host || seen.has(link.href)) continue;
      seen.add(link.href);
      links.push(link);
    }
    tocUrl = toc.next;
  }
  if (links.length === 0) {
    throw new Error(`No chapter links matched "${config.selectors.chapter_links}" on ${start.href}`);
  }

  const novel: CrawledNovel = {
    ...meta,
    title: meta.title || resume?.title || start.pathname,
    language: config.language ?? null,
    tags: config.tags ?? [],
    source_url: start.href,
    chapters: [],
  };
  const done = new Map((resume?.chapters ?? []).map((chapter) => [chapter.source_url, chapter]));
  const limit = Math.min(links.length, config.max_chapters ?? links.length);

  for (let index = 0; index < limit; index += 1) {
    const url = links[index];
    if (!url) continue;
    const cached = done.get(url.href);
    if (cached && cached.content !== '') {
      novel.chapters.push({ ...cached, chapter_no: index + 1 });
      continue;
    }
    checkAllowed(url);
    deps.log(`chapter ${index + 1}/${limit} ${url.href}`);
    const chapter = extractChapter(await get(url), config.selectors);
    if (chapter.content === '') {
      deps.log(`  warning: "${config.selectors.chapter_content}" matched nothing on ${url.href}`);
    }
    novel.chapters.push({
      chapter_no: index + 1,
      title: chapter.title ?? `Chương ${index + 1}`,
      content: chapter.content,
      source_url: url.href,
    });
    await deps.onProgress?.(novel);
  }
  return novel;
}
