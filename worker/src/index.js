/**
 * Group, dataset, and topic sign-up tool: backend (Cloudflare Worker + D1).
 * The pages in docs/ (GitHub Pages) call it. See README.md.
 *
 *   GET  /config  -> {clientId, classes}        public, needed before sign-in
 *   POST /        -> student page: {token, class, action, args, viewAs, note}
 *   POST /admin   -> instructor page: {token, class, action, args}
 *
 * The attendance tool, served here until 2026-10-05, is its own repository and Worker since
 * (RabbaniMaysam/attendance). Its old tables (att_classes, att_marks, att_answers) and its log rows
 * (class 'att:' + key) remain in this database, unused.
 *
 * Each class is one row of the classes table holding its state as JSON (see
 * rules.js). A change is written only if the row's version is the one that was
 * read, so two simultaneous claims of the same item cannot both succeed: the
 * second is recomputed against the first one's result and refused.
 */

import { act, view, adminAct, isAdminAction, newClass, upgrade, canonEmail } from './rules.js';
import { SEED_DATASETS, SEED_TOPICS } from './seed.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = o => new Response(JSON.stringify(o), {
  headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)
});

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (request.method === 'GET' && path === '/config') {
        return json({ clientId: env.GOOGLE_CLIENT_ID || '', classes: await classList(env) });
      }
      // The pages poll this cheap call and reload the state only when the number changed.
      if (request.method === 'GET' && path === '/version') {
        const key = new URL(request.url).searchParams.get('c') || '';
        const row = await env.DB.prepare('SELECT version FROM classes WHERE key = ?').bind(key).first();
        return json({ version: row ? row.version : -1 });
      }
      if (request.method === 'POST' && (path === '/' || path === '/admin')) {
        const body = await request.text();
        if (body.length > 1000000) throw new Error('The request is too large.');
        const req = JSON.parse(body);
        const who = await verify(req.token, env);
        const real = who.email;
        const admin = isAdmin(real, env);
        const args = Array.isArray(req.args) ? req.args.slice(0, 8) : [];
        const key = String(req.class || '');
        const action = String(req.action);
        // After a Google sign-in the answer carries a session token of this tool, which the page keeps
        // for the following visits (Google's own token lasts an hour and the page cannot renew it silently).
        const session = who.google ? await sessionToken(real, env) : '';
        let out;
        if (path === '/admin') {
          if (!admin) throw new Error('The account ' + real + ' is not an instructor account.');
          out = { ok: true, data: await adminCall(env, real, action, key, args) };
        } else out = { ok: true, state: await studentCall(env, real, admin, req, args) };
        if (session) out.session = session;
        return json(out);
      }
      return json({ ok: false, error: 'Not found.' });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) });
    }
  }
};

// ---------------------------------------------------------------- sign-in

let certs = null, certsAt = 0;

async function googleKeys(env, refresh) {
  const age = Date.now() - certsAt;
  if (!certs || age > 3600000 || (refresh && age > 60000)) {
    const r = await fetch(env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw new Error('SIGNIN');
    certs = (await r.json()).keys;
    certsAt = Date.now();
  }
  return certs;
}

const bytes = b64url => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const parse = b64url => JSON.parse(new TextDecoder().decode(bytes(b64url)));

/**
 * Returns {email, google} for a sign-in token: either a session token of this tool (see
 * sessionToken) or a Google sign-in token, whose Google signature, client ID (this tool's),
 * and expiry are checked. The error text SIGNIN instructs the page to show the sign-in button again.
 */
async function verify(token, env) {
  try {
    const parts = String(token || '').split('.');
    if (parts[0] === 's1') return { email: await verifySession(parts, env), google: false };
    if (parts.length !== 3 || !env.GOOGLE_CLIENT_ID) throw 0;
    const head = parse(parts[0]), p = parse(parts[1]);
    if (head.alg !== 'RS256') throw 0;
    let jwk = (await googleKeys(env, false)).find(k => k.kid === head.kid);
    if (!jwk) jwk = (await googleKeys(env, true)).find(k => k.kid === head.kid);
    if (!jwk) throw 0;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1]));
    const issuer = p.iss === 'accounts.google.com' || p.iss === 'https://accounts.google.com';
    const verified = p.email_verified === true || p.email_verified === 'true';
    if (!signed || !issuer || p.aud !== env.GOOGLE_CLIENT_ID || !verified || !(Number(p.exp) * 1000 > Date.now())) throw 0;
    const email = canonEmail(p.email);
    if (!email) throw 0;
    return { email: email, google: true };
  } catch (e) {
    throw new Error('SIGNIN');
  }
}

