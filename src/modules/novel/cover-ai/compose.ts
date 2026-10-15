import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';

// 2:3 portrait, the shape the app's cover slots use. FLUX.2 takes multiples of 16 up to 1920.
export const COVER_WIDTH = 832;
export const COVER_HEIGHT = 1248;

// Bundled so Vietnamese diacritics render the same everywhere: the Alpine image has no fonts, and
// a fallback font would drop or misplace the stacked marks (ế, ặ, ữ). Resolves from src/ and dist/.
const FONT_DIR = fileURLToPath(new URL('../../../../assets/fonts/', import.meta.url));
const TITLE_FONT = `${FONT_DIR}BeVietnamPro-Bold.ttf`;
const AUTHOR_FONT = `${FONT_DIR}BeVietnamPro-Medium.ttf`;

const MARGIN = 56;
const TEXT_WIDTH = COVER_WIDTH - MARGIN * 2;
const TITLE_MAX_LINES = 3;
const TITLE_SIZES = [64, 56, 48, 42, 36];

function escapeMarkup(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${String(char.charCodeAt(0))};`);
}

async function renderText(
  text: string,
  fontfile: string,
  font: string,
  color: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="${color}">${escapeMarkup(text)}</span>`,
      font,
      fontfile,
      width: TEXT_WIDTH,
      align: 'centre',
      wrap: 'word',
      rgba: true,
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Largest size at which the title fits in three lines; long web-novel titles step down.
async function renderTitle(
  title: string,
): Promise<{ data: Buffer; width: number; height: number }> {
  for (const size of TITLE_SIZES) {
    const rendered = await renderText(
      title,
      TITLE_FONT,
      `Be Vietnam Pro Bold ${String(size)}`,
      '#ffffff',
    );
    if (rendered.height <= size * 1.4 * TITLE_MAX_LINES || size === TITLE_SIZES.at(-1)) {
      return rendered;
    }
  }
  throw new Error('unreachable');
}

const SHADE = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${String(COVER_WIDTH)}" height="${String(COVER_HEIGHT)}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.55" stop-color="#000" stop-opacity="0"/>
      <stop offset="0.8" stop-color="#000" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.85"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`,
);

export interface ComposedCover {
  withText: Buffer;
  clean: Buffer;
}

// The model's art, normalized to the cover size, with and without the title/author block at the
// bottom. Both are kept: the clean one lets a later redesign re-letter without re-rendering.
export async function composeCover(
  raw: Buffer,
  text: { title: string; author: string | null },
): Promise<ComposedCover> {
  const base = await sharp(raw)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover', position: 'attention' })
    .removeAlpha()
    .png()
    .toBuffer();

  const title = await renderTitle(text.title);
  const author = text.author?.trim()
    ? await renderText(text.author.trim(), AUTHOR_FONT, 'Be Vietnam Pro Medium 28', '#e8e8e8')
    : null;

  const bottom = COVER_HEIGHT - MARGIN;
  const authorTop = author ? bottom - author.height : bottom;
  const titleTop = authorTop - (author ? 20 : 0) - title.height;
  const layers: OverlayOptions[] = [
    { input: SHADE, top: 0, left: 0 },
    { input: title.data, top: titleTop, left: Math.round((COVER_WIDTH - title.width) / 2) },
  ];
  if (author) {
    layers.push({
      input: author.data,
      top: authorTop,
      left: Math.round((COVER_WIDTH - author.width) / 2),
    });
  }

  const [withText, clean] = await Promise.all([
    sharp(base).composite(layers).webp({ quality: 86 }).toBuffer(),
    sharp(base).webp({ quality: 86 }).toBuffer(),
  ]);
  return { withText, clean };
}
