// 我最有同理心：教室即時競賽伺服器（不需要安裝任何套件，只要有 Node.js）
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const KEY = process.env.HOST_KEY || crypto.randomBytes(3).toString('hex'); // 老師密碼（雲端請用環境變數 HOST_KEY 設定）
const newPin = () => String(Math.floor(1000 + Math.random() * 9000)); // 學生加入用的 4 位數遊戲代碼
const MAX_PLAYERS = 60;

const G = {
  pin: newPin(),
  phase: 'lobby', // lobby | writing | review | voting | results
  round: 0, situation: null, deadline: 0, reveal: 0,
  players: new Map(), answers: [], ranking: []
};
const clients = new Map(); // cid -> {res, role, pid, last}

const rid = n => crypto.randomBytes(n).toString('hex');
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

function ips() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  out.sort((a, b) => (/^(192\.168|10\.)/.test(b) ? 1 : 0) - (/^(192\.168|10\.)/.test(a) ? 1 : 0));
  return out.map(ip => `http://${ip}:${PORT}`);
}

// 名次積分：最高票 100、第二 80、第三 70、第四 60、第五 50、第六 40（同票同名次、同分）
const PTS = { 1: 100, 2: 80, 3: 70, 4: 60, 5: 50, 6: 40 };
const ptsOf = a => (a.votes > 0 ? PTS[a.rank] || 0 : 0);
const topList = () => G.ranking.filter(a => a.votes > 0 && a.rank <= 6).slice(0, 10);

function tally() {
  const vis = G.answers.filter(a => !a.hidden);
  vis.sort((a, b) => b.votes - a.votes);
  let rk = 0;
  vis.forEach((a, i) => { if (i === 0 || a.votes !== vis[i - 1].votes) rk = i + 1; a.rank = rk; });
  G.ranking = vis;
  for (const p of G.players.values()) {
    const ans = G.answers.find(a => a.pid === p.id);
    p.roundPts = ans && !ans.hidden ? 10 + ptsOf(ans) : 0; // 交答案 +10，再加名次分
    p.total += p.roundPts;
  }
}

function assignOptions() {
  const vis = G.answers.filter(a => !a.hidden).map(a => a.aid).sort(() => Math.random() - 0.5);
  const mine = pid => new Set(G.answers.filter(a => a.pid === pid).map(a => a.aid));
  let k = 0;
  for (const p of G.players.values()) {
    const own = mine(p.id), opts = [];
    const want = Math.min(8, vis.filter(x => !own.has(x)).length);
    for (let j = 0; opts.length < want && j < vis.length * 2; j++) {
      const aid = vis[(k * 8 + j) % vis.length];
      if (!own.has(aid) && !opts.includes(aid)) opts.push(aid);
    }
    p.options = opts; p.vote = null; k++;
  }
}

const votedCount = () => [...G.players.values()].filter(p => p.vote != null).length;
const eligible = () => [...G.players.values()].filter(p => p.options.length).length;

function viewHost() {
  const submitted = G.answers.length;
  const board = [...G.players.values()].sort((a, b) => b.total - a.total).slice(0, 10)
    .map(p => ({ name: p.name, total: p.total, roundPts: p.roundPts }));
  const top = topList();
  return {
    role: 'host', pin: G.pin, phase: G.phase, round: G.round, situation: G.situation, deadline: G.deadline,
    urls: ips(), players: [...G.players.values()].map(p => ({ name: p.name, on: p.on })),
    submitted, voted: votedCount(), eligible: eligible(), reveal: G.reveal,
    answers: ['review', 'voting', 'results'].includes(G.phase)
      ? G.answers.map(a => ({ aid: a.aid, name: G.players.get(a.pid)?.name, text: a.text, hidden: a.hidden })) : [],
    top: top.map(a => ({ rank: a.rank, name: G.players.get(a.pid)?.name, text: a.text, votes: a.votes, pts: ptsOf(a) })),
    board
  };
}

function viewPlayer(pid) {
  const p = G.players.get(pid);
  if (!p) return { role: 'player', gone: true };
  const mine = G.answers.find(a => a.pid === pid);
  const v = {
    role: 'player', phase: G.phase, round: G.round, situation: G.situation, deadline: G.deadline,
    me: { name: p.name, total: p.total, text: mine ? mine.text : '', voted: p.vote != null, vote: p.vote }
  };
  if (G.phase === 'voting')
    v.options = p.options.map(aid => ({ aid, text: G.answers.find(a => a.aid === aid)?.text || '' }));
  if (G.phase === 'results') {
    const top = topList();
    v.reveal = G.reveal;
    v.top = top.map(a => ({ rank: a.rank, name: G.players.get(a.pid)?.name, text: a.text, votes: a.votes, pts: ptsOf(a) }));
    v.me.roundPts = p.roundPts;
    v.me.rank = mine && !mine.hidden ? mine.rank : null;
    v.me.votes = mine ? mine.votes : 0;
    v.me.rankTotal = G.ranking.length;
    v.me.place = [...G.players.values()].sort((a, b) => b.total - a.total).findIndex(x => x.id === pid) + 1;
  }
  return v;
}

function push() {
  for (const c of clients.values()) {
    const msg = c.role === 'host' ? viewHost() : viewPlayer(c.pid);
    const s = JSON.stringify(msg);
    if (s === c.last) continue;
    c.last = s;
    c.res.write(`data: ${JSON.stringify({ now: Date.now(), ...msg })}\n\n`);
  }
}

