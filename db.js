const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        api_key VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE dtz_users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_documents (
        _id VARCHAR(50) PRIMARY KEY,
        api_key VARCHAR(100) NOT NULL,
        db_name VARCHAR(100) NOT NULL,
        collection_name VARCHAR(100) NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_sites (
        id SERIAL PRIMARY KEY,
        api_key VARCHAR(100) NOT NULL,
        username VARCHAR(100) NOT NULL,
        slug VARCHAR(120) NOT NULL,
        title VARCHAR(160) NOT NULL,
        html_content TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(username, slug)
      );
    `);

    // Bot Session / Auth Store
    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_sessions (
        api_key VARCHAR(100) NOT NULL,
        session_id VARCHAR(140) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key, session_id)
      );
    `);

    // Bot Group / User Config Flags
    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_configs (
        api_key VARCHAR(100) NOT NULL,
        scope_id VARCHAR(140) NOT NULL,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key, scope_id)
      );
    `);

    // Bot Task / Broadcast Queue
    await client.query(`
      CREATE TABLE IF NOT EXISTS dtz_queue (
        id SERIAL PRIMARY KEY,
        api_key VARCHAR(100) NOT NULL,
        queue_name VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dtz_lookup
      ON dtz_documents (api_key, db_name, collection_name);
    `);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
