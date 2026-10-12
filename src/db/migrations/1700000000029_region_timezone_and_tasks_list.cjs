// Three region_config corrections, all data-only:
//
// 1. `features.timezone` at region level. Check-in and daily tasks reset on a region-local calendar
//    day, same as spin, but they must not read `features.spin.timezone` — a module's config is not
//    a place for another module's dependency. Seeded to match the existing spin timezones.
//
// 2. `features.tasks.list`. Migration 28 enabled the tasks module without a list, so the service
//    fell back to a reward table hardcoded in TypeScript. Reward amounts are money and belong in
//    config where an admin can change them. `watch_ad` is deliberately absent: ad rewards are
//    credited by the AdMob SSV callback, and a self-asserted claim for the same view would pay
//    twice.
//
// 3. `features.offerwall.networks`. Seeded as ['tapjoy', 'adgate'] before either integration
//    existed. AdGate has no credentials and no network_config row, so the app renders a dead tile;
//    PubScale is the network we actually have keys for and was missing entirely.

exports.shorthands = undefined;

const TASKS = [
  {
    id: 'daily_login',
    title: 'Daily Login',
    description: 'Log in to the app today',
    reward_coin: 10,
    task_type: 'daily_login',
  },
  {
    id: 'share_app',
    title: 'Share the App',
    description: 'Share AINovel with your friends',
    reward_coin: 50,
    task_type: 'share_app',
  },
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{timezone}',
      CASE region_id WHEN 'VN' THEN '"Asia/Ho_Chi_Minh"'::jsonb ELSE '"UTC"'::jsonb END,
      true
    )
    WHERE region_id IN ('VN', 'ROW');

    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{tasks,list}',
      '${JSON.stringify(TASKS)}'::jsonb,
      true
    )
    WHERE region_id IN ('VN', 'ROW');

    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{offerwall,networks}',
      '["tapjoy", "pubscale"]'::jsonb,
      true
    )
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = (features - 'timezone') #- '{tasks,list}'
    WHERE region_id IN ('VN', 'ROW');

    UPDATE region_config
    SET features = jsonb_set(features, '{offerwall,networks}', '["tapjoy", "adgate"]'::jsonb, true)
    WHERE region_id IN ('VN', 'ROW');
  `);
};
