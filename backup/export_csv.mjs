// Readable CSV copies of a database dump, written by backup.ps1 after each daily dump.
//   node --no-warnings backup/export_csv.mjs [dump.sql]
// Without an argument it reads the newest dump in ..\backups\group-signup. The files go to
// ..\backups\group-signup\csv\ and replace the previous set; to see an older day, run it on that day's dump.
// The files reuse the tool's own functions (worker/src/rules.js), and their columns equal the instructor
// page's downloads. The attendance tool has its own repository and backup since 2026-10-05; the old
// attendance tables still in this database are left out.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgrade } from '../worker/src/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const store = join(here, '..', '..', 'backups', 'group-signup');
const dump = process.argv[2] || join(store, readdirSync(store).filter(f => /^group-signup_.*\.sql$/.test(f)).sort().pop());
const out = join(store, 'csv');

const db = new DatabaseSync(':memory:');
db.exec(readFileSync(dump, 'utf8'));
const all = (sql, ...a) => db.prepare(sql).all(...a);

const TZ = 'America/New_York';
const isoFull = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
const fullName = r => (r.first + ' ' + r.last).trim();
const safe = k => String(k).replace(/[^A-Za-z0-9_.-]/g, '_');

let files = 0;
function write(name, rows) {
  const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  writeFileSync(join(out, name), '﻿' + csv + '\r\n');  // the byte-order mark makes Excel read the names as UTF-8
  files++;
}
function logRows(cls) {
  return [['Time (New York)', 'Time (ISO)', 'Account', 'Action', 'Detail']].concat(
    all('SELECT time, actor, action, detail FROM log WHERE class = ? ORDER BY time, id', cls).map(r => [isoFull(r.time), r.time, r.actor, r.action, r.detail]));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const row of all('SELECT key, state FROM classes ORDER BY key')) {
  const k = row.key, C = upgrade(JSON.parse(row.state));
  const membersOf = name => C.roster.filter(r => r.group === name);
  const claimBy = (g, f) => g[f] === '' ? '' : (g[f + 'By'] === 'instructor' ? 'instructor' : 'group');
  // Groups (as the instructor page's "Download groups").
  write('signup_' + safe(k) + '_groups.csv', [['Group', 'Leader', 'Members', 'Member emails', 'Dataset code', 'Dataset', 'Own dataset link', 'Dataset set by', 'Topic code', 'Topic', 'Topic set by']]
    .concat(C.groups.map(g => {
      const ms = membersOf(g.name), d = C.datasets.find(x => x.code === g.dataset), t = C.topics.find(x => x.code === g.topic);
      const lead = ms.find(r => r.email === g.leader);
      return [g.name, lead ? fullName(lead) : g.leader, ms.map(fullName).join('; '), ms.map(r => r.email).join('; '),
        g.dataset, d ? d.name : '', g.ownLink, claimBy(g, 'dataset'), g.topic, t ? t.topic : '', claimBy(g, 'topic')];
    })));
  write('signup_' + safe(k) + '_roster.csv', [['Last name', 'First name', 'Email', 'Group', 'Joined (New York)']]
    .concat(C.roster.map(r => [r.last, r.first, r.email, r.group || '', r.joinedAt ? isoFull(r.joinedAt) : ''])));
  write('signup_' + safe(k) + '_log.csv', logRows(k));
}

writeFileSync(join(out, 'README.txt'),
  'Readable copies of the database dump ' + basename(dump) + ', written ' + new Date().toISOString() + '.\r\n' +
  'They are replaced at every daily backup. For an older day, run from the group-signup folder:\r\n' +
  '  node --no-warnings backup/export_csv.mjs "<path of that day\'s .sql file>"\r\n' +
  'signup_<class>_groups: the groups and their claims; roster: each student\'s group; log: every action, oldest first.\r\n' +
  'The attendance tool has its own backup (backups\\attendance) since 2026-10-05.\r\n');
console.log('Wrote ' + files + ' CSV files from ' + basename(dump) + ' to ' + out);
