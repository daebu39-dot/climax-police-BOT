// CLIMAX 경찰청 - 디스코드 출근방 자동 출퇴근 봇
// 출근방(음성채널)에 들어오면 인트라넷 출근, 나가면(어느 채널로 가든) 퇴근 처리합니다.
// 인트라넷(climax.html)의 clockIn / clockOut 과 같은 방식으로 DB를 기록합니다.
const { Client, GatewayIntentBits, Events } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CHS = new Set((process.env.CLOCK_CHANNEL_IDS || process.env.CLOCK_CHANNEL_ID || '').split(/[\s,]+/).filter(Boolean)); // 출근방 채널 ID (여러 개 가능, 쉼표로 구분)
const GUILD_ID = process.env.GUILD_ID || '';
const DB = (process.env.FIREBASE_DB_URL || 'https://climax-police-default-rtdb.firebaseio.com').replace(/\/+$/, '');
const GRACE = Math.max(0, parseInt(process.env.CLOCK_OUT_GRACE_SEC || '3', 10)) * 1000;
const RECONCILE = Math.max(5, parseInt(process.env.RECONCILE_SEC || '60', 10)) * 1000;
if (!TOKEN || !CHS.size) { console.error('DISCORD_TOKEN, CLOCK_CHANNEL_IDS 환경변수가 필요합니다.'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- Firebase REST ----------
async function fb(method, path, body, extraHeaders) {
  const res = await fetch(`${DB}/${path}.json`, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok && res.status !== 412) throw new Error(`Firebase ${method} ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res;
}
const get = async (p) => (await fb('GET', p)).json();
const patch = (p, b) => fb('PATCH', p, b);
const put = (p, b) => fb('PUT', p, b);
const post = (p, b) => fb('POST', p, b);
// 동시에 여러 곳에서 고쳐도 꼬이지 않게 하는 숫자 더하기 (인트라넷의 transaction 과 같은 역할)
async function addNumber(path, delta) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${DB}/${path}.json`, { headers: { 'X-Firebase-ETag': 'true' } });
    const etag = r.headers.get('etag'); const cur = (await r.json()) || 0;
    const w = await fetch(`${DB}/${path}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'if-match': etag }, body: JSON.stringify((typeof cur === 'number' ? cur : 0) + delta) });
    if (w.ok) return;
    if (w.status !== 412) throw new Error('addNumber ' + w.status);
  }
  throw new Error('addNumber 재시도 초과: ' + path);
}

// ---------- 시간 계산 (인트라넷과 동일: 한국시간, 피크타임 20:00~24:00) ----------
const KST = 9 * 3600 * 1000;
const kstParts = (ts) => { const d = new Date(ts + KST); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };
const dateKey = (ts) => { const p = kstParts(ts); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
const peakWindow = (p) => ({ start: Date.UTC(p.year, p.month - 1, p.day, 11, 0, 0), end: Date.UTC(p.year, p.month - 1, p.day, 15, 0, 0) });
function days(s, e) { const a = kstParts(s), b = kstParts(e); return (a.year === b.year && a.month === b.month && a.day === b.day) ? [a] : [a, b]; }
const overlapsPeak = (s, e) => days(s, e).some(d => { const w = peakWindow(d); return s < w.end && e > w.start; });
function peakMinutes(s, e) { let ms = 0; days(s, e).forEach(d => { const w = peakWindow(d); const a = Math.max(s, w.start), b = Math.min(e, w.end); if (a < b) ms += b - a; }); return Math.round(ms / 60000); }
const koStamp = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

// ---------- 디스코드 ID -> 인트라넷 계정 ----------
const botIn = new Set(); // 봇이 출근시킨 계정 (놓친 퇴장 이벤트를 주기적으로 다시 확인하는 데 사용)
let idMap = new Map(); let mapAt = 0; let lastUnknownReload = 0;
async function loadUsers(force) {
  if (!force && Date.now() - mapAt < 6 * 3600 * 1000) return;
  const users = (await get('users')) || {}; const m = new Map();
  for (const [uid, u] of Object.entries(users)) { if (u && u.discordId) { const raw = String(u.discordId).trim(); m.set(raw, uid); const dg = raw.replace(/\D/g, ''); if (dg.length >= 15) m.set(dg, uid); } }
  idMap = m; mapAt = Date.now(); log(`계정 ${Object.keys(users).length}개 중 디스코드 ID 등록 ${m.size}명`);
}
async function uidOf(discordId) {
  await loadUsers(false);
  if (idMap.has(discordId)) return idMap.get(discordId);
  if (Date.now() - lastUnknownReload > 20 * 1000) { lastUnknownReload = Date.now(); await loadUsers(true); }
  return idMap.get(discordId) || null;
}

// ---------- 포인트 ----------
async function awardPoints(uid, amount, reason) {
  if (!amount) return;
  await addNumber(`users/${uid}/attendancePoints`, amount);
  await post('point_logs', { uid, amount, reason: reason || '포인트 지급', createdAt: Date.now(), timestamp: koStamp() });
}
async function hasAttendanceBonusToday(uid) {
  const logs = (await (await fetch(`${DB}/point_logs.json?orderBy="$key"&limitToLast=500`)).json()) || {};
  const today = dateKey(Date.now());
  return Object.values(logs).some(l => l && l.uid === uid && l.reason === '출근 체크' && dateKey(l.createdAt || 0) === today);
}
const sysLog = async (u, description) => post('system_logs', { timestamp: koStamp(), category: '출퇴근', actor: `${u.name} (${u.rank || 'PLAYER'})`, description });

// ---------- 출근 / 퇴근 ----------
const busy = new Map(); // 같은 사람 처리를 순서대로
function serial(uid, fn) { const p = (busy.get(uid) || Promise.resolve()).catch(() => { }).then(fn); busy.set(uid, p); return p; }

function clockIn(uid) {
  return serial(uid, async () => {
    const u = await get(`users/${uid}`); if (!u) return;
    if (u.isWorking) { log('이미 출근 중 → 건너뜀', u.name); return; }
    const now = Date.now();
    await patch(`users/${uid}`, { isWorking: true, workStartTime: now, workSource: 'discord' });
    botIn.add(uid);
    const cfg = (await get('point_config')) || {};
    if (cfg.perAttendance && !(await hasAttendanceBonusToday(uid))) await awardPoints(uid, cfg.perAttendance, '출근 체크');
    await sysLog(u, '디스코드 출근방 입장 - 자동 출근');
    log('출근', u.name);
  });
}

function clockOut(uid, at) {
  return serial(uid, async () => {
    botIn.delete(uid);
    const [u, cfg0] = await Promise.all([get(`users/${uid}`), get('point_config')]);
    if (!u || !u.isWorking) return;
    const cfg = cfg0 || {};
    const now = at || Date.now(); const start = u.workStartTime || now;
    const elapsed = Math.max(0, Math.floor((now - start) / 60000)); const peak = overlapsPeak(start, now);
    await patch(`users/${uid}`, { isWorking: false, workStartTime: null, workSource: null }); // 화면에 바로 반영되는 핵심 단계
    log('퇴근 상태 반영', u.name, elapsed + '분');
    // 나머지(출퇴근 기록·포인트·로그)는 동시에 처리해서 빠르게 끝냄
    const key = dateKey(start);
    const attendance = (async () => {
      const ex = await get(`attendance/${uid}/${key}`);
      if (ex) await patch(`attendance/${uid}/${key}`, { minutes: (ex.minutes || 0) + elapsed, isPeak: !!(ex.isPeak || peak), timestamp: Date.now(), sessions: (ex.sessions || 1) + 1 });
      else await put(`attendance/${uid}/${key}`, { date: new Date(start).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }), minutes: elapsed, isPeak: peak, timestamp: Date.now(), sessions: 1 });
    })();
    const points = (async () => {
      if (cfg.perHourWork) await awardPoints(uid, Math.round(cfg.perHourWork * (elapsed / 60)), '근무시간');
      if (peak && cfg.perPeakHour) { const m = peakMinutes(start, now); if (m > 0) await awardPoints(uid, Math.round(cfg.perPeakHour * (m / 60)), '피크타임 근무'); }
    })();
    await Promise.all([attendance, points, sysLog(u, `디스코드 출근방 퇴장 - 자동 퇴근 (누적: ${elapsed}분${peak ? ' (피크타임)' : ''})`)]);
    log('퇴근 처리 완료', u.name);
  });
}

// ---------- 디스코드 ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const pendingOut = new Map(); // discordId -> { timer }

const present = new Set(); // 출근방에 있다고 알고 있는 디스코드 ID (캐시가 비어 있어도 퇴장을 놓치지 않도록)
client.on(Events.VoiceStateUpdate, async (oldS, newS) => {
  try {
    const member = newS.member || oldS.member; if (!member || member.user.bot) return;
    if (GUILD_ID && (newS.guild || oldS.guild).id !== GUILD_ID) return;
    const id = member.id; const was = CHS.has(oldS.channelId) || present.has(id), now = CHS.has(newS.channelId);
    if (oldS.channelId !== newS.channelId) log(`음성 이동: ${member.user.tag} ${oldS.channelId || '-'} → ${newS.channelId || '-'}${now ? ' (출근방)' : ''}${was && !now ? ' (출근방에서 나감)' : ''}`);
    if (was === now) return; // 출근방과 상관없는 이동 / 출근방끼리 이동
    if (now) { // 입장
      present.add(id);
      const t = pendingOut.get(id); if (t) { clearTimeout(t); pendingOut.delete(id); log('잠깐 끊겼다가 다시 입장 → 퇴근 취소', member.user.tag); }
      const uid = await uidOf(id); if (!uid) { log('인트라넷에 연결되지 않은 디스코드 ID:', member.user.tag, id); return; }
      await clockIn(uid);
    } else { // 퇴장(다른 채널로 이동 포함)
      present.delete(id);
      const leftAt = Date.now();
      const t = setTimeout(async () => { pendingOut.delete(id); try { const uid = await uidOf(id); if (uid) await clockOut(uid, leftAt); else log('퇴근 처리 불가 - 연결된 계정 없음', id); } catch (e) { console.error('퇴근 처리 오류', e); } }, GRACE);
      pendingOut.set(id, t);
    }
  } catch (e) { console.error('voiceStateUpdate 오류', e); }
});

// 안전장치: 1분마다 "봇이 출근시킨 사람이 아직 출근방에 있는지" 다시 확인해서, 놓친 퇴장이 있으면 퇴근 처리
function roomIds() {
  const ids = new Set(); let seen = false;
  for (const g of client.guilds.cache.values()) {
    if (GUILD_ID && g.id !== GUILD_ID) continue;
    for (const chId of CHS) { const ch = g.channels.cache.get(chId); if (!ch || !ch.members) continue; seen = true; ch.members.forEach(m => ids.add(m.id)); }
  }
  return seen ? ids : null;
}
async function reconcile() {
  try {
    const ids = roomIds(); if (!ids) return;
    const rev = new Map(); idMap.forEach((uid, did) => rev.set(uid, did));
    for (const uid of [...botIn]) {
      const did = rev.get(uid);
      if (did && !ids.has(did) && !pendingOut.has(did)) { log('안전장치: 출근방에 없는데 출근 상태 → 퇴근 처리', uid); await clockOut(uid).catch(e => console.error('안전장치 퇴근 오류', e)); }
    }
  } catch (e) { console.error('reconcile 오류', e); }
}

// 봇이 켜질 때 현재 상태를 맞춤: 방에 있는 사람은 출근, 봇이 출근시켰는데 방에 없는 사람은 퇴근
async function syncOnStart() {
  await loadUsers(true);
  const inRoom = new Set();
  for (const g of client.guilds.cache.values()) {
    if (GUILD_ID && g.id !== GUILD_ID) continue;
    for (const chId of CHS) { const ch = g.channels.cache.get(chId); if (!ch || !ch.members) continue; ch.members.forEach(m => { if (!m.user.bot) inRoom.add(m.id); }); }
  }
  for (const id of inRoom) { present.add(id); const uid = idMap.get(id); if (uid) await clockIn(uid).catch(console.error); }
  const roomUids = new Set([...inRoom].map(id => idMap.get(id)).filter(Boolean));
  const users = (await get('users')) || {};
  for (const [uid, u] of Object.entries(users)) {
    if (u && u.isWorking && u.workSource === 'discord') { if (roomUids.has(uid)) botIn.add(uid); else await clockOut(uid).catch(console.error); }
  }
  log(`시작 동기화 완료 (출근방 ${CHS.size}개 / 현재 ${inRoom.size}명)`);
}

client.once(Events.ClientReady, async (c) => { log('봇 로그인:', c.user.tag, '/ 출근방 ID:', [...CHS].join(',')); try { await syncOnStart(); } catch (e) { console.error('시작 동기화 실패', e); } setInterval(reconcile, RECONCILE); });
client.login(TOKEN);
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
