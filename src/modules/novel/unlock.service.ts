import { uuidv7 } from 'uuidv7';
import type { Transaction } from 'kysely';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { AppError } from '../../lib/errors.js';
import { debitInTransaction } from '../wallet-ledger/ledger.service.js';
import {
  chapterUnlockPrice,
  findReadableChapter,
  isChapterVip,
  loadReader,
  type ReadableChapter,
} from './access.js';
import type { UnlockBody, UnlockResponse } from './schemas.js';

async function balance(trx: Transaction<DB>, userId: string): Promise<string> {
  const wallet = await trx
    .selectFrom('wallets')
    .select('available_coin')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (wallet?.available_coin ?? 0).toString();
}

function adNotVerified(): AppError {
  // One code for every rejection: telling a caller which check failed would let them probe other
  // users' intent ids. `pending` is the case worth retrying — AdMob's SSV callback can land after
  // the app's own unlock request.
  return new AppError(
    'AD_NOT_VERIFIED',
    'No verified rewarded ad for this unlock — retry shortly if the ad just finished',
    403,
  );
}

async function claimAdIntent(
  trx: Transaction<DB>,
  userId: string,
  intentId: string,
  unlockId: string,
): Promise<void> {
  const intent = await trx
    .selectFrom('rewarded_ad_intents')
    .select(['user_id', 'status', 'placement', 'spin_history_id', 'chapter_unlock_id'])
    .where('id', '=', intentId)
    .forUpdate()
    .executeTakeFirst();
  // Strictly chapter_unlock: any other placement (or a legacy NULL one) is paid in coin or spent on
  // a spin by its own flow, so accepting it here would reward one ad twice.
  if (
    intent?.user_id !== userId ||
    intent.status !== 'consumed' ||
    intent.placement !== 'chapter_unlock' ||
    intent.spin_history_id !== null ||
    intent.chapter_unlock_id !== null
  ) {
    throw adNotVerified();
  }
  // The partial unique index on chapter_unlock_id is what makes an intent single-use under
  // concurrency; the check above only gives the common case a clean error.
  await trx
    .updateTable('rewarded_ad_intents')
    .set({ chapter_unlock_id: unlockId })
    .where('id', '=', intentId)
    .execute();
}

export async function unlockChapter(
  userId: string,
  chapterId: string,
  body: UnlockBody,
): Promise<UnlockResponse> {
  const reader = await loadReader(userId);
  const chapter: ReadableChapter = await findReadableChapter(reader, { chapterId });

  return db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('status')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (user.status !== 'active') {
      throw new AppError('UNLOCK_BLOCKED', 'Unlocking is unavailable for this account', 403);
    }

    if (!isChapterVip(chapter, chapter)) {
      return {
        chapter_id: chapter.id,
        unlocked: true,
        method: 'free' as const,
        coin_spent: 0,
        new_balance: await balance(trx, userId),
      };
    }

    // Idempotent: a retried request after a successful unlock reports the original outcome.
    const existing = await trx
      .selectFrom('novel_chapter_unlocks')
      .select(['method', 'coin_spent'])
      .where('user_id', '=', userId)
      .where('chapter_id', '=', chapter.id)
      .executeTakeFirst();
    if (existing) {
      return {
        chapter_id: chapter.id,
        unlocked: true,
        method: existing.method,
        coin_spent: existing.coin_spent,
        new_balance: await balance(trx, userId),
      };
    }

    const unlockId = uuidv7();
    if (body.method === 'ad') {
      if (!chapter.allow_ad_unlock) {
        throw new AppError('AD_UNLOCK_DISABLED', 'This chapter cannot be unlocked with an ad', 400);
      }
      await trx
        .insertInto('novel_chapter_unlocks')
        .values({
          id: unlockId,
          user_id: userId,
          chapter_id: chapter.id,
          novel_id: chapter.novel_id,
          method: 'ad',
          coin_spent: 0,
          ad_intent_id: body.intent_id,
        })
        .execute();
      await claimAdIntent(trx, userId, body.intent_id, unlockId);
      return {
        chapter_id: chapter.id,
        unlocked: true,
        method: 'ad' as const,
        coin_spent: 0,
        new_balance: await balance(trx, userId),
      };
    }

    const price = chapterUnlockPrice(chapter, chapter);
    await trx
      .insertInto('novel_chapter_unlocks')
      .values({
        id: unlockId,
        user_id: userId,
        chapter_id: chapter.id,
        novel_id: chapter.novel_id,
        method: 'coin',
        coin_spent: price,
      })
      .execute();
    if (price === 0) {
      return {
        chapter_id: chapter.id,
        unlocked: true,
        method: 'coin' as const,
        coin_spent: 0,
        new_balance: await balance(trx, userId),
      };
    }
    const ledger = await debitInTransaction(trx, {
      userId,
      entryType: 'CHAPTER_UNLOCK_DEBIT',
      amount: price,
      bucket: 'available',
      refType: 'novel_chapter_unlock',
      refId: unlockId,
      idempotencyKey: `chapter-unlock:${userId}:${chapter.id}`,
      note: 'Chapter unlock',
    });
    return {
      chapter_id: chapter.id,
      unlocked: true,
      method: 'coin' as const,
      coin_spent: price,
      new_balance: ledger.balanceAfter,
    };
  });
}
