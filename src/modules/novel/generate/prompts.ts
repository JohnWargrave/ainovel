import {
  arcFor,
  type GenInput,
  type OutlineChapter,
  type StoryArc,
  type StoryBible,
  type StoryOutline,
} from './plan.js';

// Instructions are in English (the models follow them best); every answer is written in the
// novel's language.

const LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  en: 'English',
  id: 'Indonesian',
  th: 'Thai',
  ms: 'Malay',
  tl: 'Filipino',
  es: 'Spanish',
  pt: 'Portuguese',
  zh: 'Chinese',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

const CONTENT_RULES = `Content rules (the app is rated for a general audience): no explicit sexual content, no graphic gore or torture, no hate toward real groups, no real people, brands or copyrighted characters. Romance and violence are fine when handled the way a mainstream bestseller would. All characters in romantic situations are adults.`;

export interface Prompt {
  system: string;
  user: string;
}

function requestText(input: GenInput): string {
  return [
    `Idea from the editor:\n${input.idea}`,
    input.title ? `Title (use exactly this): ${input.title}` : null,
    input.genres.length > 0 ? `Genres: ${input.genres.join(', ')}` : null,
    input.tone ? `Tone: ${input.tone}` : null,
    input.audience ? `Target readers: ${input.audience}` : null,
    `Length: ${String(input.chapter_count)} chapters of about ${String(input.words_per_chapter)} words each.`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

export function bibleText(bible: StoryBible): string {
  return [
    `Title: ${bible.title}`,
    bible.logline ? `Logline: ${bible.logline}` : null,
    bible.setting ? `Setting: ${bible.setting}` : null,
    bible.world_rules ? `World rules: ${bible.world_rules}` : null,
    bible.tone ? `Tone and style: ${bible.tone}` : null,
    bible.themes.length > 0 ? `Themes: ${bible.themes.join(', ')}` : null,
    bible.characters.length > 0
      ? `Characters:\n${bible.characters
          .map(
            (character) =>
              `- ${character.name}${character.role ? ` (${character.role})` : ''}: ${character.description}${character.goal ? ` Goal: ${character.goal}.` : ''}${character.relationships ? ` Relationships: ${character.relationships}.` : ''}`,
          )
          .join('\n')}`
      : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function arcsText(arcs: StoryArc[]): string {
  return arcs
    .map(
      (arc) =>
        `- Chapters ${String(arc.from_chapter)}–${String(arc.to_chapter)} "${arc.title}": ${arc.summary}`,
    )
    .join('\n');
}

function chapterLine(chapter: OutlineChapter, withBeats: boolean): string {
  const head = `Chapter ${String(chapter.no)}: ${chapter.title}`;
  return withBeats && chapter.beats.length > 0
    ? `${head}\n${chapter.beats.map((beat) => `  - ${beat}`).join('\n')}`
    : head;
}

// The outline so far as the model's memory of the story: recent chapters in full, older ones as
// titles only, newest kept when the budget runs out.
export function storySoFar(chapters: OutlineChapter[], detailed: number, budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    const chapter = chapters[index];
    if (!chapter) continue;
    const line = chapterLine(chapter, chapters.length - index <= detailed);
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function biblePrompt(
  input: GenInput,
  previous: StoryBible | null,
  note: string | null,
): Prompt {
  const language = languageName(input.language);
  return {
    system: `You are a bestselling web-novel author and story architect. From an editor's idea, design the story bible for a serialized novel that readers will binge chapter after chapter: a hooky premise, a protagonist with a clear want, escalating conflict, and a cast with distinct voices.

${CONTENT_RULES}

Answer with a single JSON object and nothing else. Every value is written in ${language}. Shape:
{"title": "...", "logline": "one or two sentences", "description": "the 120–250 word blurb shown to readers on the novel page; no spoilers past the first act", "setting": "time, place and atmosphere", "world_rules": "how the world works: power or magic system, social order, technology; empty string if ordinary modern life", "tone": "narrative voice and style, e.g. point of view and tense", "themes": ["..."], "tags": ["3–8 short genre or trope tags"], "characters": [{"name": "...", "role": "protagonist | love interest | rival | mentor | antagonist | ...", "description": "look, personality, background", "goal": "...", "relationships": "..."}]}
Give 4–10 characters, the protagonist first.`,
    user: [
      requestText(input),
      previous
        ? `Current bible (revise it, keep what the editor did not ask to change):\n${JSON.stringify(previous)}`
        : null,
      note ? `Editor's instructions for this version:\n${note}` : null,
      'Return the story bible as JSON.',
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  };
}

export function arcsPrompt(input: GenInput, bible: StoryBible, note: string | null): Prompt {
  const language = languageName(input.language);
  const arcCount = Math.min(12, Math.max(1, Math.round(input.chapter_count / 20)));
  return {
    system: `You are a web-novel story architect. Split a ${String(input.chapter_count)}-chapter novel into story arcs. Each arc has its own goal, escalation and climax near its last chapters, and sets up the next. The final arc resolves the main conflict.

Answer with a single JSON object and nothing else, text in ${language}. Shape:
{"arcs": [{"title": "...", "summary": "3–5 sentences: goal, main events, climax, how it ends", "from_chapter": 1, "to_chapter": 20}]}
Use about ${String(arcCount)} arcs. They cover chapters 1 to ${String(input.chapter_count)} in order with no gaps.`,
    user: [
      `Story bible:\n${bibleText(bible)}`,
      `Premise from the editor:\n${input.idea}`,
      note ? `Editor's instructions for the outline:\n${note}` : null,
      'Return the arcs as JSON.',
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  };
}

export function outlineBatchPrompt(args: {
  input: GenInput;
  bible: StoryBible;
  arcs: StoryArc[];
  previous: OutlineChapter[];
  locked: OutlineChapter[];
  from: number;
  to: number;
  note: string | null;
}): Prompt {
  const { input, from, to } = args;
  const language = languageName(input.language);
  const isEnd = to >= input.chapter_count;
  return {
    system: `You are a web-novel story architect writing a chapter-by-chapter outline. Each chapter gets a title and 3–5 beats: concrete events in order (who does what, what changes), not themes or vague summaries. Pacing rules: every chapter moves the plot or a relationship forward; no two chapters repeat the same situation; every chapter ends on a hook that makes the reader open the next one; follow the arcs' plan and build to each arc's climax.${isEnd ? ' The last chapter of the novel resolves the main conflict and gives the ending a satisfying close.' : ''}

Answer with a single JSON object and nothing else, text in ${language}. Shape:
{"chapters": [{"no": ${String(from)}, "title": "...", "beats": ["...", "..."]}]}
Return exactly chapters ${String(from)} to ${String(to)}, one entry each, in order.`,
    user: [
      `Story bible:\n${bibleText(args.bible)}`,
      `Arcs:\n${arcsText(args.arcs)}`,
      args.previous.length > 0
        ? `Outline so far:\n${storySoFar(args.previous, 8, 8000)}`
        : 'This is the start of the novel: chapter 1 opens with a hook and introduces the protagonist in action.',
      args.locked.length > 0
        ? `These chapters are fixed by the editor; return them unchanged and fit the others around them:\n${args.locked.map((chapter) => chapterLine(chapter, true)).join('\n')}`
        : null,
      args.note ? `Editor's instructions for the outline:\n${args.note}` : null,
      `Return chapters ${String(from)}–${String(to)} as JSON.`,
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  };
}

export function outlineChapterPrompt(args: {
  input: GenInput;
  bible: StoryBible;
  outline: StoryOutline;
  no: number;
  note: string | null;
}): Prompt {
  const { outline, no } = args;
  const language = languageName(args.input.language);
  const arc = arcFor(outline, no);
  const current = outline.chapters.find((chapter) => chapter.no === no);
  const before = outline.chapters.filter((chapter) => chapter.no < no);
  const after = outline.chapters.filter((chapter) => chapter.no > no).slice(0, 2);
  return {
    system: `You are a web-novel story architect. Rewrite the outline of one chapter so it fits between its neighbours: a title and 3–5 concrete beats in order, ending on a hook.

Answer with a single JSON object and nothing else, text in ${language}. Shape:
{"title": "...", "beats": ["...", "..."]}`,
    user: [
      `Story bible:\n${bibleText(args.bible)}`,
      arc ? `This chapter's arc: "${arc.title}": ${arc.summary}` : null,
      before.length > 0 ? `Outline before it:\n${storySoFar(before, 3, 5000)}` : null,
      current ? `Current version of chapter ${String(no)}:\n${chapterLine(current, true)}` : null,
      after.length > 0
        ? `Chapters after it (it must lead into these):\n${after.map((chapter) => chapterLine(chapter, true)).join('\n')}`
        : null,
      args.note ? `Editor's instructions:\n${args.note}` : null,
      `Return chapter ${String(no)} as JSON.`,
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  };
}

// The tail of the previous chapter: enough for the voice and the exact moment the story stopped.
export const PREVIOUS_TAIL_CHARS = 3000;

export function chapterPrompt(args: {
  input: GenInput;
  bible: StoryBible;
  outline: StoryOutline;
  no: number;
  previousTail: string;
}): Prompt {
  const { input, outline, no } = args;
  const language = languageName(input.language);
  const arc = arcFor(outline, no);
  const chapter = outline.chapters.find((entry) => entry.no === no);
  const before = outline.chapters.filter((entry) => entry.no < no);
  const next = outline.chapters.find((entry) => entry.no === no + 1);
  return {
    system: `You are a bestselling web-novel author writing one chapter of your serialized novel in ${language}.

Write only the chapter's prose: no chapter number, no title, no notes, no summary or commentary before or after. About ${String(input.words_per_chapter)} words. Cover this chapter's beats in order and stop there; never write events planned for later chapters. Show, don't tell: scenes, action and dialogue rather than summary. Keep names, facts and the established voice consistent with the story bible and the previous chapter. Pick up exactly where the previous chapter stopped. End on the chapter's hook. Paragraphs separated by a blank line; dialogue in the conventions of ${language} fiction.

${CONTENT_RULES}`,
    user: [
      `Story bible:\n${bibleText(args.bible)}`,
      arc ? `Current arc "${arc.title}": ${arc.summary}` : null,
      before.length > 0 ? `Story so far (outline):\n${storySoFar(before, 10, 6000)}` : null,
      args.previousTail ? `End of the previous chapter:\n…${args.previousTail}` : null,
      chapter ? `Write now — ${chapterLine(chapter, true)}` : `Write now — Chapter ${String(no)}`,
      next ? `Next chapter, for setup only (do not write it): ${chapterLine(next, true)}` : null,
    ]
      .filter((line) => line !== null)
      .join('\n\n'),
  };
}
