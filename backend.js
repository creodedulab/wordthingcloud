import { get, all, run, claimPresence, releasePresence, submitWord } from './database.js';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const key = s => s.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('ko');
const clean = (s, max = 80) => String(s ?? '').trim().slice(0, max);
const hash = (pin, salt) => scryptSync(pin, salt, 32).toString('hex');
const token = () => randomBytes(32).toString('hex');
const adminPassword = process.env.ADMIN_PASSWORD || ((process.env.NODE_ENV === 'production' || process.env.VERCEL) ? '' : 'tting');
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || '';
function verifyAdminPassword(input) {
  if (adminPasswordHash) {
    const [method, salt, expected] = adminPasswordHash.split(':');
    if (method !== 'scrypt' || !/^[a-f0-9]{32}$/i.test(salt||'') || !/^[a-f0-9]{64}$/i.test(expected||'')) return false;
    const actual=scryptSync(input, Buffer.from(salt, 'hex'), 32), target=Buffer.from(expected,'hex');
    return timingSafeEqual(actual,target);
  }
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) return false;
  const actual=Buffer.from(input), target=Buffer.from(adminPassword);
  return actual.length===target.length && timingSafeEqual(actual,target);
}
const sessionDigest = t => createHash('sha256').update(t).digest('hex');
async function throttle(req, scope, limit, identityOnly=false) {
  const address=String(req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0];
  const subject=createHash('sha256').update(scope + ':' + (identityOnly ? '' : address)).digest('hex');
  const bucket=Math.floor(Date.now()/60000);
  const item=await get('INSERT INTO login_attempts(subject,bucket,attempts) VALUES(?,?,1) ON CONFLICT(subject,bucket) DO UPDATE SET attempts=login_attempts.attempts+1 RETURNING attempts',subject,bucket);
  if (item.attempts > limit) throw [429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'];
  if (Math.random()<0.01) await run('DELETE FROM login_attempts WHERE bucket<?',bucket-10);
}
async function session(req) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('wt_session='))?.slice(11);
  if (!raw) return null;
  const t=sessionDigest(raw);
  const s = await get('SELECT * FROM sessions WHERE token=? AND created>?', t, Date.now() - 7 * 86400000);
  if (s?.participant_id) {
    const p = await get('SELECT * FROM participants WHERE id=?', s.participant_id);
    if (!p || p.banned) return null;
    if (!(await claimPresence(t))) throw [429, '현재 동시 접속 인원이 가득 찼습니다. 잠시 후 다시 시도해 주세요.'];
    s.participant = p;
  }
  return s;
}
function requireAdmin(s) {
  if (s?.role !== 'admin') throw [401, '관리자 로그인이 필요합니다.'];
}
function requireParticipant(s, room) {
  if (s?.role !== 'participant' || s.participant.room_id !== room.id) throw [401, '참가자 로그인이 필요합니다.'];
}
function cookie(res, t) {
  res.setHeader('Set-Cookie', `wt_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
async function makeSession(role, id, res) {
  const t = token();
  const digest=sessionDigest(t);
  await run('INSERT INTO sessions VALUES(?,?,?,?)', digest, role, id, Date.now());
  if(role==='participant' && !(await claimPresence(digest))){await run('DELETE FROM sessions WHERE token=?',digest);throw [429,'현재 동시 접속 인원이 가득 찼습니다. 잠시 후 다시 시도해 주세요.'];}
  cookie(res, t);
}
async function roomByCode(code) {
  const room = await get('SELECT * FROM rooms WHERE code=?', clean(code, 4).toUpperCase());
  if (!room) throw [404, '방을 찾을 수 없습니다.'];
  return room;
}
async function active(room) {
  return await get('SELECT * FROM activities WHERE room_id=? ORDER BY id DESC LIMIT 1', room.id);
}
async function activityData(a, show) {
  if (!a) return null;
  const words = show ? await all(`SELECT w.word, w.word_key, p.nickname FROM words w JOIN participants p ON p.id=w.participant_id WHERE w.activity_id=? ORDER BY w.id`, a.id) : [];
  const grouped = new Map();
  for (const w of words) {
    if (!grouped.has(w.word_key)) grouped.set(w.word_key, {
      word: w.word,
      count: 0,
      nicknames: []
    });
    const x = grouped.get(w.word_key);
    x.count++;
    x.nicknames.push(w.nickname);
  }
  return {
    ...a,
    words: [...grouped.values()].sort((x, y) => y.count - x.count)
  };
}
function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}
function csv(rows) {
  return '\ufeff' + rows.map(row => row.map(v => {
    let value = String(v ?? '');
    if (/^[=+@\-\t\r]/.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let text = '';
  for await (const c of req) {
    text += c;
    if (text.length > 20000) throw [413, '요청이 너무 큽니다.'];
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw [400, '잘못된 요청입니다.'];
  }
}
function csvDownload(res, name, rows) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}.csv"`,
    'Cache-Control': 'no-store'
  });
  res.end(csv(rows));
}
async function api(req, res, url) {
  const s = await session(req),
    method = req.method,
    path = url.pathname;
  let m;
  if (method === 'GET' && path === '/api/realtime-config') return json(res,200,{url:process.env.SUPABASE_URL || '',key:process.env.SUPABASE_PUBLISHABLE_KEY || ''});
  if (method === 'GET' && path === '/api/session') return json(res, 200, {
    role: s?.role || null,
    participant: s?.participant ? {
      nickname: s.participant.nickname,
      room_id: s.participant.room_id
    } : null
  });
  if (method === 'POST' && path === '/api/logout') {
    await run('DELETE FROM sessions WHERE token=?', s?.token || '');
    if(s?.participant_id) await releasePresence(s.token);
    cookie(res, '');
    return json(res, 200, {
      ok: true
    });
  }
  if (method === 'POST' && path === '/api/admin/login') {
    await throttle(req, 'admin-ip', 20);
    const b = await body(req);
    if (!verifyAdminPassword(String(b.password || ''))) throw [401, '관리자 비밀번호가 올바르지 않습니다.'];
    await makeSession('admin', null, res);
    return json(res, 200, {
      ok: true
    });
  }
  if (method === 'GET' && path === '/api/admin/rooms') {
    requireAdmin(s);
    return json(res, 200, await all(`SELECT r.*, (SELECT count(*) FROM participants p WHERE p.room_id=r.id AND p.banned=0) participant_count, (SELECT topic FROM activities a WHERE a.room_id=r.id ORDER BY id DESC LIMIT 1) topic FROM rooms r ORDER BY r.id DESC`));
  }
  if (method === 'POST' && path === '/api/admin/rooms') {
    requireAdmin(s);
    const b = await body(req),
      name = clean(b.name, 50);
    if (!name) throw [400, '방 이름을 입력해 주세요.'];
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      const bytes = randomBytes(4);
      code = [...bytes].map(x => chars[x % chars.length]).join('');
    } while (!/[A-Z]/.test(code) || !/[0-9]/.test(code) || await get('SELECT id FROM rooms WHERE code=?', code));
    await run('INSERT INTO rooms(code,name) VALUES(?,?)', code, name);
    return json(res, 201, {
      code
    });
  }
  if (m = path.match(/^\/api\/admin\/rooms\/([A-Z0-9]{4})$/)) {
    requireAdmin(s);
    const room = await roomByCode(m[1]);
    if (method === 'DELETE') {
      await run('DELETE FROM rooms WHERE id=?', room.id);
      return json(res, 200, {
        ok: true
      });
    }
    if (method === 'GET') {
      const activities = await all('SELECT * FROM activities WHERE room_id=? ORDER BY id DESC', room.id);
      const participants = await all('SELECT id,affiliation,name,nickname,banned FROM participants WHERE room_id=? ORDER BY id', room.id);
      return json(res, 200, {
        room,
        activities,
        participants,
        activity: await activityData(activities[0], true)
      });
    }
  }
  if ((m = path.match(/^\/api\/admin\/rooms\/([A-Z0-9]{4})\/activity$/)) && method === 'POST') {
    requireAdmin(s);
    const room = await roomByCode(m[1]),
      b = await body(req),
      topic = clean(b.topic, 80);
    if (!topic || !['live', 'hidden'].includes(b.mode)) throw [400, '주제와 공개 방식을 확인해 주세요.'];
    const limit = b.limit == null || b.limit === '' ? null : Number(b.limit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw [400, '등록 개수는 1 이상이어야 합니다.'];
    const previous = await active(room);
    if (previous && previous.status !== 'closed') await run("UPDATE activities SET status='closed' WHERE id=?", previous.id);
    const activityId = (await run('INSERT INTO activities(room_id,topic,mode,word_limit,revealed) VALUES(?,?,?,?,?)', room.id, topic, b.mode, limit, b.mode === 'live' ? 1 : 0)).lastInsertRowid;
    await run('INSERT INTO activity_participants SELECT ?,id FROM participants WHERE room_id=? AND banned=0', Number(activityId), room.id);
    return json(res, 201, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/admin\/activities\/(\d+)$/)) && method === 'GET') {
    requireAdmin(s);
    const a = await get('SELECT * FROM activities WHERE id=?', Number(m[1]));
    if (!a) throw [404, '활동을 찾을 수 없습니다.'];
    return json(res, 200, await activityData(a, true));
  }
  if ((m = path.match(/^\/api\/admin\/activities\/(\d+)$/)) && method === 'POST') {
    requireAdmin(s);
    const a = await get('SELECT * FROM activities WHERE id=?', Number(m[1]));
    if (!a) throw [404, '활동을 찾을 수 없습니다.'];
    const b = await body(req);
    if (b.action === 'stop') await run("UPDATE activities SET status='stopped' WHERE id=?", a.id);else if (b.action === 'resume' && a.status !== 'closed') await run("UPDATE activities SET status='open' WHERE id=?", a.id);else if (b.action === 'reveal' && a.status !== 'open') await run('UPDATE activities SET revealed=1 WHERE id=?', a.id);else throw [400, '현재 상태에서는 실행할 수 없습니다.'];
    return json(res, 200, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/admin\/rooms\/([A-Z0-9]{4})\/banwords$/)) && method === 'POST') {
    requireAdmin(s);
    const room = await roomByCode(m[1]),
      b = await body(req);
    const terms = Array.isArray(b.terms) ? b.terms.map(x => clean(x, 30)).filter(Boolean).slice(0, 100) : [];
    await run('UPDATE rooms SET banned=? WHERE id=?', JSON.stringify(terms), room.id);
    return json(res, 200, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/admin\/participants\/(\d+)\/kick$/)) && method === 'POST') {
    requireAdmin(s);
    const id = Number(m[1]);
    await run('UPDATE participants SET banned=1 WHERE id=?', id);
    await run('DELETE FROM words WHERE participant_id=?', id);
    await run('DELETE FROM sessions WHERE participant_id=?', id);
    return json(res, 200, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/admin\/activities\/(\d+)\/words$/)) && method === 'DELETE') {
    requireAdmin(s);
    const b = await body(req),
      k = key(clean(b.word, 40));
    if (!k) throw [400, '단어를 선택해 주세요.'];
    if (b.nickname) {
      const p = await get('SELECT p.id FROM participants p JOIN activities a ON a.room_id=p.room_id WHERE a.id=? AND p.nickname_key=?', Number(m[1]), key(b.nickname));
      if (p) await run('DELETE FROM words WHERE activity_id=? AND word_key=? AND participant_id=?', Number(m[1]), k, p.id);
    } else await run('DELETE FROM words WHERE activity_id=? AND word_key=?', Number(m[1]), k);
    return json(res, 200, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/admin\/activities\/(\d+)\/export\/(summary|details)$/)) && method === 'GET') {
    requireAdmin(s);
    const a = await get('SELECT * FROM activities WHERE id=?', Number(m[1]));
    if (!a) throw [404, '활동을 찾을 수 없습니다.'];
    const people = await all('SELECT p.affiliation,p.name,p.nickname,p.banned FROM participants p JOIN activity_participants ap ON ap.participant_id=p.id WHERE ap.activity_id=? ORDER BY p.id', a.id);
    const words = await all('SELECT w.word,p.nickname FROM words w JOIN participants p ON p.id=w.participant_id WHERE w.activity_id=? ORDER BY p.nickname,w.id', a.id);
    if (m[2] === 'details') return csvDownload(res, 'wordthing-details', [['닉네임', '입력 단어'], ...words.map(w => [w.nickname, w.word])]);
    const groups = (await activityData(a, true)).words;
    return csvDownload(res, 'wordthing-summary', [['주제', a.topic], ['참가자 수', people.filter(p => !p.banned).length], [], ['단어', '횟수'], ...groups.map(w => [w.word, w.count]), [], ['소속', '이름', '닉네임', '상태'], ...people.map(p => [p.affiliation, p.name, p.nickname, p.banned ? '퇴출' : '참여'])]);
  }
  if (method === 'POST' && path === '/api/join') {
    await throttle(req, 'join-ip', 1000);
    const b = await body(req),
      room = await roomByCode(b.code),
      nickname = clean(b.nickname, 24),
      pin = String(b.pin || '');
    if (!nickname || !/^\d{4}$/.test(pin)) throw [400, '닉네임과 숫자 4자리 비밀번호를 확인해 주세요.'];
    if(b.rejoin) await throttle(req, 'rejoin:'+room.code+':'+key(nickname), 10, true);
    const p = await get('SELECT * FROM participants WHERE room_id=? AND nickname_key=?', room.id, key(nickname));
    if (b.rejoin) {
      if (!p || p.banned || hash(pin, p.salt) !== p.pin_hash) throw [401, '정보가 맞지 않거나 접속이 제한되었습니다.'];
      await makeSession('participant', p.id, res);
    } else {
      if (p) throw [409, '이미 사용 중인 닉네임입니다.'];
      const affiliation = clean(b.affiliation, 40),
        name = clean(b.name, 40);
      if (!affiliation || !name) throw [400, '소속과 이름을 입력해 주세요.'];
            const salt = randomBytes(16).toString('hex');
      const id = (await run('INSERT INTO participants(room_id,affiliation,name,nickname,nickname_key,salt,pin_hash) VALUES(?,?,?,?,?,?,?)', room.id, affiliation, name, nickname, key(nickname), salt, hash(pin, salt))).lastInsertRowid;
      try {await makeSession('participant', Number(id), res);} catch(e) {await run('DELETE FROM participants WHERE id=?',Number(id));throw e;}
      const current = await active(room);
      if (current) await run('INSERT OR IGNORE INTO activity_participants VALUES(?,?)', current.id, Number(id));
    }
    return json(res, 200, {
      code: room.code
    });
  }
  if ((m = path.match(/^\/api\/rooms\/([A-Z0-9]{4})$/)) && method === 'GET') {
    const room = await roomByCode(m[1]);
    requireParticipant(s, room);
    const a = await active(room);
    const mine = a ? await all('SELECT id,word FROM words WHERE activity_id=? AND participant_id=? ORDER BY id DESC', a.id, s.participant.id) : [];
    return json(res, 200, {
      room: {
        code: room.code,
        name: room.name
      },
      nickname: s.participant.nickname,
      participantCount: (await get('SELECT count(*) n FROM participants WHERE room_id=? AND banned=0', room.id)).n,
      activity: await activityData(a, !!a?.revealed),
      mine
    });
  }
  if ((m = path.match(/^\/api\/rooms\/([A-Z0-9]{4})\/words$/)) && method === 'POST') {
    const room = await roomByCode(m[1]);
    requireParticipant(s, room);
    const b = await body(req), word=clean(b.word,40);
    await submitWord(room.id,s.participant.id,word,key(word));
    return json(res, 201, {
      ok: true
    });
  }
  if ((m = path.match(/^\/api\/rooms\/([A-Z0-9]{4})\/words\/(\d+)$/)) && method === 'DELETE') {
    const room = await roomByCode(m[1]);
    requireParticipant(s, room);
    const a = await active(room);
    if (!a || a.status !== 'open') throw [400, '입력이 정지되어 변경할 수 없습니다.'];
    await run('DELETE FROM words WHERE id=? AND activity_id=? AND participant_id=?', Number(m[2]), a.id, s.participant.id);
    return json(res, 200, {
      ok: true
    });
  }
  throw [404, '요청을 찾을 수 없습니다.'];
}
export async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/index' && url.searchParams.has('__route')) url.pathname='/api/'+url.searchParams.get('__route');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = /^\/(?:start|admin(?:\/.*)?|join\/[A-Za-z0-9]{4}|room\/[A-Za-z0-9]{4})\/?$/.test(url.pathname) || url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'style.css', 'mascot.png', 'mongtting-sprites.png', 'game.js'].includes(file)) throw [404, 'Not found'];
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, {
      'Content-Type': `${type}; charset=utf-8`,
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(readFileSync(join('public', file)));
  } catch (e) {
    if (Array.isArray(e)) json(res, e[0], {
      error: e[1]
    });else {
      console.error(e);
      json(res, 500, {
        error: '서버 오류가 발생했습니다.'
      });
    }
  }
}
