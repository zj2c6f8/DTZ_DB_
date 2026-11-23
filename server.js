const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initDB } = require('./db');
const { matchesFilter, applyUpdate } = require('./queryEngine');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure DB tables exist once per cold start
let dbReady = false;
async function ensureDB(req, res, next) {
  if (!dbReady) {
    await initDB();
    dbReady = true;
  }
  next();
}
app.use(ensureDB);

function generateObjectId() {
  return crypto.randomBytes(12).toString('hex');
}

function generateApiKey() {
  return 'dtz_live_' + crypto.randomBytes(16).toString('hex');
}

async function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body.apiKey;
  if (!apiKey) {
    return res.status(401).json({ status: false, error: "DTZ DB Error: Missing API Key" });
  }
  const result = await pool.query('SELECT * FROM dtz_users WHERE api_key = $1', [apiKey]);
  if (result.rows.length === 0) {
    return res.status(403).json({ status: false, error: "DTZ DB Error: Invalid API Key" });
  }
  req.user = result.rows[0];
  next();
}

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ status: false, error: "Username & password required" });
  }
  try {
    const apiKey = generateApiKey();
    const result = await pool.query(
      'INSERT INTO dtz_users (username, password, api_key) VALUES ($1, $2, $3) RETURNING username, api_key',
      [username.trim().toLowerCase(), password, apiKey]
    );
    const host = req.get('host');
    res.json({
      status: true,
      username: result.rows[0].username,
      apiKey: result.rows[0].api_key,
      connectionUri: `dtzdb://${result.rows[0].api_key}@${host}/default_db`
    });
  } catch (err) {
    res.status(400).json({ status: false, error: "Username already exists!" });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    'SELECT username, api_key FROM dtz_users WHERE username = $1 AND password = $2',
    [String(username || '').trim().toLowerCase(), password]
  );
  if (result.rows.length === 0) {
    return res.status(401).json({ status: false, error: "Invalid credentials" });
  }
  const host = req.get('host');
  res.json({
    status: true,
    username: result.rows[0].username,
    apiKey: result.rows[0].api_key,
    connectionUri: `dtzdb://${result.rows[0].api_key}@${host}/default_db`
  });
});

// Stats (Databases & Collections)
app.get('/api/dashboard/stats', authMiddleware, async (req, res) => {
  const result = await pool.query(
    `SELECT db_name, collection_name, COUNT(*)::int as doc_count
     FROM dtz_documents WHERE api_key = $1
     GROUP BY db_name, collection_name
     ORDER BY db_name, collection_name`,
    [req.user.api_key]
  );
  res.json({ status: true, stats: result.rows });
});

// Browse Documents in Collection (for Dashboard)
app.post('/api/dashboard/docs', authMiddleware, async (req, res) => {
  const { database = 'default_db', collection } = req.body;
  if (!collection) return res.status(400).json({ status: false, error: "Collection required" });
  const result = await pool.query(
    `SELECT _id, data, created_at, updated_at
     FROM dtz_documents
     WHERE api_key = $1 AND db_name = $2 AND collection_name = $3
     ORDER BY updated_at DESC LIMIT 100`,
    [req.user.api_key, database, collection]
  );
  res.json({ status: true, documents: result.rows });
});

// Delete Document by _id (for Dashboard)
app.delete('/api/dashboard/docs/:id', authMiddleware, async (req, res) => {
  await pool.query(
    'DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2',
    [req.params.id, req.user.api_key]
  );
  res.json({ status: true, deleted: true });
});

// Core MongoDB-style CRUD API
app.post('/api/v1/action/:operation', authMiddleware, async (req, res) => {
  const { operation } = req.params;
  const { database = 'default_db', collection, filter = {}, document = {}, documents = [], update = {} } = req.body;
  const apiKey = req.user.api_key;

  if (!collection) {
    return res.status(400).json({ status: false, error: "Collection name is required" });
  }

  try {
    if (operation === 'insertOne') {
      const _id = document._id || generateObjectId();
      const finalDoc = { _id, ...document };
      await pool.query(
        'INSERT INTO dtz_documents (_id, api_key, db_name, collection_name, data) VALUES ($1, $2, $3, $4, $5)',
        [_id, apiKey, database, collection, JSON.stringify(finalDoc)]
      );
      return res.json({ status: true, acknowledged: true, insertedId: _id });
    }

    if (operation === 'insertMany') {
      const insertedIds = [];
      for (const doc of documents) {
        const _id = doc._id || generateObjectId();
        const finalDoc = { _id, ...doc };
        await pool.query(
          'INSERT INTO dtz_documents (_id, api_key, db_name, collection_name, data) VALUES ($1, $2, $3, $4, $5)',
          [_id, apiKey, database, collection, JSON.stringify(finalDoc)]
        );
        insertedIds.push(_id);
      }
      return res.json({ status: true, acknowledged: true, insertedCount: insertedIds.length, insertedIds });
    }

    const existing = await pool.query(
      'SELECT _id, data FROM dtz_documents WHERE api_key = $1 AND db_name = $2 AND collection_name = $3',
      [apiKey, database, collection]
    );
    const allDocs = existing.rows.map(r => r.data);

    if (operation === 'findOne') {
      const found = allDocs.find(doc => matchesFilter(doc, filter)) || null;
      return res.json({ status: true, document: found });
    }

    if (operation === 'find') {
      const matched = allDocs.filter(doc => matchesFilter(doc, filter));
      return res.json({ status: true, count: matched.length, documents: matched });
    }

    if (operation === 'updateOne') {
      const target = allDocs.find(doc => matchesFilter(doc, filter));
      if (!target) return res.json({ status: true, matchedCount: 0, modifiedCount: 0 });
      const updatedDoc = applyUpdate(target, update);
      await pool.query(
        'UPDATE dtz_documents SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE _id = $2 AND api_key = $3',
        [JSON.stringify(updatedDoc), target._id, apiKey]
      );
      return res.json({ status: true, matchedCount: 1, modifiedCount: 1 });
    }

    if (operation === 'deleteOne') {
      const target = allDocs.find(doc => matchesFilter(doc, filter));
      if (!target) return res.json({ status: true, deletedCount: 0 });
      await pool.query(
        'DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2',
        [target._id, apiKey]
      );
      return res.json({ status: true, deletedCount: 1 });
    }

    if (operation === 'deleteMany') {
      const targets = allDocs.filter(doc => matchesFilter(doc, filter));
      for (const t of targets) {
        await pool.query('DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2', [t._id, apiKey]);
      }
      return res.json({ status: true, deletedCount: targets.length });
    }

    return res.status(400).json({ status: false, error: `Unknown operation: ${operation}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: false, error: "Internal DTZ DB Engine Error" });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ service: "DTZ DB Cloud NoSQL Engine", status: "ONLINE", version: "1.0.0" });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 DTZ DB Server running on port ${PORT}`));
}

module.exports = app;
