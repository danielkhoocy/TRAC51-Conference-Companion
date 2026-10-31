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
      presenter_delegate_id BIGINT REFERENCES delegates(id) ON DELETE SET NULL,
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
      current_version_id BIGINT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS document_versions (
      id BIGSERIAL PRIMARY KEY,
      document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version_no INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      path TEXT NOT NULL,
      file_size BIGINT NOT NULL DEFAULT 0,
      uploaded_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(document_id, version_no)
    );
    CREATE TABLE IF NOT EXISTS agenda_document_links (
      agenda_id BIGINT NOT NULL REFERENCES agenda(id) ON DELETE CASCADE,
      document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('content','report','supporting')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agenda_id, document_id, role)
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
  await q(`ALTER TABLE agenda ADD COLUMN IF NOT EXISTS presenter_delegate_id BIGINT REFERENCES delegates(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS current_version_id BIGINT`);
  await q(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await q(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await q(`CREATE INDEX IF NOT EXISTS idx_agenda_presenter ON agenda(presenter_delegate_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id, version_no DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_agenda_doc_links_agenda ON agenda_document_links(agenda_id, role)`);
  // Backfill legacy uploads into the versioned library model.
  const legacyDocs = await q(`SELECT id, name, path FROM documents WHERE path IS NOT NULL AND archived_at IS NULL AND current_version_id IS NULL`);
  for (const d of legacyDocs.rows) {
    const abs = path.join(DATA_ROOT, d.path.replace(/^\/uploads\//, 'uploads/'));
    try { const stat = await fs.promises.stat(abs); const mime = path.extname(abs).toLowerCase()==='.pdf' ? 'application/pdf' : 'application/octet-stream'; const v = await q(`INSERT INTO document_versions(document_id,version_no,original_name,mime_type,path,file_size,uploaded_by) VALUES($1,1,$2,$3,$4,$5,'migration') ON CONFLICT DO NOTHING RETURNING id`, [d.id,d.name,mime,d.path,stat.size]); if (v.rows[0]) await q('UPDATE documents SET current_version_id=$1, updated_at=NOW() WHERE id=$2', [v.rows[0].id,d.id]); } catch {}
  }

  // Promote legacy presenter text to a delegate-linked presenter where names match.
  await q(`UPDATE agenda a SET presenter_delegate_id=d.id
           FROM delegates d
           WHERE a.presenter_delegate_id IS NULL AND a.presenter IS NOT NULL AND trim(a.presenter)<>'' AND lower(trim(a.presenter))=lower(trim(d.name))`);
  // Migrate legacy agenda report/slides file paths into versioned Library documents and agenda links.
  const legacyAgendaFiles = await q(`SELECT id, report_name, report_path, slides_name, slides_path FROM agenda`);
  for (const a of legacyAgendaFiles.rows) {
    const pairs = [
      ['report', a.report_name, a.report_path, 'Conference Report'],
      ['content', a.slides_name, a.slides_path, 'Presentation']
    ];
    for (const [role, name, filePath, type] of pairs) {
      if (!filePath) continue;
      const linked = await q('SELECT 1 FROM agenda_document_links WHERE agenda_id=$1 AND role=$2 LIMIT 1', [a.id, role]);
      if (linked.rows[0]) continue;
      const existing = await q('SELECT id FROM documents WHERE path=$1 AND archived_at IS NULL LIMIT 1', [filePath]);
      let docId = existing.rows[0]?.id;
      if (!docId) {
        docId = (await q('INSERT INTO documents(name,type,path,related_agenda_id,updated_at) VALUES($1,$2,$3,$4,NOW()) RETURNING id', [name || filePath, type, filePath, a.id])).rows[0].id;
        const abs = path.join(DATA_ROOT, filePath.replace(/^\/uploads\//, 'uploads/'));
        try { const stat=await fs.promises.stat(abs); const mime=path.extname(abs).toLowerCase()==='.pdf'?'application/pdf':'application/octet-stream'; const v=(await q(`INSERT INTO document_versions(document_id,version_no,original_name,mime_type,path,file_size,uploaded_by) VALUES($1,1,$2,$3,$4,$5,'migration') RETURNING id`, [docId,name||path.basename(abs),mime,filePath,stat.size])).rows[0]; await q('UPDATE documents SET current_version_id=$1 WHERE id=$2',[v.id,docId]); } catch {}
      }
      await linkAgendaDocument(Number(a.id), Number(docId), role);
    }
  }
  // Existing legacy related_agenda_id values become supporting links unless a more specific role exists.
  const legacyRelations = await q(`SELECT id, related_agenda_id, type FROM documents WHERE related_agenda_id IS NOT NULL`);
  for (const d of legacyRelations.rows) {
    const role = /report/i.test(d.type) ? 'report' : /presentation|slides/i.test(d.type) ? 'content' : 'supporting';
    const specific = await q('SELECT 1 FROM agenda_document_links WHERE agenda_id=$1 AND document_id=$2 LIMIT 1', [d.related_agenda_id,d.id]);
    if (!specific.rows[0]) await linkAgendaDocument(Number(d.related_agenda_id), Number(d.id), role);
  }

  const state = await q('SELECT COUNT(*)::int AS c FROM agenda');
  if (state.rows[0].c === 0 && fs.existsSync(seedPath) && process.env.SEED_DEMO === 'true') {
    await seedDemo();
  }
  // Keep the synthetic test participant independent from whether agenda seed data already exists.
  // Turning SEED_DEMO off deactivates the synthetic account so it cannot be used in production.
  if (process.env.SEED_DEMO === 'true') {
    await ensureDemoDelegate();
  } else {
    await q("UPDATE delegates SET status='inactive', updated_at=NOW() WHERE external_id='DEMO-001'");
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

async function ensureDemoDelegate() {
  const nric = '900101145678';
  const delegate = {
    externalId: 'DEMO-001',
    name: 'Demo Delegate',
    nricHash: hmac(PARTICIPANT_SECRET || 'demo-secret', nric),
    pinHash: hmac(PARTICIPANT_SECRET || 'demo-secret', nric.slice(-6)),
  };
  await q(`INSERT INTO delegates(external_id,name,nric_hash,pin_hash,church,district,conference_role,boards,email,phone,photo_url,status,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',NOW())
    ON CONFLICT(external_id) DO UPDATE SET
      name=EXCLUDED.name, nric_hash=EXCLUDED.nric_hash, pin_hash=EXCLUDED.pin_hash,
      church=EXCLUDED.church, district=EXCLUDED.district, conference_role=EXCLUDED.conference_role,
      boards=EXCLUDED.boards, email=EXCLUDED.email, phone=EXCLUDED.phone, photo_url=EXCLUDED.photo_url,
      status='active', updated_at=NOW()`, [
    delegate.externalId, delegate.name, delegate.nricHash, delegate.pinHash,
    'Demo Methodist Church', 'Northern', 'Delegate', 'Board of Demonstration', '', '', ''
  ]);
  const d = await q("SELECT id FROM delegates WHERE external_id='DEMO-001' LIMIT 1");
  if (d.rows[0]) {
    const first = await q('SELECT id FROM agenda ORDER BY sort_order,id LIMIT 1');
    if (first.rows[0]) await q('UPDATE agenda SET presenter_delegate_id=$1,presenter=$2 WHERE id=$3', [d.rows[0].id, 'Demo Delegate', first.rows[0].id]);
  }
  console.log('Demo participant available: NRIC 900101145678 / PIN 145678');
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
    await client.query('COMMIT');
    console.log('Demo data seeded. Synthetic conference content created.');
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
    q(`SELECT a.id, a.time_text AS time, a.title, a.description AS desc, a.venue,
              a.presenter_delegate_id,
              COALESCE(pd.name, a.presenter) AS presenter,
              pd.email AS presenter_email, pd.phone AS presenter_phone, pd.photo_url AS presenter_photo_url,
              a.date_text AS date, a.status,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'id', d.id, 'name', d.name, 'type', d.type, 'path', d.path, 'role', l.role
              )) FILTER (WHERE d.id IS NOT NULL AND d.archived_at IS NULL), '[]'::json) AS linked_documents
       FROM agenda a
       LEFT JOIN delegates pd ON pd.id=a.presenter_delegate_id
       LEFT JOIN agenda_document_links l ON l.agenda_id=a.id
       LEFT JOIN documents d ON d.id=l.document_id
       GROUP BY a.id, pd.id
       ORDER BY a.sort_order, a.time_text, a.id`),
    q(`SELECT id, external_id, name, church, district, conference_role, boards, email, phone, photo_url FROM delegates WHERE status='active' ORDER BY name`),
    q(`SELECT id, type, title, body, image_path AS image, to_char(created_at, 'HH24:MI') AS time FROM feed WHERE published=true ORDER BY created_at DESC LIMIT 100`),
    q(`SELECT e.id, e.name, e.when_text AS "when", e.place, e.capacity, e.open,
        (e.capacity - COUNT(r.delegate_id))::int AS spots,
        EXISTS(SELECT 1 FROM event_registrations rr WHERE rr.event_id=e.id AND rr.delegate_id=$1) AS joined
        FROM events e LEFT JOIN event_registrations r ON r.event_id=e.id
        GROUP BY e.id ORDER BY e.created_at`, [delegateId]),
    q(`SELECT d.id, d.name, d.type, d.path, d.related_agenda_id AS related_agenda_id,
              d.current_version_id, COUNT(v.id)::int AS version_count
       FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id
       WHERE d.archived_at IS NULL
       GROUP BY d.id ORDER BY d.created_at DESC`),
    q('SELECT id, name, path, caption FROM photos ORDER BY created_at DESC'),
    q('SELECT slug, title, body FROM content_pages ORDER BY slug')
  ]);
  const viewerRow = delegates.rows.find(d => String(d.id) === String(delegateId));
  return {
    currentLive: state.rows[0]?.current_live_id ? Number(state.rows[0].current_live_id) : null,
    agenda: agenda.rows.map(a => ({ ...a, id: Number(a.id), presenter_profile: (a.presenter_email || a.presenter_phone || a.presenter_photo_url) ? { email: a.presenter_email || '', phone: a.presenter_phone || '', photo_url: a.presenter_photo_url || '' } : null, linked_documents: Array.isArray(a.linked_documents) ? a.linked_documents : [] })),
    delegates: delegates.rows.map(publicDelegate),
    viewer: viewerRow ? publicDelegate(viewerRow) : null,
    feed: feed.rows.map(f => ({ ...f, id: Number(f.id) })),
    events: events.rows.map(e => ({ ...e, id: Number(e.id), capacity: Number(e.capacity), spots: Number(e.spots), joined: !!e.joined })),
    docs: docs.rows.map(d => ({ ...d, id: Number(d.id), related_agenda_id: d.related_agenda_id ? Number(d.related_agenda_id) : null, version_count: Number(d.version_count || 0) })),
    photos: photos.rows.map(p => ({ ...p, id: Number(p.id) })),
    content: Object.fromEntries(content.rows.map(c => [c.slug, c])),
    settings: { title: 'TRAC51 Conference Companion' }
  };
}

async function getAdminBundle() {
  const pub = await getPublicBundle((await q("SELECT id FROM delegates WHERE status='active' ORDER BY id LIMIT 1")).rows[0]?.id || 0);
  const [moderation, help, stats, docs, versions] = await Promise.all([
    q(`SELECT m.id, m.text, m.kind, m.status, to_char(m.created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
              COALESCE(d.name,'Delegate') AS "from", a.title AS agenda_title
       FROM moderation m LEFT JOIN delegates d ON d.id=m.delegate_id LEFT JOIN agenda a ON a.id=m.agenda_id ORDER BY m.created_at DESC LIMIT 200`),
    q(`SELECT h.id, h.type, h.text, h.status, to_char(h.created_at, 'YYYY-MM-DD HH24:MI') AS "createdAt",
              COALESCE(d.name,'Delegate') AS "from"
       FROM help_requests h LEFT JOIN delegates d ON d.id=h.delegate_id ORDER BY h.created_at DESC LIMIT 200`),
    q(`SELECT
      (SELECT COUNT(*) FROM delegates WHERE status='active')::int AS delegates,
      (SELECT COUNT(*) FROM agenda)::int AS agenda,
      (SELECT COUNT(*) FROM events WHERE open=true)::int AS events,
      (SELECT COUNT(*) FROM documents WHERE archived_at IS NULL)::int AS docs,
      (SELECT COUNT(*) FROM moderation WHERE status='Pending')::int AS pending,
      (SELECT COUNT(*) FROM help_requests WHERE status='Open')::int AS open_help`),
    q(`SELECT d.id, d.name, d.type, d.path, d.related_agenda_id AS related_agenda_id, d.current_version_id, d.archived_at,
              a.title AS related_agenda_title, COUNT(v.id)::int AS version_count
       FROM documents d LEFT JOIN document_versions v ON v.document_id=d.id
       LEFT JOIN agenda a ON a.id=d.related_agenda_id
       GROUP BY d.id, a.title ORDER BY d.archived_at NULLS FIRST, d.created_at DESC`),
    q(`SELECT id, document_id, version_no, original_name, mime_type, path, file_size, uploaded_by,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM document_versions ORDER BY document_id, version_no DESC`)
  ]);
  pub.moderation = moderation.rows.map(m => ({ ...m, id: Number(m.id) }));
  pub.helpRequests = help.rows.map(h => ({ ...h, id: Number(h.id) }));
  pub.docsAdmin = docs.rows.map(d => ({ ...d, id: Number(d.id), related_agenda_id: d.related_agenda_id ? Number(d.related_agenda_id) : null, current_version_id: d.current_version_id ? Number(d.current_version_id) : null, version_count: Number(d.version_count || 0) }));
  pub.documentVersions = versions.rows.map(v => ({ ...v, id: Number(v.id), document_id: Number(v.document_id), version_no: Number(v.version_no), file_size: Number(v.file_size || 0) }));
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
  return { path: `/uploads/${filename}`, mimeType: mime, size: buf.length, originalName: safeFileName(input.filename) };
}

async function createDocumentVersion(documentId, uploaded, actorId) {
  const r = await q('SELECT COALESCE(MAX(version_no),0)::int AS max_no FROM document_versions WHERE document_id=$1', [documentId]);
  const versionNo = Number(r.rows[0].max_no || 0) + 1;
  const v = await q(`INSERT INTO document_versions(document_id,version_no,original_name,mime_type,path,file_size,uploaded_by)
                     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [documentId, versionNo, uploaded.originalName, uploaded.mimeType, uploaded.path, uploaded.size, actorId || null]);
  await q('UPDATE documents SET current_version_id=$1, path=$2, updated_at=NOW(), archived_at=NULL WHERE id=$3', [v.rows[0].id, uploaded.path, documentId]);
  return { id: Number(v.rows[0].id), versionNo };
}

async function linkAgendaDocument(agendaId, documentId, role) {
  if (!agendaId || !documentId || !['content','report','supporting'].includes(role)) return;
  await q(`INSERT INTO agenda_document_links(agenda_id,document_id,role) VALUES($1,$2,$3)
           ON CONFLICT (agenda_id,document_id,role) DO NOTHING`, [agendaId, documentId, role]);
  await q('UPDATE documents SET related_agenda_id=$1, updated_at=NOW() WHERE id=$2', [agendaId, documentId]);
}

async function replaceAgendaRoleLinks(agendaId, role, documentId) {
  await q('DELETE FROM agenda_document_links WHERE agenda_id=$1 AND role=$2', [agendaId, role]);
  if (documentId) await linkAgendaDocument(agendaId, documentId, role);
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

      // In demo/test mode, ensure the synthetic delegate exists before lookup.
      // This makes the test login reliable even if the service was deployed before
      // the SEED_DEMO variable was added or changed. It never runs when SEED_DEMO is false.
      if (process.env.SEED_DEMO === 'true' && nric === '900101145678' && pin === '145678') {
        await ensureDemoDelegate();
      }

      const row = await q(`SELECT id, external_id, name, church, district, conference_role, boards, email, phone, photo_url, nric_hash, pin_hash FROM delegates WHERE status='active' AND nric_hash=$1 LIMIT 1`, [hmac(PARTICIPANT_SECRET, nric)]);
      const d = row.rows[0];
      if (!d) return json(res, 401, { error: 'Delegate not found. Please check that your conference registration has been imported.' });
      if (!safeEqual(d.pin_hash, hmac(PARTICIPANT_SECRET, pin))) return json(res, 401, { error: 'Incorrect PIN. Please use the last 6 digits of your NRIC.' });
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
      const s = requireAdmin(req, res);
      if (!s) return;
      const b = await body(req);
      const fields = [cleanText(b.time, 100), cleanText(b.title, 250), cleanText(b.desc, 2000), cleanText(b.venue, 250), cleanText(b.date, 50) || '2026-11-22', cleanText(b.status, 50) || 'scheduled'];
      if (!fields[1]) return json(res, 400, { error: 'Agenda title is required' });
      let id;
      if (b.id) {
        id = Number(b.id);
        const presenterId = b.presenterDelegateId ? Number(b.presenterDelegateId) : null;
        const presenter = presenterId ? await q("SELECT name,email,phone,photo_url FROM delegates WHERE id=$1 AND status='active'", [presenterId]) : { rows: [] };
        if (presenterId && !presenter.rows[0]) return json(res, 400, { error: 'Presenter delegate not found.' });
        await q(`UPDATE agenda SET time_text=$1,title=$2,description=$3,venue=$4,date_text=$5,status=$6,presenter_delegate_id=$7,
                 presenter=$8,presenter_email=$9,presenter_phone=$10,updated_at=NOW() WHERE id=$11`, [
          ...fields, presenterId, presenter.rows[0]?.name || '', presenter.rows[0]?.email || '', presenter.rows[0]?.phone || '', id
        ]);
        await audit(s, 'agenda.updated', { agendaId: id });
      } else {
        const presenterId = b.presenterDelegateId ? Number(b.presenterDelegateId) : null;
        const presenter = presenterId ? await q("SELECT name,email,phone FROM delegates WHERE id=$1 AND status='active'", [presenterId]) : { rows: [] };
        const r = await q(`INSERT INTO agenda(sort_order,time_text,title,description,venue,date_text,status,presenter_delegate_id,presenter,presenter_email,presenter_phone)
                           VALUES((SELECT COALESCE(MAX(sort_order)+1,1) FROM agenda),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [
          ...fields, presenterId, presenter.rows[0]?.name || '', presenter.rows[0]?.email || '', presenter.rows[0]?.phone || ''
        ]);
        id = Number(r.rows[0].id);
        await audit(s, 'agenda.created', { agendaId: id });
      }
      await replaceAgendaRoleLinks(id, 'content', b.contentDocumentId ? Number(b.contentDocumentId) : null);
      await replaceAgendaRoleLinks(id, 'report', b.reportDocumentId ? Number(b.reportDocumentId) : null);
      broadcast('content-change', { type: 'agenda' });
      return json(res, 200, { ok: true, id });
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

    if (p === '/api/admin/documents/upload' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req, 30_000_000);
      const uploaded = await saveUploadedFile(b, 'documents');
      const name = cleanText(b.displayName || b.filename, 250); if (!name) return json(res, 400, { error: 'Document name is required.' });
      const type = cleanText(b.documentType || b.type, 80) || 'Other';
      const r = await q('INSERT INTO documents(name,type,path,related_agenda_id,updated_at) VALUES($1,$2,$3,$4,NOW()) RETURNING id', [name,type,uploaded.path,b.relatedAgendaId ? Number(b.relatedAgendaId) : null]);
      const id = Number(r.rows[0].id);
      const v = await createDocumentVersion(id, uploaded, s.actorId);
      if (b.relatedAgendaId && b.role) await linkAgendaDocument(Number(b.relatedAgendaId), id, b.role);
      await audit(s, 'document.created', { documentId:id, versionNo:v.versionNo, agendaId:b.relatedAgendaId ? Number(b.relatedAgendaId) : null, role:b.role || null });
      broadcast('content-change', { type: 'documents' });
      return json(res, 200, { ok:true, id, path:uploaded.path, versionNo:v.versionNo });
    }

    if (p === '/api/admin/documents/replace' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req, 30_000_000); const id = Number(b.documentId); if (!id) return json(res,400,{error:'Document is required.'});
      const exists = await q('SELECT id FROM documents WHERE id=$1', [id]); if (!exists.rows[0]) return json(res,404,{error:'Document not found.'});
      const uploaded = await saveUploadedFile(b, 'documents');
      const v = await createDocumentVersion(id, uploaded, s.actorId);
      await q('UPDATE documents SET name=$1,type=$2,updated_at=NOW(),archived_at=NULL WHERE id=$3', [cleanText(b.displayName || b.filename,250), cleanText(b.documentType || b.type,80) || 'Other', id]);
      await audit(s, 'document.replaced', { documentId:id, versionNo:v.versionNo });
      broadcast('content-change', { type: 'documents' });
      return json(res,200,{ok:true,id,versionNo:v.versionNo,path:uploaded.path});
    }

    if (p === '/api/admin/documents/link' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req); const agendaId=Number(b.agendaId), documentId=Number(b.documentId); const role=b.role;
      if (!agendaId || !documentId || !['content','report','supporting'].includes(role)) return json(res,400,{error:'Agenda, document and role are required.'});
      await linkAgendaDocument(agendaId, documentId, role); if (role==='content' || role==='report') await replaceAgendaRoleLinks(agendaId, role, documentId);
      await audit(s,'document.linked',{agendaId,documentId,role}); broadcast('content-change',{type:'agenda'}); return json(res,200,{ok:true});
    }

    if (p === '/api/admin/documents/unlink' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return; const b=await body(req); const agendaId=Number(b.agendaId), documentId=Number(b.documentId), role=cleanText(b.role,30); if(!agendaId||!documentId)return json(res,400,{error:'Agenda and document are required.'});
      await q(`DELETE FROM agenda_document_links WHERE agenda_id=$1 AND document_id=$2 ${role?'AND role=$3':''}`, role?[agendaId,documentId,role]:[agendaId,documentId]); await audit(s,'document.unlinked',{agendaId,documentId,role:role||null}); broadcast('content-change',{type:'agenda'}); return json(res,200,{ok:true});
    }

    if (p === '/api/admin/documents/restore' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return; const b=await body(req); const documentId=Number(b.documentId), versionId=Number(b.versionId); const v=await q('SELECT id,document_id,path,original_name FROM document_versions WHERE id=$1 AND document_id=$2',[versionId,documentId]); if(!v.rows[0])return json(res,404,{error:'Version not found.'});
      await q('UPDATE documents SET current_version_id=$1,path=$2,name=$3,archived_at=NULL,updated_at=NOW() WHERE id=$4',[versionId,v.rows[0].path,v.rows[0].original_name,documentId]); await audit(s,'document.version_restored',{documentId,versionId}); broadcast('content-change',{type:'documents'}); return json(res,200,{ok:true});
    }

    if (p === '/api/admin/documents/archive' && method === 'POST') {
      const s=requireAdmin(req,res); if(!s)return; const b=await body(req); const id=Number(b.documentId); await q('UPDATE documents SET archived_at=NOW(),updated_at=NOW() WHERE id=$1',[id]); await audit(s,'document.archived',{documentId:id}); broadcast('content-change',{type:'documents'}); return json(res,200,{ok:true});
    }

    if (p === '/api/admin/documents/delete' && method === 'POST') {
      const s=requireAdmin(req,res); if(!s)return; const b=await body(req); const id=Number(b.documentId); const versions=await q('SELECT path FROM document_versions WHERE document_id=$1',[id]); await q('DELETE FROM documents WHERE id=$1',[id]); for(const v of versions.rows){try{await fs.promises.unlink(path.join(DATA_ROOT,v.path.replace(/^\/uploads\//,'uploads/')))}catch{}} await audit(s,'document.deleted',{documentId:id}); broadcast('content-change',{type:'documents'}); return json(res,200,{ok:true});
    }

    if (p === '/api/admin/upload' && method === 'POST') {
      const s = requireAdmin(req, res); if (!s) return;
      const b = await body(req, 30_000_000); const category = b.category === 'photos' ? 'photos' : 'documents';
      const uploaded = await saveUploadedFile(b, category);
      const filePath = uploaded.path;
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
