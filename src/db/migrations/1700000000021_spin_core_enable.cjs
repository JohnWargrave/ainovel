exports.shorthands = undefined;

const PAID_CONFIG_ID = '00000000-0000-7000-8000-000000000021';
const FREE_CONFIG_ID = '00000000-0000-7000-8000-000000000022';

const paidPrizes = [
  { slot: 1, type: 'coin', value: 10, weight: 300, tier: 'low', label: '10 coin' },
  { slot: 2, type: 'coin', value: 20, weight: 260, tier: 'low', label: '20 coin' },
  { slot: 3, type: 'coin', value: 50, weight: 180, tier: 'mid', label: '50 coin' },
  { slot: 4, type: 'coin', value: 100, weight: 120, tier: 'mid', label: '100 coin' },
  { slot: 5, type: 'coin', value: 200, weight: 80, tier: 'mid', label: '200 coin' },
  { slot: 6, type: 'coin', value: 500, weight: 45, tier: 'high', label: '500 coin' },
  { slot: 7, type: 'voucher', value: 'discount_10pct', weight: 14, tier: 'mid', label: '10% voucher' },
  { slot: 8, type: 'coin', value: 5000, weight: 1, tier: 'jackpot', label: '5,000 coin' },
];

const freePrizes = [
  { slot: 1, type: 'coin', value: 10, weight: 220, tier: 'low', label: '10 coin' },
  { slot: 2, type: 'coin', value: 20, weight: 260, tier: 'low', label: '20 coin' },
  { slot: 3, type: 'coin', value: 30, weight: 230, tier: 'low', label: '30 coin' },
  { slot: 4, type: 'coin', value: 40, weight: 160, tier: 'mid', label: '40 coin' },
  { slot: 5, type: 'coin', value: 60, weight: 80, tier: 'mid', label: '60 coin' },
  { slot: 6, type: 'coin', value: 100, weight: 35, tier: 'mid', label: '100 coin' },
  { slot: 7, type: 'voucher', value: 'discount_5pct', weight: 10, tier: 'mid', label: '5% voucher' },
  { slot: 8, type: 'coin', value: 200, weight: 5, tier: 'high', label: '200 coin' },
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE spin_config
      ADD COLUMN free_table_id UUID NULL REFERENCES spin_config(id);

    ALTER TABLE spin_history
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'paid',
      ADD CONSTRAINT spin_history_mode_check CHECK (mode IN ('paid', 'free'));

    CREATE INDEX spin_history_user_config_created_idx
      ON spin_history(user_id, spin_config_id, created_at DESC);
    CREATE INDEX spin_history_user_mode_created_idx
      ON spin_history(user_id, mode, created_at DESC);

    INSERT INTO spin_config (id, name, ticket_coin, daily_cap, pity_threshold, prizes, is_active)
    VALUES
      ('${FREE_CONFIG_ID}', 'Default free spin table', 0, 1, 15, '${JSON.stringify(freePrizes)}'::jsonb, true),
      ('${PAID_CONFIG_ID}', 'Default paid spin table', 100, 20, 15, '${JSON.stringify(paidPrizes)}'::jsonb, true);

    UPDATE spin_config
    SET free_table_id = '${FREE_CONFIG_ID}'
    WHERE id = '${PAID_CONFIG_ID}';

    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{spin}',
      CASE region_id
        WHEN 'VN' THEN jsonb_build_object(
          'enabled', true,
          'table_id', '${PAID_CONFIG_ID}',
          'free_table_id', '${FREE_CONFIG_ID}',
          'timezone', 'Asia/Ho_Chi_Minh',
          'odds_disclosure', 'Displayed odds are base odds; pity can improve high-tier odds.'
        )
        ELSE jsonb_build_object(
          'enabled', true,
          'table_id', '${PAID_CONFIG_ID}',
          'free_table_id', '${FREE_CONFIG_ID}',
          'timezone', 'UTC',
          'odds_disclosure', 'Displayed odds are base odds; pity can improve high-tier odds.'
        )
      END
    )
    WHERE region_id IN ('VN', 'ROW');
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE region_config
    SET features = jsonb_set(
      features,
      '{spin}',
      jsonb_build_object('enabled', false, 'table_id', NULL)
    )
    WHERE region_id IN ('VN', 'ROW');

    UPDATE spin_config SET free_table_id = NULL WHERE id = '${PAID_CONFIG_ID}';
    DELETE FROM spin_config WHERE id IN ('${PAID_CONFIG_ID}', '${FREE_CONFIG_ID}');

    DROP INDEX IF EXISTS spin_history_user_mode_created_idx;
    DROP INDEX IF EXISTS spin_history_user_config_created_idx;

    ALTER TABLE spin_history DROP CONSTRAINT IF EXISTS spin_history_mode_check;
    ALTER TABLE spin_history DROP COLUMN IF EXISTS mode;
    ALTER TABLE spin_config DROP COLUMN IF EXISTS free_table_id;
  `);
};
