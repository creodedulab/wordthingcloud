import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('room lifecycle, privacy, moderation and reuse', async () => {
 const dir=mkdtempSync(join(tmpdir(),'wordthing-')), port=34000+Math.floor(Math.random()*10000);
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),DB_PATH:join(dir,'test.sqlite'),ADMIN_PASSWORD:'test-secret'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 async function request(path, method='GET', body, cookie){const r=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});const text=await r.text();return {status:r.status,body:JSON.parse(text),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 try {
  for(let i=0;i<50;i++){try{await fetch(base);break}catch{await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await request('/api/admin/rooms')).status,401);
  const login=await request('/api/admin/login','POST',{password:'test-secret'});assert.equal(login.status,200);const admin=login.cookie;
  const created=await request('/api/admin/rooms','POST',{name:'테스트'},admin);const code=created.body.code;assert.match(code,/^[A-Z0-9]{4}$/);
  await request(`/api/admin/rooms/${code}/activity`,'POST',{topic:'첫 주제',mode:'hidden',limit:2},admin);
  const join=await request('/api/join','POST',{code,affiliation:'학교',name:'홍길동',nickname:'구름',pin:'1234'});assert.equal(join.status,200);const user=join.cookie;
  assert.equal((await request('/api/join','POST',{code,affiliation:'학교',name:'다른이',nickname:'구름',pin:'5555'})).status,409);
  assert.equal((await request(`/api/rooms/${code}/words`,'POST',{word:'A I'},user)).status,201);
  assert.equal((await request(`/api/rooms/${code}/words`,'POST',{word:'ai'},user)).status,409);
  assert.equal((await request(`/api/rooms/${code}`, 'GET',null,user)).body.activity.words.length,0);
  const detail=(await request(`/api/admin/rooms/${code}`,'GET',null,admin)).body;const id=detail.activity.id;assert.equal(detail.participants[0].name,'홍길동');
  await request(`/api/admin/rooms/${code}/banwords`,'POST',{terms:['사과']},admin);
  assert.equal((await request(`/api/rooms/${code}/words`,'POST',{word:'사과나무'},user)).status,400);
  assert.equal((await request(`/api/admin/activities/${id}`,'POST',{action:'reveal'},admin)).status,400);
  await request(`/api/admin/activities/${id}`,'POST',{action:'stop'},admin);
  await request(`/api/admin/activities/${id}`,'POST',{action:'reveal'},admin);
  const publicData=(await request(`/api/rooms/${code}`,'GET',null,user)).body;assert.equal(publicData.activity.words[0].nicknames[0],'구름');assert.ok(!JSON.stringify(publicData).includes('홍길동'));
  assert.equal((await request(`/api/rooms/${code}/words`,'POST',{word:'새단어'},user)).status,400);
  await request(`/api/admin/rooms/${code}/activity`,'POST',{topic:'두 번째',mode:'live'},admin);
  assert.equal((await request(`/api/rooms/${code}`,'GET',null,user)).body.mine.length,0);
  assert.equal((await request(`/api/admin/activities/${id}`,'GET',null,admin)).body.words.length,1);
  assert.equal((await request(`/api/admin/activities/${id}`,'POST',{action:'resume'},admin)).status,200);
  assert.equal((await request(`/api/admin/activities/${id}`,'POST',{action:'apply'},admin)).status,200);
  assert.equal((await request(`/api/rooms/${code}`,'GET',null,user)).body.activity.id,id);
  assert.equal((await request(`/api/rooms/${code}/words`,'POST',{word:'다시'},user)).status,201);
  assert.equal((await request(`/api/admin/activities/${id}`,'DELETE',null,admin)).status,200);
  assert.equal((await request(`/api/admin/activities/${id}`,'GET',null,admin)).body.words.length,0);
  await request(`/api/admin/participants/${detail.participants[0].id}/kick`,'POST',{},admin);
  assert.equal((await request(`/api/rooms/${code}`,'GET',null,user)).status,401);
  assert.equal((await request('/api/join','POST',{code,nickname:'구름',pin:'1234',rejoin:true})).status,401);
  assert.equal((await request(`/api/admin/activities/${id}`,'GET',null,admin)).body.words.length,0);
 } finally {child.kill();await new Promise(r=>child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});

test('role boundaries, reconnect, counts and participant-specific moderation', async () => {
 const dir=mkdtempSync(join(tmpdir(),'wordthing-auth-')), port=34000+Math.floor(Math.random()*10000);
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),DB_PATH:join(dir,'test.sqlite'),ADMIN_PASSWORD:'test-secret'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 async function request(path, method='GET', data, cookie) {
  const response=await fetch(base+path,{method,headers:{...(data?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},body:data?JSON.stringify(data):undefined});
  const type=response.headers.get('content-type')||'', text=await response.text();
  return {status:response.status,body:type.includes('application/json')?JSON.parse(text):text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 try {
  for(let i=0;i<50;i++){try{await fetch(base);break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
  const admin=(await request('/api/admin/login','POST',{password:'test-secret'})).cookie;
  assert.ok(admin);
  const room=(await request('/api/admin/rooms','POST',{name:'검증'},admin)).body.code;
  const otherRoom=(await request('/api/admin/rooms','POST',{name:'다른 방'},admin)).body.code;
  assert.notEqual(room,otherRoom);
  await request(`/api/admin/rooms/${room}/activity`,'POST',{topic:'의견',mode:'live',limit:1},admin);
  const one=(await request('/api/join','POST',{code:room,affiliation:'기관 A',name:'참가자 A',nickname:'별',pin:'1234'})).cookie;
  const two=(await request('/api/join','POST',{code:room,affiliation:'기관 B',name:'참가자 B',nickname:'달',pin:'5678'})).cookie;
  assert.ok(one && two);
  assert.equal((await request('/api/join','POST',{code:otherRoom,affiliation:'기관 C',name:'참가자 C',nickname:'별',pin:'4321'})).status,200);
  assert.equal((await request('/api/join','POST',{code:room,nickname:'별',pin:'0000',rejoin:true})).status,401);
  const rejoin=await request('/api/join','POST',{code:room,nickname:'별',pin:'1234',rejoin:true});
  assert.equal(rejoin.status,200);
  assert.equal((await request(`/api/rooms/${otherRoom}`,'GET',undefined,rejoin.cookie)).status,401);
  assert.equal((await request('/api/admin/rooms','GET',undefined,one)).status,401);
  assert.equal((await request(`/api/rooms/${room}/words`,'POST',{word:'함께'},one)).status,201);
  assert.equal((await request(`/api/rooms/${room}/words`,'POST',{word:'다른 단어'},one)).status,400);
  assert.equal((await request(`/api/rooms/${room}/words`,'POST',{word:'함께'},two)).status,201);
  let state=(await request(`/api/rooms/${room}`,'GET',undefined,one)).body;
  assert.equal(state.activity.words[0].count,2);
  assert.deepEqual(new Set(state.activity.words[0].nicknames),new Set(['별','달']));
  const wordId=state.mine[0].id;
  await request(`/api/rooms/${room}/words/${wordId}`,'DELETE',undefined,two);
  state=(await request(`/api/rooms/${room}`,'GET',undefined,one)).body;
  assert.equal(state.activity.words[0].count,2,'다른 참가자의 단어를 삭제할 수 없어야 합니다');
  const activity=(await request(`/api/admin/rooms/${room}`,'GET',undefined,admin)).body.activity;
  assert.equal((await request(`/api/admin/activities/${activity.id}/words`,'DELETE',{word:'함께'},one)).status,401);
  await request(`/api/admin/activities/${activity.id}/words`,'DELETE',{word:'함께',nickname:'별'},admin);
  state=(await request(`/api/rooms/${room}`,'GET',undefined,two)).body;
  assert.equal(state.activity.words[0].count,1);
  assert.deepEqual(state.activity.words[0].nicknames,['달']);
  assert.equal((await request(`/api/admin/activities/${activity.id}/export/summary`,'GET',undefined,two)).status,401);
  const exportResult=await request(`/api/admin/activities/${activity.id}/export/summary`,'GET',undefined,admin);
  assert.equal(exportResult.status,200);
  assert.match(exportResult.body,/참가자 A/);
  assert.match(exportResult.body,/참가자 B/);
 } finally {
  child.kill();
  await new Promise(resolve=>child.once('exit',resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
