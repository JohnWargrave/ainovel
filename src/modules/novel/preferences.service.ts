import { db } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import type { PreferencesResponse } from './schemas.js';

// The reader's chosen genres, minus any an editor has since deactivated.
export async function preferredCategoryIds(userId: string): Promise<string[]> {
  const row = await db
    .selectFrom('user_preferences')
    .select('category_ids')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row || row.category_ids.length === 0) return [];
  const active = await db
    .selectFrom('novel_categories')
    .select('id')
    .where('id', 'in', row.category_ids)
    .where('is_active', '=', true)
    .execute();
  const activeIds = new Set(active.map((category) => category.id));
  return row.category_ids.filter((id) => activeIds.has(id));
}

export async function getPreferences(userId: string): Promise<PreferencesResponse> {
  return { category_ids: await preferredCategoryIds(userId) };
}

export async function setPreferences(
  userId: string,
  categoryIds: string[],
): Promise<PreferencesResponse> {
  const unique = [...new Set(categoryIds)];
  if (unique.length > 0) {
    const found = await db
      .selectFrom('novel_categories')
      .select('id')
      .where('id', 'in', unique)
      .where('is_active', '=', true)
      .execute();
    if (found.length !== unique.length) {
      throw new AppError('CATEGORY_NOT_FOUND', 'One or more categories do not exist', 400);
    }
  }
  await db
    .insertInto('user_preferences')
    .values({ user_id: userId, category_ids: unique })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ category_ids: unique, updated_at: new Date() }),
    )
    .execute();
  return { category_ids: unique };
}
