// DeepSeek settings edited in the CMS (superadmin): the API key, the models on offer with their
// prices, and which model each AI feature uses by default. One row. Unset fields fall back to the
// environment (DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, COVER_AI_BRIEF_MODEL, NOVEL_GEN_MODEL).
//
// The key is encrypted with pgcrypto under DELIVERY_CODE_ENC_KEY, like redemption delivery codes;
// key_hint (its last 4 characters) is what the CMS shows. pgcrypto comes from migration 001.

exports.shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE ai_settings (
      id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      deepseek_api_key   TEXT,
      key_hint           TEXT,
      deepseek_base_url  TEXT,
      novel_model        TEXT,
      cover_model        TEXT,
      -- [{id, label, input_cache_hit, input_cache_miss, output}], USD per 1M tokens.
      models             JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by         UUID REFERENCES admin_users(id),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO ai_settings (id) VALUES (1);

    -- Spend per AI novel, priced with the model each call used.
    ALTER TABLE novel_gen_projects ADD COLUMN cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE novel_gen_projects DROP COLUMN cost_usd;
    DROP TABLE IF EXISTS ai_settings;
  `);
};
