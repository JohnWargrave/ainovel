// The editable plan of a generated novel: what the admin asked for, the story bible and the
// outline. LLM output and admin edits both pass through the sanitizers here, so the rest of the
// module can trust the shapes (and the size limits) without re-checking.

export interface GenInput {
  idea: string;
  // Forced title; empty lets the bible step choose one.
  title: string;
  category_ids: string[];
  // Category names, resolved when the project is created, for the prompts.
  genres: string[];
  language: string;
  tone: string;
  audience: string;
  chapter_count: number;
  words_per_chapter: number;
  auto_cover: boolean;
}

export interface StoryCharacter {
  name: string;
  role: string;
  description: string;
  goal: string;
  relationships: string;
}

export interface StoryBible {
  title: string;
  logline: string;
  // The reader-facing blurb; becomes the novel's description.
  description: string;
  setting: string;
  world_rules: string;
  tone: string;
  themes: string[];
  tags: string[];
  characters: StoryCharacter[];
}

export interface StoryArc {
  title: string;
  summary: string;
  from_chapter: number;
  to_chapter: number;
}

export interface OutlineChapter {
  no: number;
  title: string;
  beats: string[];
  // Kept as is when the whole outline is regenerated.
  locked: boolean;
}

export interface StoryOutline {
  arcs: StoryArc[];
  chapters: OutlineChapter[];
}

export const LIMITS = {
  idea: 4000,
  title: 300,
  short: 500,
  text: 4000,
  listItem: 80,
  listItems: 20,
  characters: 30,
  arcs: 50,
  chapters: 1000,
  beat: 600,
  beats: 12,
} as const;

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function strList(value: unknown, maxItems: number, maxLength: number): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n]/u)
      : [];
  return items
    .map((item) => str(item, maxLength))
    .filter((item) => item !== '')
    .slice(0, maxItems);
}

function int(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function sanitizeBible(value: unknown): StoryBible | null {
  const raw = record(value);
  if (!raw) return null;
  const title = str(raw['title'], LIMITS.title);
  if (title === '') return null;
  const characters = (Array.isArray(raw['characters']) ? raw['characters'] : [])
    .map((entry): StoryCharacter | null => {
      const character = record(entry);
      if (!character) return null;
      const name = str(character['name'], LIMITS.listItem);
      if (name === '') return null;
      return {
        name,
        role: str(character['role'], LIMITS.listItem),
        description: str(character['description'], LIMITS.text),
        goal: str(character['goal'], LIMITS.short),
        relationships: str(character['relationships'], LIMITS.short),
      };
    })
    .filter((character) => character !== null)
    .slice(0, LIMITS.characters);
  return {
    title,
    logline: str(raw['logline'], LIMITS.short),
    description: str(raw['description'], LIMITS.text),
    setting: str(raw['setting'], LIMITS.text),
    world_rules: str(raw['world_rules'], LIMITS.text),
    tone: str(raw['tone'], LIMITS.short),
    themes: strList(raw['themes'], LIMITS.listItems, LIMITS.listItem),
    tags: strList(raw['tags'], LIMITS.listItems, LIMITS.listItem),
    characters,
  };
}

export function sanitizeOutlineChapter(value: unknown, no: number): OutlineChapter | null {
  const raw = record(value);
  if (!raw) return null;
  const title = str(raw['title'], LIMITS.title);
  const beats = strList(raw['beats'], LIMITS.beats, LIMITS.beat);
  if (title === '' && beats.length === 0) return null;
  return { no, title, beats, locked: raw['locked'] === true };
}

export function sanitizeArcs(value: unknown, chapterCount: number): StoryArc[] {
  const arcs = (Array.isArray(value) ? value : [])
    .map((entry): StoryArc | null => {
      const arc = record(entry);
      if (!arc) return null;
      const title = str(arc['title'], LIMITS.title);
      const from = int(arc['from_chapter']);
      const to = int(arc['to_chapter']);
      if (title === '' || from === null || to === null) return null;
      return {
        title,
        summary: str(arc['summary'], LIMITS.text),
        from_chapter: from,
        to_chapter: to,
      };
    })
    .filter((arc) => arc !== null)
    .sort((a, b) => a.from_chapter - b.from_chapter)
    .slice(0, LIMITS.arcs);
  if (chapterCount < 1) return arcs;
  // Make the arcs tile 1..chapterCount with no gaps or overlaps, whatever the model counted.
  const tiled: StoryArc[] = [];
  let next = 1;
  for (const arc of arcs) {
    if (next > chapterCount) break;
    const to = Math.min(Math.max(arc.to_chapter, next), chapterCount);
    tiled.push({ ...arc, from_chapter: next, to_chapter: to });
    next = to + 1;
  }
  if (tiled.length === 0) return [];
  const last = tiled.at(-1);
  if (last) last.to_chapter = chapterCount;
  return tiled;
}

// Admin edits: the array order is the reading order, so chapters are renumbered 1..n.
export function sanitizeOutline(value: unknown): StoryOutline | null {
  const raw = record(value);
  if (!raw) return null;
  const chapters = (Array.isArray(raw['chapters']) ? raw['chapters'] : [])
    .slice(0, LIMITS.chapters)
    .map((entry, index) => sanitizeOutlineChapter(entry, index + 1))
    .filter((chapter) => chapter !== null)
    .map((chapter, index) => ({ ...chapter, no: index + 1 }));
  if (chapters.length === 0) return null;
  return { arcs: sanitizeArcs(raw['arcs'], chapters.length), chapters };
}

export function arcFor(outline: StoryOutline, no: number): StoryArc | null {
  return outline.arcs.find((arc) => arc.from_chapter <= no && no <= arc.to_chapter) ?? null;
}

export function parseJsonObject(content: string): Record<string, unknown> | null {
  let text = content.trim();
  // JSON mode should never fence its answer, but a model that ignores it costs a retry otherwise.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  if (fenced?.[1]) text = fenced[1];
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

// What a chapter call returns is prose, but models like to add a heading or a sign-off anyway.
export function cleanChapterText(text: string, title: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').trim().split('\n');
  const heading = /^(?:chương|chapter|第)\s?[\d一二三四五六七八九十百千]/iu;
  while (lines.length > 0) {
    const first = (lines[0] ?? '').trim();
    const isTitle =
      first !== '' &&
      title !== '' &&
      first.replace(/[#*_\s]/gu, '').toLowerCase() === title.replace(/\s/gu, '').toLowerCase();
    if (first === '' || heading.test(first.replace(/^[#*\s]+/u, '')) || isTitle) lines.shift();
    else break;
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
