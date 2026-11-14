import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { readFileSync } from 'node:fs';

pg.types.setTypeParser(20, value => Number(value));
const connectionString = process.env.DATABASE_URL;
let sqlite;
let pool;
if (connectionString) {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  pool = new pg.Pool({ connectionString: url.toString(), ssl: { ca: readFileSync(new URL('./supabase/ca.pem', import.meta.url), 'utf8'), rejectUnauthorized: true }, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
} else {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) throw new Error('DATABASE_URL must be configured for production');
  sqlite = new DatabaseSync(process.env.DB_PATH || 'wordthing.sqlite');
  sqlite.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, banned TEXT NOT NULL DEFAULT '[]', created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, topic TEXT NOT NULL, mode TEXT NOT NULL, word_limit INTEGER, status TEXT NOT NULL DEFAULT 'open', revealed INTEGER NOT NULL DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS participants(id INTEGER PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, affiliation TEXT NOT NULL, name TEXT NOT NULL, nickname TEXT NOT NULL, nickname_key TEXT NOT NULL, salt TEXT NOT NULL, pin_hash TEXT NOT NULL, banned INTEGER NOT NULL DEFAULT 0, UNIQUE(room_id,nickname_key));
CREATE TABLE IF NOT EXISTS activity_participants(activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE, participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE, PRIMARY KEY(activity_id,participant_id));
CREATE TABLE IF NOT EXISTS words(id INTEGER PRIMARY KEY, activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE, participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE, word TEXT NOT NULL, word_key TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(activity_id,participant_id,word_key));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, role TEXT NOT NULL, participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence(session_token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(subject TEXT NOT NULL, bucket INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(subject,bucket));
`);
}
function pgSql(sql) {
  let i=0;
  return sql.replace(/\b(FROM|JOIN|UPDATE|INTO)\s+(rooms|activities|participants|activity_participants|words|sessions|login_attempts|presence)\b/gi, '$1 wordthing.$2')
    .replace(/\?/g, () => `$${++i}`)
    .replace(/^INSERT OR IGNORE INTO/i, 'INSERT INTO')
    .replace(/^(INSERT INTO wordthing\.activity_participants VALUES\([^)]*\))$/i, '$1 ON CONFLICT DO NOTHING');
}
export async function get(sql,...params) { if (sqlite) return sqlite.prepare(sql).get(...params); return (await pool.query(pgSql(sql),params)).rows[0]; }
export async function all(sql,...params) { if (sqlite) return sqlite.prepare(sql).all(...params); return (await pool.query(pgSql(sql),params)).rows; }
export async function run(sql,...params) {
  if(sqlite) return sqlite.prepare(sql).run(...params);
  let query=pgSql(sql);
  if(/^INSERT INTO wordthing\.(activities|participants)\b/i.test(query)) query+=' RETURNING id';
  const result=await pool.query(query,params);
  return { changes:result.rowCount, lastInsertRowid:result.rows[0]?.id };
}
// Presence is a rolling lease, distinct from the number of registered people.
// PostgreSQL's transaction advisory lock serializes admission across all Vercel instances.
export async function claimPresence(sessionToken) {
  const now=Date.now(), expires=now+90000;
  if (sqlite) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.prepare('DELETE FROM presence WHERE expires_at<?').run(now);
      const existing=sqlite.prepare('SELECT session_token FROM presence WHERE session_token=?').get(sessionToken);
      if(!existing && sqlite.prepare('SELECT count(*) n FROM presence').get().n>=200){sqlite.exec('ROLLBACK');return false;}
      sqlite.prepare('INSERT INTO presence(session_token,expires_at) VALUES(?,?) ON CONFLICT(session_token) DO UPDATE SET expires_at=excluded.expires_at').run(sessionToken,expires);
      sqlite.exec('COMMIT');return true;
    } catch(e) {sqlite.exec('ROLLBACK');throw e;}
  }
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)',[13478922]);
    await client.query('DELETE FROM wordthing.presence WHERE expires_at<$1',[now]);
    const existing=await client.query('SELECT session_token FROM wordthing.presence WHERE session_token=$1',[sessionToken]);
    if(!existing.rowCount){const result=await client.query('SELECT count(*)::integer n FROM wordthing.presence');if(result.rows[0].n>=200){await client.query('ROLLBACK');return false;}}
    await client.query('INSERT INTO wordthing.presence(session_token,expires_at) VALUES($1,$2) ON CONFLICT(session_token) DO UPDATE SET expires_at=excluded.expires_at',[sessionToken,expires]);
    await client.query('COMMIT');return true;
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}
export async function releasePresence(sessionToken){if(sqlite){sqlite.prepare('DELETE FROM presence WHERE session_token=?').run(sessionToken);return;}await pool.query('DELETE FROM wordthing.presence WHERE session_token=$1',[sessionToken]);}

// Serializes each participant's checks and insertion so simultaneous submissions
// cannot bypass per-activity limits, duplication, or a newly blocked word.
export async function submitWord(roomId,participantId,word,normalized) {
  const normalize=s=>s.normalize('NFKC').replace(/\s+/gu,'').toLocaleLowerCase('ko');
  if (!normalized) throw [400,'단어를 입력해 주세요.'];
  if (sqlite) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const room=sqlite.prepare('SELECT banned FROM rooms WHERE id=?').get(roomId);
      const participant=sqlite.prepare('SELECT banned FROM participants WHERE id=? AND room_id=?').get(participantId,roomId);
      const activity=sqlite.prepare('SELECT * FROM activities WHERE room_id=? ORDER BY id DESC LIMIT 1').get(roomId);
      if(!participant||participant.banned)throw [401,'참가자 로그인이 필요합니다.'];
      if(!activity||activity.status!=='open')throw [400,'현재 단어 입력이 중지되어 있습니다.'];
      if(JSON.parse(room.banned).some(term=>normalized.includes(normalize(term))))throw [400,'사용이 제한된 단어가 포함되어 있습니다.'];
      if(activity.word_limit && sqlite.prepare('SELECT count(*) n FROM words WHERE activity_id=? AND participant_id=?').get(activity.id,participantId).n>=activity.word_limit)throw [400,'등록 가능 개수에 도달했습니다.'];
      if(sqlite.prepare('SELECT id FROM words WHERE activity_id=? AND participant_id=? AND word_key=?').get(activity.id,participantId,normalized))throw [409,'이미 등록한 단어입니다.'];
      sqlite.prepare('INSERT INTO words(activity_id,participant_id,word,word_key) VALUES(?,?,?,?)').run(activity.id,participantId,word,normalized);
      sqlite.exec('COMMIT');return;
    }catch(e){sqlite.exec('ROLLBACK');throw e;}
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const room=(await client.query('SELECT banned FROM wordthing.rooms WHERE id=$1 FOR UPDATE',[roomId])).rows[0];
    const participant=(await client.query('SELECT banned FROM wordthing.participants WHERE id=$1 AND room_id=$2 FOR UPDATE',[participantId,roomId])).rows[0];
    const activity=(await client.query('SELECT * FROM wordthing.activities WHERE room_id=$1 ORDER BY id DESC LIMIT 1 FOR UPDATE',[roomId])).rows[0];
    if(!room||!participant||participant.banned)throw [401,'참가자 로그인이 필요합니다.'];
    if(!activity||activity.status!=='open')throw [400,'현재 단어 입력이 중지되어 있습니다.'];
    if(JSON.parse(room.banned).some(term=>normalized.includes(normalize(term))))throw [400,'사용이 제한된 단어가 포함되어 있습니다.'];
    if(activity.word_limit){const n=(await client.query('SELECT count(*)::integer n FROM wordthing.words WHERE activity_id=$1 AND participant_id=$2',[activity.id,participantId])).rows[0].n;if(n>=activity.word_limit)throw [400,'등록 가능 개수에 도달했습니다.'];}
    const duplicate=await client.query('SELECT id FROM wordthing.words WHERE activity_id=$1 AND participant_id=$2 AND word_key=$3',[activity.id,participantId,normalized]);
    if(duplicate.rowCount)throw [409,'이미 등록한 단어입니다.'];
    await client.query('INSERT INTO wordthing.words(activity_id,participant_id,word,word_key) VALUES($1,$2,$3,$4)',[activity.id,participantId,word,normalized]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
