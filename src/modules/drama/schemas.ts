import { Type, type Static } from '@sinclair/typebox';

export const SeriesParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const EpisodeParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export type SeriesParams = Static<typeof SeriesParamsSchema>;
export type EpisodeParams = Static<typeof EpisodeParamsSchema>;

// drama_id is the app's own catalog id — the backend stores it opaquely and never resolves it.
export const WatchHeartbeatBodySchema = Type.Object({
  drama_id: Type.String({ minLength: 1, maxLength: 128 }),
  episode_index: Type.Integer({ minimum: 0, maximum: 10_000 }),
  // Playback position, not watch time. The server derives verified watch time from the change in
  // this between beats, bounded by its own clock.
  elapsed_seconds: Type.Integer({ minimum: 0, maximum: 86_400 }),
  duration_seconds: Type.Integer({ minimum: 10, maximum: 7200 }),
});
export type WatchHeartbeatBody = Static<typeof WatchHeartbeatBodySchema>;

export const SeriesResponseSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  cover_url: Type.Union([Type.String(), Type.Null()]),
  total_episodes: Type.Number(),
});
export const SeriesListResponseSchema = Type.Object({ items: Type.Array(SeriesResponseSchema) });
export const EpisodeResponseSchema = Type.Object({
  id: Type.String(),
  episode_no: Type.Number(),
  duration_s: Type.Number(),
});
export const PlaybackResponseSchema = Type.Object({
  episode_id: Type.String(),
  playback_url: Type.String(),
  expires_at: Type.String(),
});
export const WatchHeartbeatResponseSchema = Type.Object({
  // Server-verified watch time, which is what the reward is decided on — not the client's position.
  watched_seconds: Type.Integer(),
  required_seconds: Type.Integer(),
  duration_seconds: Type.Integer(),
  // True on exactly one beat: the one that credited. The app fires its reward animation off this.
  rewarded: Type.Boolean(),
  credited_coin: Type.Integer(),
  // The wallet's available balance as of this beat, on every beat — not only the one that credited.
  // Sent unconditionally so the player HUD can track the balance without a second round trip, and
  // so "no reward" and "reward is switched off" stop looking identical to the client.
  new_balance: Type.String(),
  daily_remaining: Type.Integer(),
});
export type WatchHeartbeatResponse = Static<typeof WatchHeartbeatResponseSchema>;
