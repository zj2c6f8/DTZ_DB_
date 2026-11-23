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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dtz_lookup
      ON dtz_documents (api_key, db_name, collection_name);
    `);
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