function goReview() { G.phase = 'review'; G.deadline = 0; push(); }
function goVoting(sec) {
  assignOptions();
  G.phase = 'voting'; G.deadline = Date.now() + sec * 1000; push();
}
function goResults() {
  tally(); G.phase = 'results'; G.deadline = 0; G.reveal = 0; push();
}

setInterval(() => {
  if (G.deadline && Date.now() >= G.deadline) {
    if (G.phase === 'writing') goReview();
    else if (G.phase === 'voting') goResults();
  }
  for (const c of clients.values()) c.res.write(': ping\n\n');
}, 1000);

function hostAction(b) {
  switch (b.action) {
    case 'start': {
      const s = b.situation || {};
      G.situation = { emoji: clip(s.emoji, 4) || '💬', name: clip(s.name, 12), text: clip(s.text, 160) };
      if (!G.situation.text) return 'no situation';
      G.round++; G.answers = []; G.ranking = []; G.reveal = 0;
      for (const p of G.players.values()) { p.options = []; p.vote = null; p.roundPts = 0; }
      G.phase = 'writing';
      G.deadline = Date.now() + Math.max(30, Math.min(600, +b.seconds || 180)) * 1000;
      push(); return;
    }
    case 'endWriting': if (G.phase === 'writing') goReview(); return;
    case 'hide': { const a = G.answers.find(x => x.aid === b.aid); if (a && G.phase === 'review') a.hidden = !a.hidden; push(); return; }
    case 'startVoting': if (G.phase === 'review') goVoting(Math.max(20, Math.min(180, +b.seconds || 60))); return;
    case 'endVoting': if (G.phase === 'voting') goResults(); return;
    case 'reveal': if (G.phase === 'results') { G.reveal++; push(); } return;
    case 'next': G.phase = 'lobby'; G.deadline = 0; push(); return;
    case 'reset': G.phase = 'lobby'; G.round = 0; G.answers = []; G.ranking = []; G.players.clear(); G.pin = newPin(); push(); return;
    case 'kick': for (const [id, p] of G.players) if (p.name === b.name) G.players.delete(id); push(); return;
  }
}

function body(req) {
  return new Promise(res => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20000) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const page = (res, f) => {
  try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, f))); }
  catch { res.writeHead(500); res.end('missing ' + f); }
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    if (u.pathname === '/') return page(res, 'play.html');
    if (u.pathname === '/host') return page(res, 'host.html');
    if (u.pathname === '/events') {
      const host = u.searchParams.get('role') === 'host';
      if (host && u.searchParams.get('key') !== KEY) { res.writeHead(403); return res.end(); }
      const pid = u.searchParams.get('id');
      if (!host && !G.players.has(pid)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const cid = rid(4);
      clients.set(cid, { res, role: host ? 'host' : 'player', pid, last: '' });
      if (!host) G.players.get(pid).on = true;
      req.on('close', () => {
        clients.delete(cid);
        if (!host && G.players.has(pid) && ![...clients.values()].some(c => c.pid === pid)) G.players.get(pid).on = false;
        push();
      });
      push(); return;
    }
    res.writeHead(404); return res.end();
  }
  if (req.method === 'POST') {
    const b = await body(req);
    if (u.pathname === '/api/join') {
      if (b.id && G.players.has(b.id)) return json(res, { id: b.id });
      if (clip(b.pin, 8) !== G.pin) return json(res, { error: '遊戲代碼不對，請看老師螢幕上的 4 位數字' }, 400);
      const name = clip(b.name, 10);
      if (!name) return json(res, { error: '請輸入名字' }, 400);
      if (G.players.size >= MAX_PLAYERS) return json(res, { error: '人數已滿' }, 400);
      const id = rid(6);
      G.players.set(id, { id, name, total: 0, roundPts: 0, options: [], vote: null, on: false });
      push(); return json(res, { id });
    }
    if (u.pathname === '/api/submit') {
      const p = G.players.get(b.id), text = clip(b.text, 120);
      if (!p || G.phase !== 'writing' || !text) return json(res, { error: 'no' }, 400);
      const old = G.answers.find(a => a.pid === p.id);
      if (old) old.text = text;
      else G.answers.push({ aid: rid(3), pid: p.id, text, hidden: false, votes: 0, rank: 0 });
      push(); return json(res, { ok: true });
    }
    if (u.pathname === '/api/vote') {
      const p = G.players.get(b.id);
      if (!p || G.phase !== 'voting' || p.vote != null || !p.options.includes(b.aid)) return json(res, { error: 'no' }, 400);
      p.vote = b.aid;
      const a = G.answers.find(x => x.aid === b.aid); if (a) a.votes++;
      push();
      if (votedCount() >= eligible()) setTimeout(() => { if (G.phase === 'voting' && votedCount() >= eligible()) goResults(); }, 1200);
      return json(res, { ok: true });
    }
    if (u.pathname === '/api/host') {
      if (b.key !== KEY) return json(res, { error: 'key' }, 403);
      const err = hostAction(b);
      return json(res, err ? { error: err } : { ok: true }, err ? 400 : 200);
    }
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => {
  const hostUrl = `http://localhost:${PORT}/host?key=${KEY}`;
  console.log('\n=== 我最有同理心 已啟動 ===');
  console.log('老師控制台（已自動開啟）：' + hostUrl);
  console.log('學生請用手機連同一個 Wi-Fi，打開：');
  ips().forEach(u => console.log('   ' + u));
  console.log('\n關閉這個視窗就會結束遊戲。\n');
  if (process.platform === 'win32') exec(`start "" "${hostUrl}"`);
});
