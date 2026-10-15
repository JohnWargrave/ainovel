import { readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CrawlBlockedError,
  crawlNovel,
  type CrawlConfig,
  type CrawledNovel,
} from '../modules/novel/import/crawler.js';

// Usage: pnpm crawl:novel -- <config.json> <output.json>
// Only for content you hold the rights to. The output is the importer's JSON format: upload it in
// the CMS (Import → JSON). Re-running with the same output file resumes and skips fetched chapters.

const [configPath, outputPath] = process.argv.slice(2).filter((arg) => arg !== '--');

async function readResume(path: string): Promise<CrawledNovel | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CrawledNovel;
  } catch {
    return undefined;
  }
}

async function save(path: string, novel: CrawledNovel): Promise<void> {
  await writeFile(`${path}.tmp`, `${JSON.stringify(novel, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

if (!configPath || !outputPath) {
  process.stderr.write('Usage: pnpm crawl:novel -- <config.json> <output.json>\n');
  process.exitCode = 1;
} else {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as CrawlConfig;
  try {
    const novel = await crawlNovel(
      config,
      {
        fetchText: async (url, userAgent) => {
          const response = await fetch(url, {
            headers: { 'user-agent': userAgent, accept: 'text/html,*/*;q=0.8' },
            signal: AbortSignal.timeout(30_000),
          });
          return { status: response.status, body: await response.text() };
        },
        sleep: (ms) => sleep(ms),
        log: (message) => process.stderr.write(`${message}\n`),
        onProgress: (partial) => save(outputPath, partial),
      },
      await readResume(outputPath),
    );
    await save(outputPath, novel);
    const empty = novel.chapters.filter((chapter) => chapter.content === '').length;
    process.stderr.write(
      `Saved "${novel.title}" with ${novel.chapters.length} chapters to ${outputPath}` +
        (empty > 0 ? ` (${empty} empty, check chapter_content selector)` : '') +
        '\n',
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof CrawlBlockedError ? 'Stopped: ' : 'Failed: '}${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  }
}
