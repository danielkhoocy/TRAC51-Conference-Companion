const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'production';
const IS_PROD = NODE_ENV === 'production';
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PARTICIPANT_SECRET = process.env.PARTICIPANT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const DATA_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.STORAGE_DIR || path.join(__dirname, 'data');
const UPLOAD_ROOT = path.join(DATA_ROOT, 'uploads');

if (IS_PROD && (!ADMIN_USER || !ADMIN_PASSWORD || !SESSION_SECRET || !PARTICIPANT_SECRET || !DATABASE_URL)) {
  throw new Error('Missing required production environment variables. Set ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET, PARTICIPANT_SECRET and DATABASE_URL.');
}

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const publicPath = path.join(__dirname, 'public');
const seedPath = path.join(__dirname, 'seed', 'demo-db.json');
const sseClients = new Set();
const loginBuckets = new Map();

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function normalizeNRIC(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function createToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmac(SESSION_SECRET || 'development-secret', encoded);
  return `${encoded}.${signature}`;
}

function verifyToken(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!safeEqual(hmac(SESSION_SECRET, encoded), sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : '';
}

function sessionFromRequest(req) {
  const token = cookieValue(req, 'trac51_session');
  return verifyToken(token);
}

function setSession(res, payload, maxAgeSeconds = 60 * 60 * 12) {
  const token = createToken({ ...payload, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds });
  const secure = IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie', `trac51_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSession(res) {
  const secure = IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie', `trac51_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function requireParticipant(req, res) {
  const session = sessionFromRequest(req);
  if (!session || session.kind !== 'participant' || !session.delegateId) {
    json(res, 401, { error: 'Participant login required' });
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  const session = sessionFromRequest(req);
  if (!session || session.kind !== 'admin') {
    json(res, 401, { error: 'Admin authorization required' });
    return null;
  }
  return session;
}

function requireAnyAuth(req, res) {
  const session = sessionFromRequest(req);
  if (!session || !['participant', 'admin'].includes(session.kind)) {
    json(res, 401, { error: 'Sign in required' });
    return null;
  }
  return session;
}

function ipKey(req, scope) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return `${scope}:${forwarded || req.socket.remoteAddress || 'unknown'}`;
}

function allowLogin(req, scope, limit, windowMs) {
  const key = ipKey(req, scope);
  const now = Date.now();
  const entry = loginBuckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + windowMs;
  }
  entry.count += 1;
  loginBuckets.set(key, entry);
  return entry.count <= limit;
}

function body(req, maxBytes = 5_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON request'));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(v, max = 2000) {
  return String(v ?? '').trim().slice(0, max);
}

function safeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

function publicDelegate(row) {
  return {
    id: String(row.id),
    external_id: row.external_id || '',
    name: row.name,
    church: row.church || '',
    district: row.district || '',
    role: row.conference_role || '',
    boards: row.boards || '',
    email: row.email || '',
    phone: row.phone || '',
    photo_url: row.photo_url || '',
  };
}

async function q(text, params = []) {
  return pool.query(text, params);
}

