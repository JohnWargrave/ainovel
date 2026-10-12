// Adds `icon_url` and `action` to each entry of region_config.features.tasks.list.
//
// The Home screen needs an icon and a destination per task to render a tappable row; without them the
// app has a title and a coin amount and nowhere to send the user. Both go in config rather than
// TypeScript for the same reason migration 29 moved the reward amounts there: they are content, and
// an admin should be able to change an icon or repoint a CTA without a release.
//
// `action` is an in-app deeplink, never an HTTP URL — the backend does not send a user out of the app
// to complete a task. `share_app` has no destination (the app opens the OS share sheet itself), so it
// is null rather than pointing somewhere arbitrary.
//
// icon_url is null for now: there is no asset host for these yet (the app ships its own fallback
// icons). The field exists so filling it in later is an UPDATE, not another migration + release.

exports.shorthands = undefined;

const TASKS = [
  {
    id: 'daily_login',
    title: 'Daily Login',
    description: 'Log in to the app today',
    reward_coin: 10,
    task_type: 'daily_login',
    icon_url: null,
    action: null,
  },
  {
    id: 'share_app',
    title: 'Share the App',
    description: 'Share AINovel with your friends',
    reward_coin: 50,
    task_type: 'share_app',
    icon_url: null,
    action: null,
  },
];

// Pre-migration-38 shape, for down().
const TASKS_WITHOUT_DISPLAY = TASKS.map((task) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  reward_coin: task.reward_coin,
  task_type: task.task_type,
}));

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(features, '{tasks,list}', '${JSON.stringify(TASKS)}'::jsonb, true)
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{tasks,list}',
      '${JSON.stringify(TASKS_WITHOUT_DISPLAY)}'::jsonb,
      true
    )
    WHERE region_id IN ('VN', 'ROW');
  `);
};