/**
 * Session tokens: 's1.' + base64url({e: email, x: expiry ms}) + '.' + base64url(HMAC-SHA256 of that
 * payload with the SESSION_SECRET secret). Issued after a Google sign-in, valid SESSION_DAYS days,
 * kept by the page in the browser's storage, so a student signs in with Google once a semester and
 * the instructor stays signed in on their own computer. Without the secret no token is issued.
 * Signing out deletes the token from the browser; the token cannot be revoked server-side
 * (change the secret to invalidate every session).
 */
const SESSION_DAYS = 180;
const toB64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sessionKey(env) {
  if (!env.SESSION_SECRET) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sessionToken(email, env) {
  const key = await sessionKey(env);
  if (!key) return '';
  const payload = toB64url(new TextEncoder().encode(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 })));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return 's1.' + payload + '.' + toB64url(sig);
}

async function verifySession(parts, env) {
  const key = await sessionKey(env);
  if (!key || parts.length !== 3) throw 0;
  const good = await crypto.subtle.verify('HMAC', key, bytes(parts[2]), new TextEncoder().encode(parts[1]));
  const p = parse(parts[1]);
  const email = canonEmail(p.e);
  if (!good || !email || !(Number(p.x) > Date.now())) throw 0;
  return email;
}

/** Instructors are the emails in the ADMIN_EMAILS secret. */
function isAdmin(email, env) {
  return !!email && String(env.ADMIN_EMAILS || '').toLowerCase().split(/[,;\s]+/).indexOf(email) !== -1;
}

// ---------------------------------------------------------------- storage

async function classList(env) {
  const out = await env.DB.prepare(
    "SELECT key, json_extract(state, '$.settings.title') AS title FROM classes ORDER BY key").all();
  return out.results;
}

async function readClass(env, key) {
  const row = await env.DB.prepare('SELECT version, state FROM classes WHERE key = ?').bind(key).first();
  if (!row) throw new Error('This link does not match any class.');
  return { version: row.version, state: upgrade(JSON.parse(row.state)), raw: row.state };
}

const LOG_SQL = 'INSERT INTO log (time, class, actor, action, detail) ';

function logNow(env, key, actor, action, detail) {
  return env.DB.prepare(LOG_SQL + 'VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), key, actor, action, String(detail).slice(0, 2000)).run();
}

/**
 * Reads the class, applies fn (which changes the state in place and returns
 * log lines), and writes the result with its log lines in one transaction,
 * provided nobody else wrote in between. Otherwise it starts over on the
 * newer state. A refusal by fn is logged and passed on.
 */
async function mutate(env, key, who, action, args, fn) {
  for (let attempt = 0; attempt < 60; attempt++) {
    // Each round of simultaneous writers has one winner; the others wait briefly and recompute.
    if (attempt) await new Promise(r => setTimeout(r, Math.random() * Math.min(attempt, 10) * 15));
    const row = await readClass(env, key);
    let logs;
    try {
      logs = fn(row.state);
    } catch (err) {
      // Refused attempts are logged too, so the log shows what was tried and why it failed.
      const shown = args.map(a => (typeof a === 'string' ? a.slice(0, 200) : JSON.stringify(a).slice(0, 200)));
      await logNow(env, key, who, 'refused: ' + action, shown.join(', ') + (shown.length ? ' | ' : '') + err.message);
      throw err;
    }
    if (!logs.length) return { state: row.state, version: row.version };  // nothing changed
    const stamp = crypto.randomUUID();
    const time = new Date().toISOString();
    const guard = ' WHERE EXISTS (SELECT 1 FROM classes WHERE key = ? AND stamp = ?)';
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE classes SET state = ?, version = version + 1, stamp = ? WHERE key = ? AND version = ?')
        .bind(JSON.stringify(row.state), stamp, key, row.version),
      // The state as it was before this change, for the History tab of the instructor page.
      env.DB.prepare('INSERT INTO snapshots (time, class, actor, action, detail, state) SELECT ?, ?, ?, ?, ?, ?' + guard)
        .bind(time, key, logs[0].actor, action.replace(/([A-Z])/g, c => ' ' + c.toLowerCase()),
              logs.map(l => l.detail).join('; ').slice(0, 2000), row.raw, key, stamp)
    ].concat(logs.map(l =>
      env.DB.prepare(LOG_SQL + 'SELECT ?, ?, ?, ?, ?' + guard)
        .bind(time, key, l.actor, l.action, String(l.detail).slice(0, 2000), key, stamp))));
    if (res[0].meta.changes === 1) return { state: row.state, version: row.version + 1 };
  }
  throw new Error('The page is busy. Try again in a few seconds.');
}

// ---------------------------------------------------------------- student page

