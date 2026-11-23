const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initDB } = require('./db');
const { matchesFilter, sortDocuments, applyUpdate } = require('./queryEngine');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

function generateAutoCredentials() {
  const username = 'dtz_' + crypto.randomBytes(3).toString('hex');
  const password = crypto.randomBytes(6).toString('base64url');
  return { username, password };
}

function sanitizeSlug(input) {
  const clean = String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return clean || 'site-' + crypto.randomBytes(2).toString('hex');
}

async function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.body.apiKey || req.query.apiKey;
  if (!apiKey) {
    return res.status(401).json({ status: false, error: 'DTZ DB Error: Missing API Key' });
  }
  const result = await pool.query('SELECT * FROM dtz_users WHERE api_key = $1', [apiKey]);
  if (result.rows.length === 0) {
    return res.status(403).json({ status: false, error: 'DTZ DB Error: Invalid API Key' });
  }
  req.user = result.rows[0];
  next();
}

// ================= AUTH & AUTO CREDENTIALS =================

// Auto-generate Username + Password + API Key
app.post('/api/auth/auto-register', async (req, res) => {
  try {
    let created = null;
    for (let i = 0; i < 5; i++) {
      const { username, password } = generateAutoCredentials();
      const apiKey = generateApiKey();
      try {
        const result = await pool.query(
          'INSERT INTO dtz_users (username, password, api_key) VALUES ($1, $2, $3) RETURNING username, password, api_key',
          [username, password, apiKey]
        );
        created = result.rows[0];
        break;
      } catch {}
    }

    if (!created) {
      return res.status(500).json({ status: false, error: 'Could not generate unique credentials' });
    }

    const host = req.headers['x-forwarded-host'] || req.get('host');
    res.json({
      status: true,
      username: created.username,
      password: created.password,
      apiKey: created.api_key,
      connectionUri: `dtzdb://${created.api_key}@${host}/default_db`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: false, error: 'Auto-register failed' });
  }
});

// Custom Register (optional)
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ status: false, error: 'Username & password required' });
  }
  try {
    const apiKey = generateApiKey();
    const result = await pool.query(
      'INSERT INTO dtz_users (username, password, api_key) VALUES ($1, $2, $3) RETURNING username, password, api_key',
      [String(username).trim().toLowerCase(), password, apiKey]
    );
    const host = req.headers['x-forwarded-host'] || req.get('host');
    res.json({
      status: true,
      username: result.rows[0].username,
      password: result.rows[0].password,
      apiKey: result.rows[0].api_key,
      connectionUri: `dtzdb://${result.rows[0].api_key}@${host}/default_db`
    });
  } catch {
    res.status(400).json({ status: false, error: 'Username already exists!' });
  }
});

// Login with Username + Password
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await pool.query(
    'SELECT username, password, api_key FROM dtz_users WHERE username = $1 AND password = $2',
    [String(username || '').trim().toLowerCase(), password]
  );
  if (result.rows.length === 0) {
    return res.status(401).json({ status: false, error: 'Invalid username or password' });
  }
  const host = req.headers['x-forwarded-host'] || req.get('host');
  res.json({
    status: true,
    username: result.rows[0].username,
    password: result.rows[0].password,
    apiKey: result.rows[0].api_key,
    connectionUri: `dtzdb://${result.rows[0].api_key}@${host}/default_db`
  });
});

// ================= DASHBOARD & LIVE SITE HOSTING =================

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

app.post('/api/dashboard/docs', authMiddleware, async (req, res) => {
  const { database = 'default_db', collection, filter = {} } = req.body;
  if (!collection) return res.status(400).json({ status: false, error: 'Collection required' });
  const result = await pool.query(
    `SELECT _id, data, created_at, updated_at
     FROM dtz_documents
     WHERE api_key = $1 AND db_name = $2 AND collection_name = $3
     ORDER BY updated_at DESC LIMIT 100`,
    [req.user.api_key, database, collection]
  );
  const filtered = result.rows.filter((r) => matchesFilter(r.data, filter));
  res.json({ status: true, documents: filtered });
});

app.put('/api/dashboard/docs/:id', authMiddleware, async (req, res) => {
  const { data } = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ status: false, error: 'Valid JSON object required' });
  }
  const finalDoc = { ...data, _id: req.params.id };
  const updated = await pool.query(
    `UPDATE dtz_documents
     SET data = $1, updated_at = CURRENT_TIMESTAMP
     WHERE _id = $2 AND api_key = $3
     RETURNING _id, data`,
    [JSON.stringify(finalDoc), req.params.id, req.user.api_key]
  );
  if (updated.rowCount === 0) {
    return res.status(404).json({ status: false, error: 'Document not found' });
  }
  res.json({ status: true, document: updated.rows[0] });
});

app.delete('/api/dashboard/docs/:id', authMiddleware, async (req, res) => {
  await pool.query(
    'DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2',
    [req.params.id, req.user.api_key]
  );
  res.json({ status: true, deleted: true });
});

// Publish / Update a Live HTML Site from DTZ DB
app.post('/api/sites/publish', authMiddleware, async (req, res) => {
  const { title = 'DTZ Live Site', slug: rawSlug, html } = req.body;
  if (!html || typeof html !== 'string' || !html.trim()) {
    return res.status(400).json({ status: false, error: 'HTML content is required' });
  }
  const slug = sanitizeSlug(rawSlug || title);
  const username = req.user.username;

  const saved = await pool.query(
    `INSERT INTO dtz_sites (api_key, username, slug, title, html_content, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (username, slug)
     DO UPDATE SET title = EXCLUDED.title, html_content = EXCLUDED.html_content, updated_at = CURRENT_TIMESTAMP
     RETURNING id, username, slug, title, updated_at`,
    [req.user.api_key, username, slug, String(title).slice(0, 160), html]
  );

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const liveUrl = `${proto}://${host}/s/${username}/${slug}`;

  res.json({ status: true, site: saved.rows[0], liveUrl });
});