async function audit(actor, action, details = {}) {
  try {
    await q('INSERT INTO audit_logs(actor_type, actor_id, action, details) VALUES($1,$2,$3,$4)', [actor?.kind || 'system', actor?.actorId || null, action, details]);
  } catch (e) {
    console.error('audit error', e.message);
  }
}

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS conference_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      title TEXT NOT NULL DEFAULT 'TRAC51 Conference Companion',
      current_live_id BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS delegates (
      id BIGSERIAL PRIMARY KEY,
      external_id TEXT,
      name TEXT NOT NULL,
      nric_hash TEXT NOT NULL UNIQUE,
      pin_hash TEXT NOT NULL,
      church TEXT,
      district TEXT,
      conference_role TEXT,
      boards TEXT,
      email TEXT,
      phone TEXT,
      photo_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(external_id)
    );
    CREATE TABLE IF NOT EXISTS agenda (
      id BIGSERIAL PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      date_text TEXT NOT NULL DEFAULT '2026-11-22',
      time_text TEXT,
      title TEXT NOT NULL,
      description TEXT,
      venue TEXT,
      presenter TEXT,
      presenter_email TEXT,
      presenter_phone TEXT,
      report_name TEXT,
      report_path TEXT,
      slides_name TEXT,
      slides_path TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS feed (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'Announcement',
      title TEXT NOT NULL,
      body TEXT,
      image_path TEXT,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      when_text TEXT,
      place TEXT,
      capacity INTEGER NOT NULL DEFAULT 50,
      open BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS event_registrations (
      event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      delegate_id BIGINT NOT NULL REFERENCES delegates(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(event_id, delegate_id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Resource',
      path TEXT,
      related_agenda_id BIGINT REFERENCES agenda(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS photos (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      caption TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS moderation (
      id BIGSERIAL PRIMARY KEY,
      delegate_id BIGINT REFERENCES delegates(id) ON DELETE SET NULL,
      agenda_id BIGINT REFERENCES agenda(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'Question',
      status TEXT NOT NULL DEFAULT 'Pending',
      moderated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS help_requests (
      id BIGSERIAL PRIMARY KEY,
      delegate_id BIGINT REFERENCES delegates(id) ON DELETE SET NULL,
      type TEXT NOT NULL DEFAULT 'Help',
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      closed_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS content_pages (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agenda_sort ON agenda(sort_order);
    CREATE INDEX IF NOT EXISTS idx_feed_created ON feed(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_moderation_status ON moderation(status);
    CREATE INDEX IF NOT EXISTS idx_help_status ON help_requests(status);
    CREATE INDEX IF NOT EXISTS idx_registrations_event ON event_registrations(event_id);
    INSERT INTO conference_state(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  const state = await q('SELECT COUNT(*)::int AS c FROM agenda');
  if (state.rows[0].c === 0 && fs.existsSync(seedPath) && process.env.SEED_DEMO === 'true') {
    await seedDemo();
  }

  const pageCount = await q('SELECT COUNT(*)::int AS c FROM content_pages');
  if (pageCount.rows[0].c === 0) {
    const pages = [
      ['welcome', 'Welcome', 'Welcome to TRAC51.\n\nPresident’s Welcome\nConference Secretary\nTRAC51 Theme'],
      ['people', 'People & Planning', 'Local Planning Committee\nDistrict Superintendent\nSecretariat contacts'],
      ['penang', 'Penang', 'Local insights\nHeritage & food\nGetting around Penang'],
      ['registration', 'Registration', 'Registration desk: Ground Floor, Lobby\nOpen 7:30 AM – 5:30 PM'],
      ['ordination', 'Ordination Service', 'Directions, transport timing and arrival instructions will be posted here.'],
      ['checkout', 'Checkout', 'Hotel checkout details, luggage arrangements and bus departure information.'],
      ['local', 'TRAC51 · Local Team', 'Meet the local planning committee.\n\nPenang in 60 seconds.\n\nTRAC51 stories, updates and local tips.']
    ];
    for (const [slug, title, bodyText] of pages) {
      await q('INSERT INTO content_pages(slug,title,body) VALUES($1,$2,$3) ON CONFLICT(slug) DO NOTHING', [slug, title, bodyText]);
    }
  }
}

async function seedDemo() {
  let demo;
  try { demo = JSON.parse(fs.readFileSync(seedPath, 'utf8')); } catch { return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const idMap = new Map();
    for (const a of (demo.agenda || [])) {
      const r = await client.query(`INSERT INTO agenda(sort_order,date_text,time_text,title,description,venue,presenter,report_name,slides_name,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [
        Number(a.sort_order ?? a.id ?? 0), a.date || '2026-11-22', a.time || '', a.title || 'Agenda item', a.desc || '', a.venue || '', a.presenter || '', a.report || '', a.slides || '', a.status || 'scheduled'
      ]);
      idMap.set(Number(a.id), r.rows[0].id);
    }
    if ((demo.agenda || []).length) {
      const first = idMap.values().next().value;
      await client.query('UPDATE conference_state SET current_live_id=$1, updated_at=NOW() WHERE id=1', [first]);
    }
    for (const f of (demo.feed || [])) {
      await client.query('INSERT INTO feed(type,title,body,published) VALUES($1,$2,$3,$4)', [f.type || 'Announcement', f.title || 'Announcement', f.body || '', true]);
    }
    for (const e of (demo.events || [])) {
      await client.query('INSERT INTO events(name,when_text,place,capacity,open) VALUES($1,$2,$3,$4,$5)', [e.name || 'Event', e.when || '', e.place || '', Number(e.capacity || 50), true]);
    }
    for (const d of (demo.docs || [])) {
      await client.query('INSERT INTO documents(name,type,path) VALUES($1,$2,$3)', [d.name || 'Document', d.type || 'Resource', d.path || null]);
    }
    for (const p of (demo.photos || [])) {
      if (p.path && p.path.startsWith('/uploads/')) continue;
    }
    // Synthetic demo participant. Clearly marked, never use this row for real conference data.
    const nric = '900101145678';
    await client.query(`INSERT INTO delegates(external_id,name,nric_hash,pin_hash,church,district,conference_role,boards,email,phone,photo_url)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(nric_hash) DO NOTHING`, [
      'DEMO-001', 'Demo Delegate', hmac(PARTICIPANT_SECRET || 'demo-secret', nric), hmac(PARTICIPANT_SECRET || 'demo-secret', nric.slice(-6)), 'Demo Methodist Church', 'Northern', 'Delegate', 'Board of Demonstration', '', '', ''
    ]);
    await client.query('COMMIT');
    console.log('Demo data seeded. Synthetic login: NRIC 900101145678 / PIN 145678');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Demo seed failed', e);
  } finally {
    client.release();
  }
}

async function getPublicBundle(delegateId) {
  const [state, agenda, delegates, feed, events, docs, photos, content] = await Promise.all([
    q('SELECT current_live_id FROM conference_state WHERE id=1'),
    q('SELECT id, time_text AS time, title, description AS desc, venue, presenter, presenter_email, presenter_phone, report_name AS report, report_path, slides_name AS slides, slides_path, date_text AS date, status FROM agenda ORDER BY sort_order, time_text, id'),
    q(`SELECT id, external_id, name, church, district, conference_role, boards, email, phone, photo_url FROM delegates WHERE status='active' ORDER BY name`),
    q('SELECT id, type, title, body, image_path AS image, to_char(created_at, \'HH24:MI\') AS time FROM feed WHERE published=true ORDER BY created_at DESC LIMIT 100'),
    q(`SELECT e.id, e.name, e.when_text AS "when", e.place, e.capacity, e.open,
        (e.capacity - COUNT(r.delegate_id))::int AS spots,
        EXISTS(SELECT 1 FROM event_registrations rr WHERE rr.event_id=e.id AND rr.delegate_id=$1) AS joined
        FROM events e LEFT JOIN event_registrations r ON r.event_id=e.id
        GROUP BY e.id ORDER BY e.created_at`, [delegateId]),
    q('SELECT id, name, type, path, related_agenda_id AS related_agenda_id FROM documents ORDER BY created_at DESC'),
    q('SELECT id, name, path, caption FROM photos ORDER BY created_at DESC'),
    q('SELECT slug, title, body FROM content_pages ORDER BY slug')
  ]);
  const viewerRow = delegates.rows.find(d => String(d.id) === String(delegateId));
  return {
    currentLive: state.rows[0]?.current_live_id ? Number(state.rows[0].current_live_id) : null,
    agenda: agenda.rows.map(a => ({ ...a, id: Number(a.id) })),
    delegates: delegates.rows.map(publicDelegate),
    viewer: viewerRow ? publicDelegate(viewerRow) : null,
    feed: feed.rows.map(f => ({ ...f, id: Number(f.id) })),
    events: events.rows.map(e => ({ ...e, id: Number(e.id), capacity: Number(e.capacity), spots: Number(e.spots), joined: !!e.joined })),
    docs: docs.rows.map(d => ({ ...d, id: Number(d.id) })),
    photos: photos.rows.map(p => ({ ...p, id: Number(p.id) })),
    content: Object.fromEntries(content.rows.map(c => [c.slug, c])),
    settings: { title: 'TRAC51 Conference Companion' }
  };
}

async function getAdminBundle() {
  const pub = await getPublicBundle((await q('SELECT id FROM delegates ORDER BY id LIMIT 1')).rows[0]?.id || 0);
  const [moderation, help, stats] = await Promise.all([
    q(`SELECT m.id, m.text, m.kind, m.status, to_char(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
              COALESCE(d.name,'Delegate') AS "from"
       FROM moderation m LEFT JOIN delegates d ON d.id=m.delegate_id ORDER BY m.created_at DESC LIMIT 200`),
    q(`SELECT h.id, h.type, h.text, h.status, to_char(h.created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt",
              COALESCE(d.name,'Delegate') AS "from"
       FROM help_requests h LEFT JOIN delegates d ON d.id=h.delegate_id ORDER BY h.created_at DESC LIMIT 200`),
    q(`SELECT
      (SELECT COUNT(*) FROM delegates WHERE status='active')::int AS delegates,
      (SELECT COUNT(*) FROM agenda)::int AS agenda,
      (SELECT COUNT(*) FROM events WHERE open=true)::int AS events,
      (SELECT COUNT(*) FROM documents)::int AS docs,
      (SELECT COUNT(*) FROM moderation WHERE status='Pending')::int AS pending,
      (SELECT COUNT(*) FROM help_requests WHERE status='Open')::int AS open_help`)
  ]);
  pub.moderation = moderation.rows.map(m => ({ ...m, id: Number(m.id) }));
  pub.helpRequests = help.rows.map(h => ({ ...h, id: Number(h.id) }));
  pub.stats = stats.rows[0];
  return pub;
}

function serveStatic(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.json':'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function serveUpload(req, res, pathname) {
  const session = requireAnyAuth(req, res);
  if (!session) return;
  const requested = path.basename(pathname.slice('/uploads/'.length));
  if (!requested || requested.includes('..')) return json(res, 400, { error: 'Invalid file' });
  const file = path.join(UPLOAD_ROOT, requested);
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const ext = path.extname(file).toLowerCase();
    const types = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  } catch { json(res, 404, { error: 'File not found' }); }
}

async function saveUploadedFile(input, category) {
  if (!input?.filename || !input?.data) throw new Error('Choose a file first.');
  const match = String(input.data).match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Invalid file payload.');
  const mime = match[1];
  const allowed = category === 'photos'
    ? new Set(['image/jpeg','image/png','image/webp','image/gif'])
    : new Set(['application/pdf','image/jpeg','image/png','image/webp']);
  if (!allowed.has(mime)) throw new Error('File type not permitted. PDF/JPG/PNG/WEBP only.');
  const buf = Buffer.from(match[2], 'base64');
  const max = category === 'photos' ? 8_000_000 : 20_000_000;
  if (buf.length > max) throw new Error(`File is too large. Maximum ${Math.floor(max/1_000_000)} MB.`);
  const id = crypto.randomUUID();
  const ext = path.extname(safeFileName(input.filename)).toLowerCase() || (mime === 'application/pdf' ? '.pdf' : '.bin');
  const filename = `${id}${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_ROOT, filename), buf, { flag: 'wx', mode: 0o600 });
  return `/uploads/${filename}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    const method = req.method;

    if (p === '/health' && method === 'GET') return json(res, 200, { ok: true, service: 'trac51', time: new Date().toISOString() });

    if (p === '/api/login' && method === 'POST') {
      if (!allowLogin(req, 'admin', 8, 10 * 60 * 1000)) return json(res, 429, { error: 'Too many login attempts. Please try again later.' });
      const b = await body(req);
      if (safeEqual(b.username || '', ADMIN_USER || '') && safeEqual(b.password || '', ADMIN_PASSWORD || '')) {
        setSession(res, { kind: 'admin', actorId: ADMIN_USER });
        await audit({ kind: 'admin', actorId: ADMIN_USER }, 'admin.login');
        return json(res, 200, { ok: true, user: ADMIN_USER, role: 'admin' });
      }
      return json(res, 401, { error: 'Invalid admin credentials' });
    }

    if (p === '/api/logout' && method === 'POST') {
      clearSession(res);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/participant/login' && method === 'POST') {
      if (!allowLogin(req, 'participant', 12, 10 * 60 * 1000)) return json(res, 429, { error: 'Too many login attempts. Please try again later.' });
      const b = await body(req);
      const nric = normalizeNRIC(b.nric);
      const pin = String(b.pin || '');
      if (nric.length !== 12 || !/^\d{6}$/.test(pin)) return json(res, 400, { error: 'Enter your 12-digit NRIC and 6-digit PIN.' });
      const row = await q(`SELECT id, external_id, name, church, district, conference_role, boards, email, phone, photo_url, nric_hash, pin_hash FROM delegates WHERE status='active' AND nric_hash=$1 LIMIT 1`, [hmac(PARTICIPANT_SECRET, nric)]);
      const d = row.rows[0];
      if (!d || !safeEqual(d.pin_hash, hmac(PARTICIPANT_SECRET, pin))) return json(res, 401, { error: 'Invalid NRIC or PIN' });
      setSession(res, { kind: 'participant', delegateId: String(d.id) }, 60 * 60 * 24);
      await audit({ kind: 'participant', actorId: String(d.id) }, 'participant.login');
      return json(res, 200, { ok: true, delegate: publicDelegate(d) });
    }

    if (p === '/api/participant/me' && method === 'GET') {
      const s = requireParticipant(req, res); if (!s) return;
      const r = await q(`SELECT id, external_id, name, church, district, conference_role, boards, email, phone, photo_url FROM delegates WHERE id=$1`, [s.delegateId]);
      if (!r.rows[0]) return json(res, 404, { error: 'Participant not found' });
      return json(res, 200, { delegate: publicDelegate(r.rows[0]) });
    }

    if (p === '/api/participant/logout' && method === 'POST') {
      clearSession(res);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/public' && method === 'GET') {
      const s = requireParticipant(req, res); if (!s) return;
      return json(res, 200, await getPublicBundle(s.delegateId));
    }

    if (p === '/api/stream' && method === 'GET') {
      const s = requireParticipant(req, res); if (!s) return;
      res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-store', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (p === '/api/admin' && method === 'GET') {
      const s = requireAdmin(req, res); if (!s) return;
      return json(res, 200, await getAdminBundle());
    }

    if (p === '/api/admin/live' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req);
      const id = Number(b.id);
      const exists = await q('SELECT id FROM agenda WHERE id=$1', [id]);
      if (!exists.rows[0]) return json(res, 404, { error: 'Agenda item not found' });
      await q('UPDATE conference_state SET current_live_id=$1, updated_at=NOW() WHERE id=1', [id]);
      await audit(s, 'agenda.live_changed', { agendaId: id });
      broadcast('live-change', { agendaId: id });
      return json(res, 200, { currentLive: id });
    }

    if (p === '/api/admin/agenda' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req);
      const fields = [cleanText(b.time, 100), cleanText(b.title, 250), cleanText(b.desc, 2000), cleanText(b.venue, 250), cleanText(b.presenter, 250), cleanText(b.presenterEmail, 250), cleanText(b.presenterPhone, 80), cleanText(b.report, 250), cleanText(b.slides, 250), cleanText(b.date, 50) || '2026-11-22', cleanText(b.status, 50) || 'scheduled'];
      if (!fields[1]) return json(res, 400, { error: 'Agenda title is required' });
      if (b.id) {
        const id = Number(b.id);
        await q(`UPDATE agenda SET time_text=$1,title=$2,description=$3,venue=$4,presenter=$5,presenter_email=$6,presenter_phone=$7,report_name=$8,slides_name=$9,date_text=$10,status=$11,updated_at=NOW() WHERE id=$12`, [...fields, id]);
        await audit(s, 'agenda.updated', { agendaId: id });
      } else {
        const r = await q(`INSERT INTO agenda(sort_order,time_text,title,description,venue,presenter,presenter_email,presenter_phone,report_name,slides_name,date_text,status) VALUES((SELECT COALESCE(MAX(sort_order)+1,1) FROM agenda),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, fields);
        await audit(s, 'agenda.created', { agendaId: Number(r.rows[0].id) });
      }
      broadcast('content-change', { type: 'agenda' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/agenda/delete' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const id = Number(b.id);
      await q('DELETE FROM agenda WHERE id=$1', [id]);
      await q('UPDATE conference_state SET current_live_id=NULL WHERE id=1 AND current_live_id=$1', [id]);
      await audit(s, 'agenda.deleted', { agendaId: id });
      broadcast('content-change', { type: 'agenda' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/posts' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req);
      const title = cleanText(b.title, 250); if (!title) return json(res, 400, { error: 'Headline is required' });
      const r = await q('INSERT INTO feed(type,title,body,image_path,published) VALUES($1,$2,$3,$4,TRUE) RETURNING id', [cleanText(b.type, 80) || 'Announcement', title, cleanText(b.body, 3000), cleanText(b.image, 500)]);
      await audit(s, 'feed.published', { feedId: Number(r.rows[0].id) });
      broadcast('announcement', { id: Number(r.rows[0].id) });
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/admin/posts/') && method === 'DELETE') {
      const s = requireAdmin(req, res); if (!s) return;
      const id = Number(p.split('/').pop());
      await q('UPDATE feed SET published=false WHERE id=$1', [id]);
      await audit(s, 'feed.removed', { feedId: id });
      broadcast('content-change', { type: 'feed' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/moderation' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const id = Number(b.id); const status = ['Approved','Rejected','Hidden'].includes(b.status) ? b.status : 'Pending';
      await q('UPDATE moderation SET status=$1, moderated_by=$2 WHERE id=$3', [status, s.actorId, id]);
      await audit(s, 'moderation.updated', { moderationId: id, status });
      broadcast('content-change', { type: 'moderation' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/help' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const id = Number(b.id); const status = b.status === 'Closed' ? 'Closed' : 'Open';
      await q('UPDATE help_requests SET status=$1, closed_by=$2 WHERE id=$3', [status, s.actorId, id]);
      await audit(s, 'help.updated', { helpId: id, status });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/events' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const name = cleanText(b.name, 250); const capacity = Math.max(0, Math.min(5000, Number(b.capacity || 0)));
      if (!name || !capacity) return json(res, 400, { error: 'Event name and capacity are required' });
      if (b.id) {
        await q('UPDATE events SET name=$1,when_text=$2,place=$3,capacity=$4,updated_at=NOW() WHERE id=$5', [name, cleanText(b.when, 120), cleanText(b.place, 250), capacity, Number(b.id)]);
        await audit(s, 'event.updated', { eventId: Number(b.id) });
      } else {
        const r = await q('INSERT INTO events(name,when_text,place,capacity) VALUES($1,$2,$3,$4) RETURNING id', [name, cleanText(b.when, 120), cleanText(b.place, 250), capacity]);
        await audit(s, 'event.created', { eventId: Number(r.rows[0].id) });
      }
      broadcast('content-change', { type: 'events' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/events/join' && method === 'POST') {
      const s = requireParticipant(req, res); if (!s) return;
      const b = await body(req); const eventId = Number(b.eventId); const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const e = await client.query('SELECT id, capacity, open FROM events WHERE id=$1 FOR UPDATE', [eventId]);
        if (!e.rows[0]) { await client.query('ROLLBACK'); return json(res, 404, { error: 'Event not found' }); }
        if (!e.rows[0].open) { await client.query('ROLLBACK'); return json(res, 409, { error: 'Registration is closed' }); }
        const existing = await client.query('SELECT 1 FROM event_registrations WHERE event_id=$1 AND delegate_id=$2', [eventId, s.delegateId]);
        if (existing.rows[0]) {
          await client.query('DELETE FROM event_registrations WHERE event_id=$1 AND delegate_id=$2', [eventId, s.delegateId]);
          const count = await client.query('SELECT (capacity-COUNT(r.delegate_id))::int AS spots FROM events e LEFT JOIN event_registrations r ON r.event_id=e.id WHERE e.id=$1 GROUP BY e.id', [eventId]);
          await client.query('COMMIT');
          broadcast('content-change', { type: 'events' });
          return json(res, 200, { joined: false, spots: count.rows[0].spots });
        }
        const count = await client.query('SELECT (capacity-COUNT(r.delegate_id))::int AS spots FROM events e LEFT JOIN event_registrations r ON r.event_id=e.id WHERE e.id=$1 GROUP BY e.id', [eventId]);
        if (Number(count.rows[0].spots) <= 0) { await client.query('ROLLBACK'); return json(res, 409, { error: 'Event full' }); }
        await client.query('INSERT INTO event_registrations(event_id,delegate_id) VALUES($1,$2)', [eventId, s.delegateId]);
        const remaining = Number(count.rows[0].spots) - 1;
        await client.query('COMMIT');
        await audit(s, 'event.registration', { eventId, joined: true });
        broadcast('content-change', { type: 'events' });
        return json(res, 200, { joined: true, spots: remaining });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }

    if (p === '/api/help' && method === 'POST') {
      const s = requireParticipant(req, res); if (!s) return;
      const b = await body(req);
      const type = cleanText(b.type, 120) || 'Help'; const text = cleanText(b.text, 3000);
      if (!text) return json(res, 400, { error: 'Please tell us what you need.' });
      const r = await q('INSERT INTO help_requests(delegate_id,type,text) VALUES($1,$2,$3) RETURNING id', [s.delegateId, type, text]);
      await audit(s, 'help.created', { helpId: Number(r.rows[0].id), type });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/questions' && method === 'POST') {
      const s = requireParticipant(req, res); if (!s) return;
      const b = await body(req);
      const text = cleanText(b.text, 3000); if (!text) return json(res, 400, { error: 'Question cannot be empty.' });
      const agendaId = b.agendaId ? Number(b.agendaId) : null;
      const r = await q('INSERT INTO moderation(delegate_id,agenda_id,text,kind,status) VALUES($1,$2,$3,$4,\'Pending\') RETURNING id', [s.delegateId, agendaId, text, cleanText(b.kind, 40) || 'Question']);
      await audit(s, 'moderation.submitted', { moderationId: Number(r.rows[0].id), agendaId });
      broadcast('moderation-new', { id: Number(r.rows[0].id) });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/import-delegates' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req, 5_000_000); const rows = Array.isArray(b.rows) ? b.rows : [];
      if (rows.length > 3000) return json(res, 400, { error: 'Maximum 3,000 rows per import.' });
      const client = await pool.connect(); let added = 0; let updated = 0; let skipped = 0;
      try {
        await client.query('BEGIN');
        for (const raw of rows) {
          const nric = normalizeNRIC(raw.nric || raw.NRIC || raw['NRIC Number'] || raw.ic || raw['IC Number']);
          const name = cleanText(raw.name || raw.Name, 250);
          if (!name || nric.length !== 12) { skipped++; continue; }
          const externalId = cleanText(raw.id || raw.ID, 100) || null;
          const nricHash = hmac(PARTICIPANT_SECRET, nric);
          const pinHash = hmac(PARTICIPANT_SECRET, nric.slice(-6));
          const params = [externalId, name, nricHash, pinHash, cleanText(raw.church || raw.Church, 250), cleanText(raw.district || raw.District, 120), cleanText(raw.role || raw['Conference Role'], 250), cleanText(raw.boards || raw['Board/Committee'], 1000), cleanText(raw.email || raw.Email, 250), cleanText(raw.phone || raw.Phone, 80), cleanText(raw.photo_url || raw['Photo URL'], 500)];
          const byNric = await client.query('SELECT id FROM delegates WHERE nric_hash=$1', [nricHash]);
          const byId = externalId ? await client.query('SELECT id FROM delegates WHERE external_id=$1', [externalId]) : { rows: [] };
          const existing = byNric.rows[0] || byId.rows[0];
          if (existing) {
            await client.query(`UPDATE delegates SET external_id=$1,name=$2,pin_hash=$4,church=$5,district=$6,conference_role=$7,boards=$8,email=$9,phone=$10,photo_url=$11,status='active',updated_at=NOW() WHERE id=$12`, [...params, existing.id]);
            updated++;
          } else {
            await client.query(`INSERT INTO delegates(external_id,name,nric_hash,pin_hash,church,district,conference_role,boards,email,phone,photo_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, params);
            added++;
          }
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      await audit(s, 'delegates.imported', { added, updated, skipped });
      broadcast('content-change', { type: 'delegates' });
      return json(res, 200, { ok: true, added, updated, skipped, total: (await q('SELECT COUNT(*)::int AS c FROM delegates')).rows[0].c });
    }

    if (p === '/api/admin/upload' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req, 30_000_000); const category = b.category === 'photos' ? 'photos' : 'documents';
      const filePath = await saveUploadedFile(b, category);
      if (category === 'photos') {
        const r = await q('INSERT INTO photos(name,path,caption) VALUES($1,$2,$3) RETURNING id', [cleanText(b.displayName || b.filename, 250), filePath, cleanText(b.caption, 500)]);
        await audit(s, 'photo.uploaded', { photoId: Number(r.rows[0].id) });
        broadcast('content-change', { type: 'photos' });
        return json(res, 200, { id: Number(r.rows[0].id), name: b.displayName || b.filename, path: filePath });
      }
      const related = b.relatedAgendaId ? Number(b.relatedAgendaId) : null;
      const r = await q('INSERT INTO documents(name,type,path,related_agenda_id) VALUES($1,$2,$3,$4) RETURNING id', [cleanText(b.displayName || b.filename, 250), cleanText(b.type, 80) || 'Resource', filePath, related]);
      await audit(s, 'document.uploaded', { documentId: Number(r.rows[0].id) });
      broadcast('content-change', { type: 'documents' });
      return json(res, 200, { id: Number(r.rows[0].id), name: b.displayName || b.filename, type: b.type || 'Resource', path: filePath });
    }

    if (p === '/api/admin/content' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const slug = cleanText(b.slug, 80).toLowerCase(); const title = cleanText(b.title, 200); const bodyText = cleanText(b.body, 10000);
      if (!slug || !title) return json(res, 400, { error: 'Page title and slug are required.' });
      await q(`INSERT INTO content_pages(slug,title,body,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,updated_at=NOW()`, [slug, title, bodyText]);
      await audit(s, 'content.updated', { slug });
      broadcast('content-change', { type: 'content', slug });
      return json(res, 200, { ok: true });
    }

    if (p === '/uploads/' || p.startsWith('/uploads/')) return serveUpload(req, res, p);

    if (p === '/' || p === '/index.html') return serveStatic(res, path.join(publicPath, 'index.html'));
    if (method === 'GET' && p === '/favicon.ico') return res.writeHead(204).end();
    return serveStatic(res, path.join(publicPath, p.slice(1)));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error' }); else res.end();
  }
});

(async () => {
  await initDb();
  server.listen(PORT, '0.0.0.0', () => console.log(`TRAC51 production server listening on ${PORT}`));
})();

process.on('SIGTERM', async () => { server.close(); await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { server.close(); await pool.end(); process.exit(0); });