async function studentCall(env, real, admin, req, args) {
  const key = String(req.class || '');
  const viewAs = String(req.viewAs || '').trim().toLowerCase();
  const action = String(req.action);
  if (action === 'state') {
    const row = await readClass(env, key);
    const v = view(row.state, real, viewAs, admin, Date.now());
    if (req.note === 'sign in' || req.note === 'open page') {
      await logNow(env, key, real, req.note, v.authorized ? (v.me || viewAs ? '' : 'instructor') : 'not on the class roster');
    }
    v.version = row.version;
    return v;
  }
  const who = real + (admin && viewAs ? ' (as ' + viewAs + ')' : '');
  const row = await mutate(env, key, who, action, args, s => act(s, real, action, args, viewAs, admin, Date.now()));
  const v = view(row.state, real, viewAs, admin, Date.now());
  v.version = row.version;
  return v;
}

// ---------------------------------------------------------------- instructor page

async function adminCall(env, real, action, key, args) {
  const who = real + ' (instructor)';
  if (action === 'whoami') return { email: real, classes: await classList(env) };

  if (action === 'createClass') {
    const newKey = String(args[0] || '').trim().toLowerCase();
    const title = String(args[1] || '').trim();
    if (!/^[a-z0-9-]{2,30}$/.test(newKey)) throw new Error('The class key must be 2 to 30 lowercase letters, digits, or hyphens.');
    if (!title) throw new Error('The class needs a title.');
    const state = newClass(title, SEED_DATASETS, SEED_TOPICS);
    if (args[2]) {
      const from = (await readClass(env, String(args[2]))).state;
      state.datasets = from.datasets;
      state.topics = from.topics;
      state.settings = Object.assign({}, from.settings, { title: title, deadline: '' });
    }
    const res = await env.DB.prepare('INSERT OR IGNORE INTO classes (key, state) VALUES (?, ?)')
      .bind(newKey, JSON.stringify(state)).run();
    if (res.meta.changes !== 1) throw new Error('A class with the key "' + newKey + '" exists.');
    await logNow(env, newKey, who, 'create class', title + (args[2] ? ' (catalogs copied from ' + args[2] + ')' : ''));
    return { key: newKey, classes: await classList(env) };
  }

  if (action === 'deleteClass') {
    if (String(args[0]) !== key) throw new Error('Type the class key exactly to delete the class.');
    await readClass(env, key);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM classes WHERE key = ?').bind(key),
      env.DB.prepare('DELETE FROM log WHERE class = ?').bind(key),
      env.DB.prepare('DELETE FROM snapshots WHERE class = ?').bind(key)
    ]);
    return { classes: await classList(env) };
  }

  if (action === 'get') return await readClass(env, key);

  // Every change saved a snapshot of the state before it. Newest first.
  if (action === 'snapshots') {
    const limit = Math.min(Math.max(Number(args[0]) || 300, 1), 5000);
    const out = await env.DB.prepare(
      'SELECT id, time, actor, action, detail FROM snapshots WHERE class = ? ORDER BY id DESC LIMIT ?').bind(key, limit).all();
    return { rows: out.results };
  }

  // Puts the class back to the state saved in one snapshot. The current state is snapshotted first, so a restore can itself be undone.
  if (action === 'restore') {
    const snap = await env.DB.prepare('SELECT id, time, actor, action, detail, state FROM snapshots WHERE class = ? AND id = ?')
      .bind(key, Number(args[0])).first();
    if (!snap) throw new Error('That snapshot does not exist.');
    const old = upgrade(JSON.parse(snap.state));
    return await mutate(env, key, who, action, [snap.id], s => {
      Object.keys(s).forEach(k => delete s[k]);
      Object.assign(s, old);
      return [{ actor: who, action: 'restore', detail: 'state as of ' + snap.time + ', before "' + snap.action + '" by ' + snap.actor + ' (snapshot ' + snap.id + ')' }];
    });
  }

  if (action === 'log') {
    const like = '%' + String(args[0] || '').replace(/[%_]/g, '') + '%';
    const limit = Math.min(Math.max(Number(args[1]) || 300, 1), 20000);
    const out = await env.DB.prepare(
      'SELECT id, time, actor, action, detail FROM log WHERE class = ? AND (actor LIKE ? OR action LIKE ? OR detail LIKE ?) ' +
      'ORDER BY id DESC LIMIT ?').bind(key, like, like, like, limit).all();
    return { rows: out.results };
  }

  if (!isAdminAction(action)) throw new Error('Unknown action.');
  return await mutate(env, key, who, action, action === 'importRoster' ? ['(file)'] : args,
    s => adminAct(s, real, action, args, Date.now()));
}