// List user's Live Sites
app.get('/api/sites/list', authMiddleware, async (req, res) => {
  const rows = await pool.query(
    `SELECT id, username, slug, title, updated_at
     FROM dtz_sites WHERE api_key = $1 ORDER BY updated_at DESC`,
    [req.user.api_key]
  );
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const sites = rows.rows.map((s) => ({
    ...s,
    liveUrl: `${proto}://${host}/s/${s.username}/${s.slug}`
  }));
  res.json({ status: true, sites });
});

// Delete a Live Site
app.delete('/api/sites/:slug', authMiddleware, async (req, res) => {
  const slug = sanitizeSlug(req.params.slug);
  await pool.query(
    'DELETE FROM dtz_sites WHERE api_key = $1 AND slug = $2',
    [req.user.api_key, slug]
  );
  res.json({ status: true, deleted: true });
});

// Serve Published Live Site publicly at /s/:username/:slug
app.get('/s/:username/:slug', async (req, res) => {
  const username = String(req.params.username || '').toLowerCase();
  const slug = sanitizeSlug(req.params.slug);
  const found = await pool.query(
    'SELECT html_content FROM dtz_sites WHERE username = $1 AND slug = $2',
    [username, slug]
  );
  if (found.rows.length === 0) {
    return res.status(404).send('<h1>404 — DTZ Live Site Not Found</h1>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(found.rows[0].html_content);
});

// ================= CORE MONGODB-STYLE CRUD ENGINE =================

app.post('/api/v1/action/:operation', authMiddleware, async (req, res) => {
  const { operation } = req.params;
  const {
    database = 'default_db',
    collection,
    filter = {},
    document = {},
    documents = [],
    update = {},
    sort = {},
    limit = 0
  } = req.body;
  const apiKey = req.user.api_key;

  if (!collection) {
    return res.status(400).json({ status: false, error: 'Collection name is required' });
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

    if (operation === 'dropCollection') {
      const del = await pool.query(
        'DELETE FROM dtz_documents WHERE api_key = $1 AND db_name = $2 AND collection_name = $3',
        [apiKey, database, collection]
      );
      return res.json({ status: true, dropped: true, deletedCount: del.rowCount });
    }

    const existing = await pool.query(
      'SELECT _id, data FROM dtz_documents WHERE api_key = $1 AND db_name = $2 AND collection_name = $3',
      [apiKey, database, collection]
    );
    const allDocs = existing.rows.map((r) => r.data);

    if (operation === 'findOne') {
      const found = allDocs.find((doc) => matchesFilter(doc, filter)) || null;
      return res.json({ status: true, document: found });
    }

    if (operation === 'find') {
      let matched = allDocs.filter((doc) => matchesFilter(doc, filter));
      matched = sortDocuments(matched, sort);
      if (Number(limit) > 0) matched = matched.slice(0, Number(limit));
      return res.json({ status: true, count: matched.length, documents: matched });
    }

    if (operation === 'countDocuments') {
      const count = allDocs.filter((doc) => matchesFilter(doc, filter)).length;
      return res.json({ status: true, count });
    }

    if (operation === 'updateOne') {
      const target = allDocs.find((doc) => matchesFilter(doc, filter));
      if (!target) return res.json({ status: true, matchedCount: 0, modifiedCount: 0 });
      const updatedDoc = applyUpdate(target, update);
      await pool.query(
        'UPDATE dtz_documents SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE _id = $2 AND api_key = $3',
        [JSON.stringify(updatedDoc), target._id, apiKey]
      );
      return res.json({ status: true, matchedCount: 1, modifiedCount: 1 });
    }

    if (operation === 'updateMany') {
      const targets = allDocs.filter((doc) => matchesFilter(doc, filter));
      for (const target of targets) {
        const updatedDoc = applyUpdate(target, update);
        await pool.query(
          'UPDATE dtz_documents SET data = $1, updated_at = CURRENT_TIMESTAMP WHERE _id = $2 AND api_key = $3',
          [JSON.stringify(updatedDoc), target._id, apiKey]
        );
      }
      return res.json({ status: true, matchedCount: targets.length, modifiedCount: targets.length });
    }

    if (operation === 'deleteOne') {
      const target = allDocs.find((doc) => matchesFilter(doc, filter));
      if (!target) return res.json({ status: true, deletedCount: 0 });
      await pool.query(
        'DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2',
        [target._id, apiKey]
      );
      return res.json({ status: true, deletedCount: 1 });
    }

    if (operation === 'deleteMany') {
      const targets = allDocs.filter((doc) => matchesFilter(doc, filter));
      for (const t of targets) {
        await pool.query('DELETE FROM dtz_documents WHERE _id = $1 AND api_key = $2', [t._id, apiKey]);
      }
      return res.json({ status: true, deletedCount: targets.length });
    }

    return res.status(400).json({ status: false, error: `Unknown operation: ${operation}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: false, error: 'Internal DTZ DB Engine Error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ service: 'DTZ DB Cloud NoSQL + Site Host Engine', status: 'ONLINE', version: '1.2.0' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🚀 DTZ DB Server running on port ${PORT}`));
}

module.exports = app;
