const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const MAX_HUMANS_PER_ROOM = 35;
const BOT_TOTAL_PER_ROOM = 30;
const P = 64;
const AIRPORT_X = 14 * P + 32;
const AIRPORT_Z = 13 * P + 32;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'distrito-x-data.json');
const RESTART_FILE = path.join(DATA_DIR, 'restart-schedule.json');

const htmlCandidates = [
  path.join(__dirname, 'Index.html'), path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'Index.html'), path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'www', 'Index.html'), path.join(__dirname, 'www', 'index.html')
];
function findHtmlFile() { return htmlCandidates.find(fs.existsSync) || null; }
app.get('/health', (_req, res) => res.json({ ok: true, rooms: ['1', '2'], uptime: Math.floor(process.uptime()) }));
app.get('/', (_req, res) => { const file = findHtmlFile(); if (file) return res.sendFile(file); res.status(200).send('Distrito X City Server online'); });
app.use('/data', (_req, res) => res.status(404).send('Not found'));
app.use(express.static(__dirname));
if (fs.existsSync(path.join(__dirname, 'public'))) app.use(express.static(path.join(__dirname, 'public')));
if (fs.existsSync(path.join(__dirname, 'www'))) app.use(express.static(path.join(__dirname, 'www')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJsonAtomic(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file);
}
const persisted = readJson(DATA_FILE, { nextPlayerId: 1001, players: {}, verified: {}, banned: {}, adminLog: [] });
if (!persisted.players || typeof persisted.players !== 'object') persisted.players = {};
if (!persisted.verified || typeof persisted.verified !== 'object') persisted.verified = {};
if (!persisted.banned || typeof persisted.banned !== 'object') persisted.banned = {};
if (!persisted.kills || typeof persisted.kills !== 'object') persisted.kills = {};
if (!persisted.nameColors || typeof persisted.nameColors !== 'object') persisted.nameColors = {};
if (!persisted.vips || typeof persisted.vips !== 'object') persisted.vips = {};
if (!persisted.roomKills || typeof persisted.roomKills !== 'object') persisted.roomKills = {'1':{},'2':{}};
if (!persisted.mvp || typeof persisted.mvp !== 'object') persisted.mvp = {};
if (!persisted.bios || typeof persisted.bios !== 'object') persisted.bios = {};
if (!persisted.deaths || typeof persisted.deaths !== 'object') persisted.deaths = {};
if (!persisted.damage || typeof persisted.damage !== 'object') persisted.damage = {};
if (typeof persisted.ownerId !== 'string') persisted.ownerId = null;
if (!Number.isFinite(persisted.nextPlayerId)) persisted.nextPlayerId = 1001;
const loginAttempts = new Map();
function saveData() { writeJsonAtomic(DATA_FILE, persisted); }
function stablePlayerId(clientKey, nick) {
  const key = String(clientKey || '').trim().slice(0, 80);
  if (key && persisted.players[key]) { persisted.players[key].name=String(nick||persisted.players[key].name||'Jogador').slice(0,16); saveData(); return persisted.players[key].id; }
  const id = 'DX-' + String(persisted.nextPlayerId++).padStart(6, '0');
  const profile = { id, name: String(nick || 'Jogador').slice(0, 16), firstSeen: Date.now(), clientKey: key || null };
  if (key) persisted.players[key] = profile;
  saveData();
  return id;
}
function profileById(id) { return Object.values(persisted.players).find(p => p.id === id) || null; }
function isVerified(id) { return !!persisted.verified[id]; }
function isOwner(id) { return !!id && persisted.ownerId === id; }
function isVip(id) { return !!id && !!persisted.vips[id]; }
function killsFor(id) { return Math.max(0, Number(persisted.kills[id]) || 0); }
const NAME_COLORS = ['#ffffff','#d9f3ff','#8be9ff','#4dd0e1','#00bcd4','#80deea','#b2ebf2','#e0f7fa','#c5cae9','#9fa8da','#7986cb','#5c6bc0','#3f51b5','#b39ddb','#9575cd','#7e57c2','#673ab7','#d1c4e9','#f8bbd0','#f48fb1','#ec407a','#e91e63','#f8bbd0','#ffcdd2','#ef9a9a','#e57373','#f44336','#ffccbc','#ffab91','#ff8a65','#ff7043','#ff5722','#ffe0b2','#ffcc80','#ffb74d','#ffa726','#ff9800','#fff9c4','#fff59d','#ffee58','#ffeb3b','#dcedc8','#c5e1a5','#aed581','#8bc34a','#a5d6a7','#81c784','#66bb6a','#4caf50','#80cbc4'];
function unlockedColorCount(kills) { const n=Math.max(0,Number(kills)||0);return n<100?1:Math.min(50,2+Math.floor((n-100)/2000)); }
function publicHuman(p) { const k=killsFor(p.playerId); return {...p, isBot:false, verified:isVerified(p.playerId), vip:isVip(p.playerId), owner:isOwner(p.playerId), kills:k, nameColor:persisted.nameColors[p.playerId]||0, unlockedColors:unlockedColorCount(k)}; }
function logAdmin(action, details) { persisted.adminLog.unshift({ at: Date.now(), action, details }); persisted.adminLog = persisted.adminLog.slice(0, 100); saveData(); }
function authToken(req) { const raw = req.headers.authorization || ''; return raw.startsWith('Bearer ') ? raw.slice(7) : ''; }
function adminTokenSignature(issuedAt, expiresAt) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update('distrito-x-admin:' + issuedAt + ':' + expiresAt).digest('hex');
}
function createAdminToken() {
  const issuedAt = Date.now(), expiresAt = issuedAt + 12 * 60 * 60 * 1000;
  return issuedAt + '.' + expiresAt + '.' + adminTokenSignature(issuedAt, expiresAt);
}
function isValidAdminToken(token) {
  if (!ADMIN_PASSWORD || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const issuedAt = Number(parts[0]), expiresAt = Number(parts[1]);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() + 60000 || issuedAt < (Number(persisted.adminTokenRevokedBefore) || 0) || expiresAt <= Date.now() || expiresAt - issuedAt !== 12 * 60 * 60 * 1000) return false;
  const expected = Buffer.from(adminTokenSignature(issuedAt, expiresAt));
  const supplied = Buffer.from(parts[2]);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}
function requireAdmin(req, res, next) {
  if (!isValidAdminToken(authToken(req))) return res.status(401).json({ ok: false, error: 'Sessão administrativa inválida ou expirada. Entre novamente no painel.' });
  next();
}
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ ok: false, error: 'Configure ADMIN_PASSWORD nas variáveis do servidor antes de usar o painel.' });
  const ip=req.ip||req.socket.remoteAddress||'unknown',now=Date.now();
  let attempt=loginAttempts.get(ip)||{count:0,resetAt:now+15*60*1000,blockedUntil:0};
  if(attempt.blockedUntil>now)return res.status(429).json({ok:false,error:'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.'});
  if(attempt.resetAt<now)attempt={count:0,resetAt:now+15*60*1000,blockedUntil:0};
  const password = String(req.body && req.body.password || ''),pwBuf=Buffer.from(password),adminBuf=Buffer.from(ADMIN_PASSWORD);
  const valid=pwBuf.length===adminBuf.length&&crypto.timingSafeEqual(pwBuf,adminBuf);
  if(!valid){attempt.count++;if(attempt.count>=5)attempt.blockedUntil=now+15*60*1000;loginAttempts.set(ip,attempt);return res.status(attempt.blockedUntil?429:401).json({ok:false,error:attempt.blockedUntil?'Muitas tentativas. Aguarde 15 minutos.':'Senha incorreta.'});}
  loginAttempts.delete(ip);
  const token = createAdminToken();
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, token, expiresIn: 43200 });
});
app.post('/api/admin/logout', requireAdmin, (_req, res) => { persisted.adminTokenRevokedBefore = Date.now(); saveData(); res.json({ ok: true }); });

const CITY_CENTERS = [
  { ix: 0, iz: 0, r: 12 }, { ix: 34, iz: 0, r: 8 }, { ix: -34, iz: 0, r: 8 },
  { ix: 0, iz: 34, r: 8 }, { ix: 0, iz: -34, r: 8 }, { ix: 34, iz: -34, r: 8 }
];
function hashCell(a, b) { let v = (a * 73856093 ^ b * 19349663) | 0; v ^= v >>> 13; v = Math.imul(v, 0x5bd1e995); v ^= v >>> 15; return v & 0x7fffffff; }
function airportLot(ix, iz) { return Math.abs(ix - 14) <= 3 && Math.abs(iz - 13) <= 2; }
function nearestCityCell(ix, iz) { let best = CITY_CENTERS[0], d2 = Infinity; for (const c of CITY_CENTERS) { const d = (ix-c.ix)**2+(iz-c.iz)**2; if (d < d2) { d2 = d; best = c; } } return { city: best, distance: Math.sqrt(d2) }; }
function cityZone(ix, iz) { if (airportLot(ix, iz)) return 1; const q = nearestCityCell(ix, iz); return q.distance <= q.city.r ? 0 : 1; }
function plazaLot(ix, iz) {
  if (cityZone(ix, iz) !== 0 || hashCell(ix, iz) % 6 !== 0) return false;
  const c = nearestCityCell(ix, iz).city; return Math.abs(ix-c.ix) <= 5 && Math.abs(iz-c.iz) <= 5;
}
function coastalPlazaLot(ix, iz) {
  if (cityZone(ix, iz) !== 1 || airportLot(ix, iz)) return false;
  const q = nearestCityCell(ix, iz); return q.distance > q.city.r && q.distance <= q.city.r + 8 && hashCell(ix+271, iz-91) % 131 === 0;
}
function safeZoneAt(x, z, elevation=0) {
  if (elevation > 0) return false;
  const ix0 = Math.round(x/P), iz0 = Math.round(z/P);
  for (let ix=ix0-1; ix<=ix0+1; ix++) for (let iz=iz0-1; iz<=iz0+1; iz++) {
    if ((plazaLot(ix,iz) || coastalPlazaLot(ix,iz)) && Math.abs(x-ix*P)<=21 && Math.abs(z-iz*P)<=21) return true;
  }
  return false;
}

function createInitialCars() {
  const cars = [
    { id: 'carro_1', x: 24, y: 50, angle: 0, speed: 0, driverId: null },
    { id: 'carro_2', x: 40, y: 10, angle: Math.PI, speed: 0, driverId: null },
    { id: 'carro_3', x: 74, y: 38, angle: Math.PI / 2, speed: 0, driverId: null },
    { id: 'carro_4', x: -8, y: 38, angle: -Math.PI / 2, speed: 0, driverId: null },
    { id: 'carro_fusca', x: 12, y: 32, angle: 0, speed: 0, driverId: null },
    { id: 'moto_1', x: 50, y: 34, angle: Math.PI / 2, speed: 0, driverId: null },
    { id: 'aviao_aeroporto', x: AIRPORT_X - 76, y: AIRPORT_Z, angle: Math.PI / 2, speed: 0, altitude: 0, pitch: 0, roll: 0, driverId: null }
  ];
  return cars.map(car => ({ ...car, spawn:{x:car.x,y:car.y,angle:car.angle}, abandonedAt:null, lastDrivenAt:0 }));
}
const BOT_NAMES = ['Carlos','Miguel','André','Bruno','Rafael','Mateus','Lucas','Pedro','Thiago','Diego','João','Gabriel','Felipe','Caio','Vinícius','Eduardo','Gustavo','Marcos','Daniel','Leandro','Samuel','Henrique','Vitor','Renan','Alex','Nicolas','Murilo','Enzo','Davi','Arthur'];
const PERSONALITIES = ['tranquilo','curioso','competitivo','sociável','desconfiado','aventureiro','protetor','brincalhão','observador','corajoso'];
function createBot(roomId, index) {
  const id = `BOT-S${roomId}-${String(index+1).padStart(2,'0')}`;
  const seed = index*137 + Number(roomId)*911;
  const city = CITY_CENTERS[index % CITY_CENTERS.length];
  const angle = Math.floor(index / CITY_CENTERS.length) * 2.399963229728653 + seed * 0.013;
  const radius = Math.max(2, city.r - 2) * P;
  const home = { x: city.ix * P + 32, z: city.iz * P + 32, radius };
  const spawnRadius = radius * (0.28 + ((index * 7) % 5) * 0.075);
  const x = home.x + Math.cos(angle) * spawnRadius;
  const z = home.z + Math.sin(angle) * spawnRadius;
  const goalAngle = angle + 1.7, goalRadius = radius * (0.2 + Math.random() * 0.45);
  return { id, name: BOT_NAMES[index%BOT_NAMES.length], x, y:z, angle:Math.random()*Math.PI*2, inCarId:null, seatRole:'foot', elevation:0,
    look:{skin:index%5,shirt:index%8,pant:index%6,hair:index%6}, weapon:index%5, hp:200, deaths:0, kills:0, safeZone:safeZoneAt(x,z), verified:false, isBot:true,
    home, personality:PERSONALITIES[index%PERSONALITIES.length], goal:{x:home.x+Math.cos(goalAngle)*goalRadius,z:home.z+Math.sin(goalAngle)*goalRadius,until:Date.now()+5000+Math.random()*10000},
    memory:{ lastThreat:null, avoidUntil:0, friendlyIds:[], experiences:0, noHostility:{} }, vx:0,vy:0,lastChat:0,lastAttack:0, lastThink:0, combatTarget:null, moving:true, chatCooldown:0, mood:Math.random() };
}
function createRoom(roomId) { return { players:{}, bots:Array.from({length:BOT_TOTAL_PER_ROOM},(_,i)=>createBot(roomId,i)), cars:createInitialCars(), botTargetCount:BOT_TOTAL_PER_ROOM, botAuto:true, chat:[], stats:{damage:0,kills:0}, botsEnabled:true, lastBotChatAt:0 }; }
const rooms = { '1':createRoom('1'), '2':createRoom('2') };
function normalizeRoomId(raw) { return String(raw)==='2'?'2':'1'; }
function combinedPlayers(room) { const all={}; Object.values(room.players).forEach(p=>{all[p.id]=publicHuman(p);}); room.bots.forEach(b=>{ if (b.active!==false) all[b.id]=publicBot(b); }); return all; }
function publicBot(b) { const { personality,goal,memory,home,lastChat,lastAttack,lastThink,combatTarget,moving,chatCooldown,mood,active,...safe }=b; return {...safe, isBot:true, verified:false, owner:false, kills:Math.max(0,Number(b.kills)||0), deaths:Math.max(0,Number(b.deaths)||0), nameColor:(Math.max(0,Number(b.kills)||0))%NAME_COLORS.length}; }
function botBroadcastJoin(roomId, bot) { io.to('srv_'+roomId).emit('player:joined',publicBot(bot)); }
function botBroadcastMove(roomId, bot) { io.to('srv_'+roomId).emit('player:moved',publicBot(bot)); }
function botSay(roomId, bot, text) {
  if(bot.active===false)return;
  const msg={ id:bot.id, name:bot.name, text:String(text).slice(0,110), isBot:true, botId:bot.id, at:Date.now() };
  const room=rooms[roomId]; if (!room) return;
  room.chat.push(msg); room.chat=room.chat.slice(-30);
  io.to('srv_'+roomId).emit('chat:msg',msg); io.to('srv_'+roomId).emit('chat:message',msg);
}
function chatWithBots(roomId, sender, text) {
  const room=rooms[roomId]; if(!room||!room.botsEnabled)return;
  const lower=text.toLowerCase();
  const commandStop=/\b(parar|para|não atira|nao atira|sem pvp|pvp off|guardar arma|guarda a arma|cessar fogo|peace|paz)\b/.test(lower);
  const commandFight=/\b(vamos lutar|me enfrenta|ataca|pvp|bora brigar)\b/.test(lower);
  const botMention=room.bots.find(b=>lower.includes(b.name.toLowerCase())||lower.includes(b.id.toLowerCase()));
  const candidates=botMention?[botMention]:room.bots.filter(b=>Math.hypot(b.x-sender.x,b.y-sender.y)<70).slice(0,4);
  if(commandStop) {
    candidates.forEach(b=>{ b.memory.noHostility[sender.id]=Date.now()+120000;b.memory.noHostilityExpiry=Date.now()+120000; if(b.combatTarget===sender.id)b.combatTarget=null; if(b.weapon>=0)b.memory.previousWeapon=b.weapon; b.weapon=-1; b.memory.avoidUntil=Date.now()+10000; });
    const responder=botMention||candidates[0]; if(responder) setTimeout(()=>botSay(roomId,responder,`Fechado, ${sender.name}. Vou guardar a arma e não vou te atacar.`),800+Math.random()*1800);
    return;
  }
  if(commandFight){ const responder=botMention||candidates.find(b=>b.personality==='competitivo')||candidates[0]; if(responder) setTimeout(()=>botSay(roomId,responder,`Se quiser, vamos lá. Só fora da praça segura!`),800+Math.random()*1600); return; }
  if(!candidates.length)return;
  const responder=candidates[Math.floor(Math.random()*candidates.length)];
  if(Date.now()-responder.lastChat<12000)return;
  responder.lastChat=Date.now();
  const reply=botReply(responder,sender,text);
  if(reply)setTimeout(()=>botSay(roomId,responder,reply),900+Math.random()*3500);
}
function botReply(bot, sender, text) {
  const s=text.toLowerCase();
  if(/\b(oi|olá|ola|eai|e aí|salve|bom dia|boa tarde|boa noite)\b/.test(s))return `${sender.name}, salve! Tudo tranquilo por aí?`;
  if(/\b(quem|seu nome|nome)\b/.test(s))return `Sou ${bot.name}. Tô pela cidade, personalidade ${bot.personality}.`;
  if(/\b(ajuda|help|onde|local|mapa)\b/.test(s))return `Posso dar uma força. Me fala o que você procura, ${sender.name}.`;
  if(/\b(arma|pistola|fuzil|tiro)\b/.test(s))return `Cuidado com arma na praça, aqui é zona segura.`;
  if(/\b(obrigad|valeu)\b/.test(s))return `É nóis, ${sender.name}!`;
  if(bot.personality==='brincalhão')return `Haha, ${sender.name}, essa cidade não para!`;
  if(bot.personality==='curioso')return `Interessante. Você costuma ficar por essa região, ${sender.name}?`;
  return `Entendi, ${sender.name}. Tô de boa aqui, só explorando a cidade.`;
}
function botThink(roomId, bot, room, now) {
  if(!room.botsEnabled || bot.active===false)return;
  if(bot.weapon<0&&bot.memory.previousWeapon!==undefined&&now>(bot.memory.noHostilityExpiry||0)){bot.weapon=bot.memory.previousWeapon;delete bot.memory.previousWeapon;}

  // Decisões de IA em intervalo estável; movimento físico continua em passos curtos.
  if(now-(bot.lastDecision||0)>=800){
    bot.lastDecision=now;
    const humans=Object.values(room.players).filter(p=>p.hp>0&&!p.invulnerable);
    const botRivals=room.bots.filter(p=>p!==bot&&p.active!==false&&p.hp>0&&!safeZoneAt(p.x,p.y,p.elevation));
    const nearbyBots=botRivals.map(p=>({p,d:Math.hypot(p.x-bot.x,p.y-bot.y)})).filter(({p,d})=>d<90&&!safeZoneAt(bot.x,bot.y,bot.elevation));
    const nearbyHumans=humans.map(p=>({p,d:Math.hypot(p.x-bot.x,p.y-bot.y)})).filter(({p,d})=>d<90&&!safeZoneAt(p.x,p.y,p.elevation)&&!safeZoneAt(bot.x,bot.y,bot.elevation)&&!(bot.memory.noHostility[p.id]>now));
    const chooseBot=nearbyBots.length>0&&Math.random()<0.78;
    const enemy=(chooseBot?nearbyBots:nearbyHumans).sort((a,b)=>a.d-b.d)[0];
    if(enemy&&enemy.p.isBot){bot.combatTarget=null;bot.goal={x:enemy.p.x,z:enemy.p.y,until:now+1800};}
    else if(enemy&&['competitivo','corajoso','protetor','desconfiado'].includes(bot.personality)&&Math.random()<(bot.personality==='desconfiado'?.12:.30))bot.combatTarget=enemy.p.id;
    else if(!enemy||!nearbyHumans.some(x=>x.p.id===bot.combatTarget))bot.combatTarget=null;

    bot.memory.experiences++;
    if(bot.memory.experiences%16===0&&Math.random()<.20){bot.memory.avoidUntil=now+3000;const h=bot.home||{x:32,z:32,radius:300};const a=Math.random()*Math.PI*2,r=Math.random()*h.radius*.55;bot.goal={x:h.x+Math.cos(a)*r,z:h.z+Math.sin(a)*r,until:now+6500};}
    botThinkCombatBots(roomId,room,bot,now);
    botSocialThink(roomId,room,bot,now);
  }

  if(bot.combatTarget){
    const target=room.players[bot.combatTarget];
    if(!target||target.invulnerable||safeZoneAt(target.x,target.y,target.elevation)||safeZoneAt(bot.x,bot.y,bot.elevation))bot.combatTarget=null;
    else {
      const d=Math.hypot(target.x-bot.x,target.y-bot.y);
      if(d>28)bot.goal={x:target.x,z:target.y,until:now+900};
      else if(now-bot.lastAttack>1600){
        bot.lastAttack=now;const damage=8+Math.floor(Math.random()*12);const shootAngle=Math.atan2(target.x-bot.x,target.y-bot.y);
        io.to('srv_'+roomId).emit('player:shot',{id:bot.id,x:bot.x,y:bot.y,angle:shootAngle,range:48,dmg:damage});
        const hp=Math.max(0,target.hp-damage);target.hp=hp;
        io.to('srv_'+roomId).emit('player:damaged',{targetId:target.id,attackerId:bot.id,attackerName:bot.name,dmg:damage,hp,damageSource:'bot'});
        if(hp<=0){
          target.hp=200;target.deaths=(target.deaths||0)+1;
          persisted.deaths[target.playerId]=(Number(persisted.deaths[target.playerId])||0)+1;
          bot.kills=(bot.kills||0)+1;saveData();
          io.to('srv_'+roomId).emit('player:eliminated',{targetId:target.id,attackerId:bot.id,attackerName:bot.name,targetName:target.name});
          botSay(roomId,bot,`Foi mal, ${target.name}. Você caiu, mas já vai voltar.`);
        }
      }
    }
  }

  if(now>bot.goal.until||Math.hypot(bot.goal.x-bot.x,bot.goal.z-bot.y)<5){
    const h=bot.home||{x:32,z:32,radius:300};
    const a=Math.random()*Math.PI*2,r=Math.random()*h.radius*.72;
    bot.goal={x:h.x+Math.cos(a)*r,z:h.z+Math.sin(a)*r,until:now+7000+Math.random()*12000};
    bot.moving=Math.random()>.08;
  }
  const dt=Math.max(0.01,Math.min(0.08,Number(bot.frameDt)||0.05));
  const dx=bot.goal.x-bot.x,dz=bot.goal.z-bot.y,dist=Math.hypot(dx,dz);
  const speed=7.475;
  const desiredX=bot.moving&&dist>2?dx/dist*speed:0;
  const desiredY=bot.moving&&dist>2?dz/dist*speed:0;
  const response=Math.min(1,dt*7.5);
  bot.vx=(Number(bot.vx)||0)+(desiredX-(Number(bot.vx)||0))*response;
  bot.vy=(Number(bot.vy)||0)+(desiredY-(Number(bot.vy)||0))*response;
  if(Math.hypot(bot.vx,bot.vy)>.08){bot.x+=bot.vx*dt;bot.y+=bot.vy*dt;bot.angle=Math.atan2(bot.vx,bot.vy);}
  bot.safeZone=safeZoneAt(bot.x,bot.y,bot.elevation);
  bot.hp=Math.max(0,Math.min(200,bot.hp));
  if(now-(bot.lastBroadcast||0)>=80){bot.lastBroadcast=now;botBroadcastMove(roomId,bot);}
}
function botSocialThink(roomId,room,bot,now){
  if(now-bot.lastChat<65000+Math.random()*35000||now-room.lastBotChatAt<8500)return;
  const lines=['Essa parte da cidade tá movimentada hoje.','Vou dar uma volta e conhecer outras ruas.','Alguém sabe se tem carro livre por aqui?','Tô explorando, depois encontro vocês.','Cuidado com os tiros fora da praça.','A cidade é grande, sempre tem alguma coisa acontecendo.','Vou passar ali perto do centro.','Hoje vou ficar tranquilo e passear.'];
  bot.lastChat=now;room.lastBotChatAt=now;botSay(roomId,bot,lines[Math.floor(Math.random()*lines.length)]);
}
function botThinkCombatBots(roomId, room, bot, now) {
  if(safeZoneAt(bot.x,bot.y,bot.elevation))return;
  const others=room.bots.filter(o=>o!==bot&&o.active!==false&&!safeZoneAt(o.x,o.y,o.elevation));
  const rival=others.filter(o=>Math.hypot(o.x-bot.x,o.y-bot.y)<30).sort((a,b)=>Math.hypot(a.x-bot.x,a.y-bot.y)-Math.hypot(b.x-bot.x,b.y-bot.y))[0];
  if(rival&&Math.random()<.22){rival.hp=Math.max(0,rival.hp-10);io.to('srv_'+roomId).emit('player:damaged',{targetId:rival.id,attackerId:bot.id,attackerName:bot.name,dmg:10,hp:rival.hp,damageSource:'bot'});if(rival.hp<=0){rival.hp=200;rival.deaths=(rival.deaths||0)+1;bot.kills=(bot.kills||0)+1;io.to('srv_'+roomId).emit('player:eliminated',{targetId:rival.id,attackerId:bot.id,attackerName:bot.name,targetName:rival.name});botSay(roomId,bot,`Foi mal, ${rival.name}. Foi uma briga boba.`);}}
}
function botsApplyCount(room) {
  room.bots.forEach((b,i)=>{b.active=i<room.botTargetCount;});
  room.botsEnabled=room.botTargetCount>0;
}
function syncBotPresence(roomId, before) {
  const room=rooms[roomId];
  room.bots.forEach((b)=>{
    const was=before.has(b.id), now=b.active!==false;
    if(now&&!was)botBroadcastJoin(roomId,b);
    if(!now&&was)io.to('srv_'+roomId).emit('player:left',b.id);
  });
}
function autoBotCount(roomId, room) {
  const before=new Set(room.bots.filter(b=>b.active!==false).map(b=>b.id));
  const n=Object.keys(room.players).length;
  const capacityForBots=Math.max(0,Math.min(BOT_TOTAL_PER_ROOM,BOT_TOTAL_PER_ROOM-n));
  room.botTargetCount=room.botAuto?capacityForBots:Math.min(room.botTargetCount,capacityForBots);
  botsApplyCount(room);
  syncBotPresence(roomId,before);
}
function removePlayerFromRoom(socket, roomId) {
  const room=rooms[roomId]; if(!room)return;
  if(room.players[socket.id]) { delete room.players[socket.id]; socket.to('srv_'+roomId).emit('player:leave',socket.id); socket.to('srv_'+roomId).emit('player:left',socket.id); autoBotCount(roomId,room); }
  room.cars.forEach(car=>{if(car.driverId===socket.id){car.driverId=null;car.speed=0;car.abandonedAt=Date.now();io.to('srv_'+roomId).emit('car:update',car);io.to('srv_'+roomId).emit('cars:update',room.cars);}});
  socket.leave('srv_'+roomId);
}
function joinRoom(socket, nextRoomId) {
  const targetRoom=normalizeRoomId(nextRoomId),currentRoom=socket.data.roomId;
  if(currentRoom&&currentRoom!==targetRoom)removePlayerFromRoom(socket,currentRoom);
  const room=rooms[targetRoom],playerCount=Object.keys(room.players).length;
  if(!room.players[socket.id]&&playerCount>=MAX_HUMANS_PER_ROOM){const full={room:targetRoom,max:MAX_HUMANS_PER_ROOM,message:`Servidor cheio (${MAX_HUMANS_PER_ROOM}/${MAX_HUMANS_PER_ROOM} jogadores humanos). Escolha outro servidor.`};socket.emit('room:full',full);socket.emit('server:full',full);return;}
  socket.data.roomId=targetRoom;socket.join('srv_'+targetRoom);
  const clientKey=socket.data.clientKey||'';
  const playerId=stablePlayerId(clientKey,socket.data.name);
  room.players[socket.id]={id:socket.id,playerId,name:socket.data.name||('Player_'+socket.id.slice(0,4)),x:32,y:32,angle:0,inCarId:null,seatRole:'foot',elevation:0,look:{skin:1,shirt:0,pant:0,hair:0},weapon:0,hp:200,safeZone:false,verified:isVerified(playerId),damageDealt:0,damageReceived:0,kills:0,deaths:0};
  autoBotCount(targetRoom,room);
  const snapshot={room:targetRoom,players:combinedPlayers(room),cars:room.cars,chat:room.chat.slice(-15),botCount:room.bots.filter(b=>b.active!==false).length,humanCount:Object.keys(room.players).length};
  socket.emit('init',snapshot);socket.emit('world:init',snapshot);socket.emit('player:identity',{playerId,verified:isVerified(playerId),owner:isOwner(playerId),kills:killsFor(playerId),nameColor:persisted.nameColors[playerId]||0,unlockedColors:unlockedColorCount(killsFor(playerId)),vip:isVip(playerId),invulnerable:false,speedBoost:false});
  socket.to('srv_'+targetRoom).emit('player:join',publicHuman(room.players[socket.id]));socket.to('srv_'+targetRoom).emit('player:joined',publicHuman(room.players[socket.id]));
}

io.on('connection',socket=>{
  socket.data.name=String(socket.handshake.query&&socket.handshake.query.nick||('Player_'+socket.id.slice(0,4))).trim().slice(0,16)||('Player_'+socket.id.slice(0,4));
  socket.data.clientKey=String(socket.handshake.query&&socket.handshake.query.clientKey||'').slice(0,80);
  const initialRoom=normalizeRoomId(socket.handshake.query&&socket.handshake.query.server);
  const initialPlayerId=stablePlayerId(socket.data.clientKey,socket.data.name);
  if(persisted.banned[initialPlayerId]){socket.emit('server:banned',{message:'Sua conta está banida deste servidor.'});socket.disconnect(true);return;}
  joinRoom(socket,initialRoom);
  socket.on('room:select',choice=>joinRoom(socket,choice));
  
  socket.on('profile:request',payload=>{const id=String(payload&&payload.playerId||'').trim(),profile=profileById(id);if(!profile){socket.emit('profile:data',{error:'Perfil não encontrado.'});return;}let online=null;for(const rid of ['1','2']){const p=Object.values(rooms[rid].players).find(x=>x.playerId===id);if(p){online=p;break;}}socket.emit('profile:data',{playerId:id,name:profile.name,owner:isOwner(id),verified:isVerified(id),vip:isVip(id),kills:killsFor(id),deaths:Number(persisted.deaths[id])||0,damageDealt:Number(persisted.damage[id])||0,mvp:Number(persisted.mvp[id])||0,bio:persisted.bios[id]||''});});
  socket.on('profile:bio:update',payload=>{const room=rooms[socket.data.roomId||'1'],p=room&&room.players[socket.id];if(!p)return;persisted.bios[p.playerId]=String(payload&&payload.bio||'').trim().slice(0,100);saveData();socket.emit('profile:bio:saved',{ok:true});});
socket.on('owner:announce',payload=>{const roomId=socket.data.roomId||'1',pl=rooms[roomId].players[socket.id];if(!pl||!isOwner(pl.playerId))return;const message=String(payload&&payload.text||'').trim().slice(0,180);if(!message)return;const item={text:message,at:Date.now(),from:pl.name};io.emit('owner:announcement',item);logAdmin('Aviso global do dono',{playerId:pl.playerId,message});});
  const ownerCheck=()=>{const room=rooms[socket.data.roomId||'1'];const pl=room&&room.players[socket.id];return pl&&isOwner(pl.playerId)?pl:null;};
  socket.on('owner:panel:profile',payload=>{const owner=ownerCheck();if(!owner)return;const id=String(payload&&payload.playerId||'').trim();const profile=profileById(id);if(!profile){socket.emit('owner:profile:data',{error:'ID não encontrado. Peça para a pessoa criar a conta primeiro.'});return;}let online=null,roomFound=null;for(const rid of ['1','2']){const pl=Object.values(rooms[rid].players).find(x=>x.playerId===id);if(pl){online=pl;roomFound=rid;break;}}socket.emit('owner:profile:data',{playerId:id,name:profile.name,owner:isOwner(id),verified:isVerified(id),vip:isVip(id),online:!!online,room:roomFound,kills:killsFor(id),deaths:Number(persisted.deaths[id])||online?.deaths||0,damageDealt:Number(persisted.damage[id])||online?.damageDealt||0,mvp:Number(persisted.mvp[id])||0,bio:persisted.bios[id]||''});});
  socket.on('owner:panel:toggle-verify',payload=>{const owner=ownerCheck();if(!owner)return;const id=String(payload&&payload.playerId||'').trim();if(!profileById(id)){socket.emit('owner:panel:result',{message:'ID não encontrado.'});return;}const value=!isVerified(id);if(value)persisted.verified[id]=true;else delete persisted.verified[id];saveData();for(const rid of ['1','2'])for(const pl of Object.values(rooms[rid].players))if(pl.playerId===id){pl.verified=value;io.to('srv_'+rid).emit('player:verification',{playerId:id,verified:value});}socket.emit('owner:panel:result',{message:`${id}: ${value?'verificado':'selo removido'}.`});});
  socket.on('owner:panel:toggle-vip',payload=>{const owner=ownerCheck();if(!owner)return;const id=String(payload&&payload.playerId||'').trim();if(!profileById(id)){socket.emit('owner:panel:result',{message:'ID não encontrado.'});return;}const value=!isVip(id);if(value)persisted.vips[id]=true;else delete persisted.vips[id];saveData();for(const rid of ['1','2'])for(const pl of Object.values(rooms[rid].players))if(pl.playerId===id)io.to('srv_'+rid).emit('player:vip',{playerId:id,vip:value});socket.emit('owner:panel:result',{message:`${id}: VIP ${value?'ativado':'retirado'}.`});});
  socket.on('owner:panel:pull',payload=>{const owner=ownerCheck();if(!owner)return;const id=String(payload&&payload.playerId||'').trim();let target=null,targetRoom=null;for(const rid of ['1','2']){const pl=Object.values(rooms[rid].players).find(x=>x.playerId===id);if(pl){target=pl;targetRoom=rid;break;}}if(!target){socket.emit('owner:panel:result',{message:'Jogador não está online.'});return;}const ownerRoom=socket.data.roomId||'1';if(targetRoom!==ownerRoom){const targetSocket=io.sockets.sockets.get(target.id);if(targetSocket)joinRoom(targetSocket,ownerRoom);if(!targetSocket||targetSocket.data.roomId!==ownerRoom){socket.emit('owner:panel:result',{message:'Não foi possível puxar: o servidor de destino está cheio.'});return;}}target=rooms[ownerRoom].players[target.id]||target;target.x=owner.x+3;target.y=owner.y+3;target.elevation=owner.elevation||0;io.to('srv_'+ownerRoom).emit('player:moved',publicHuman(target));socket.emit('owner:panel:result',{message:`${target.name} foi puxado até você.`});});
  socket.on('owner:panel:invulnerable',payload=>{const pl=ownerCheck();if(!pl)return;pl.invulnerable=!!(payload&&payload.enabled);socket.emit('owner:state',{invulnerable:pl.invulnerable,speedBoost:!!pl.speedBoost});});
  socket.on('owner:panel:speed',payload=>{const pl=ownerCheck();if(!pl)return;pl.speedBoost=!!(payload&&payload.enabled);socket.emit('owner:state',{invulnerable:!!pl.invulnerable,speedBoost:pl.speedBoost});});
  socket.on('owner:panel:bots',payload=>{if(!ownerCheck())return;const rid=normalizeRoomId(payload&&payload.room),room=rooms[rid],n=Math.max(0,Math.min(BOT_TOTAL_PER_ROOM,Math.floor(Number(payload&&payload.count)||0))),before=new Set(room.bots.filter(b=>b.active!==false).map(b=>b.id));room.botAuto=false;if(payload.action==='add')room.botTargetCount=Math.min(BOT_TOTAL_PER_ROOM,room.botTargetCount+n);else if(payload.action==='remove')room.botTargetCount=Math.max(0,room.botTargetCount-n);else room.botTargetCount=n;botsApplyCount(room);syncBotPresence(rid,before);socket.emit('owner:panel:result',{message:`Servidor ${rid}: ${room.botTargetCount} bots ativos.`});});
  socket.on('ranking:request',payload=>{const scope=String(payload&&payload.scope||'global');const rows=Object.values(persisted.players).map(p=>{const id=p.id;let kills=scope==='1'||scope==='2'?(Number((persisted.roomKills[scope]||{})[id])||0):killsFor(id);let server=null;if(scope==='global'){const a=Number((persisted.roomKills['1']||{})[id])||0,b=Number((persisted.roomKills['2']||{})[id])||0;server=a>=b?'1':'2';}return {id,name:p.name,kills,server,vip:isVip(id),owner:isOwner(id)};}).filter(r=>r.kills>0).sort((a,b)=>b.kills-a.kills).slice(0,30);socket.emit('ranking:data',{scope,rows});});

  socket.on('player:name-color',payload=>{const roomId=socket.data.roomId||'1',pl=rooms[roomId].players[socket.id];if(!pl)return;const idx=Math.floor(Number(payload&&payload.index));const unlocked=unlockedColorCount(killsFor(pl.playerId));if(!Number.isInteger(idx)||idx<0||idx>=unlocked||idx>=50)return;persisted.nameColors[pl.playerId]=idx;saveData();io.to('srv_'+roomId).emit('player:moved',publicHuman(pl));socket.emit('player:identity',{playerId:pl.playerId,verified:isVerified(pl.playerId),owner:isOwner(pl.playerId),kills:killsFor(pl.playerId),nameColor:idx,unlockedColors:unlocked});});
  socket.on('player:join',data=>{
    if(data&&typeof data.name==='string'&&data.name.trim())socket.data.name=data.name.trim().slice(0,16);
    if(data&&typeof data.clientKey==='string')socket.data.clientKey=data.clientKey.slice(0,80);
    const roomId=socket.data.roomId||initialRoom,room=rooms[roomId],p=room&&room.players[socket.id];if(!p)return;
    p.playerId=stablePlayerId(socket.data.clientKey,p.name);p.verified=isVerified(p.playerId);
    if(data&&Number.isFinite(data.x))p.x=data.x;if(data&&Number.isFinite(data.y))p.y=data.y;if(data&&Number.isFinite(data.angle))p.angle=data.angle;
    if(data&&data.look&&typeof data.look==='object')p.look=data.look;if(data&&typeof data.weapon==='number')p.weapon=data.weapon;if(data&&Number.isFinite(data.hp))p.hp=Math.max(0,Math.min(200,data.hp));
    p.safeZone=safeZoneAt(p.x,p.y,p.elevation);
    p.safeZone=safeZoneAt(p.x,p.y,p.elevation);
    socket.emit('player:identity',{playerId:p.playerId,verified:p.verified,owner:isOwner(p.playerId),kills:killsFor(p.playerId),nameColor:persisted.nameColors[p.playerId]||0,unlockedColors:unlockedColorCount(killsFor(p.playerId)),vip:isVip(p.playerId)});
    socket.to('srv_'+roomId).emit('player:moved',publicHuman(p));
  });
  socket.on('player:move',data=>{
    const roomId=socket.data.roomId||'1',room=rooms[roomId];if(!room||!data)return;const p=room.players[socket.id];if(!p)return;
    if(Number.isFinite(data.x))p.x=data.x;if(Number.isFinite(data.y))p.y=data.y;if(Number.isFinite(data.angle))p.angle=data.angle;
    p.inCarId=data.inCarId||null;p.seatRole=data.seatRole||'foot';if(Number.isFinite(data.elevation))p.elevation=data.elevation;
    if(data.look&&typeof data.look==='object')p.look={skin:Number(data.look.skin)||0,shirt:Number(data.look.shirt)||0,pant:Number(data.look.pant)||0,hair:Number(data.look.hair)||0};
    if(typeof data.weapon==='number')p.weapon=data.weapon;if(Number.isFinite(data.hp))p.hp=Math.max(0,Math.min(200,data.hp));p.safeZone=safeZoneAt(p.x,p.y,p.elevation);
    socket.to('srv_'+roomId).emit('player:move',publicHuman(p));socket.to('srv_'+roomId).emit('player:moved',publicHuman(p));
  });
  socket.on('player:shoot',data=>{const roomId=socket.data.roomId||'1';const p=rooms[roomId].players[socket.id];if(!p||!data||safeZoneAt(p.x,p.y,p.elevation))return;const shot={id:socket.id,playerId:p.playerId,x:data.x,y:data.y,angle:data.angle,range:Math.min(120,Number(data.range)||45),dmg:Math.min(120,Number(data.dmg)||20)};socket.to('srv_'+roomId).emit('player:shoot',shot);socket.to('srv_'+roomId).emit('player:shot',shot);});
  socket.on('player:hit',data=>{
    const roomId=socket.data.roomId||'1',room=rooms[roomId];if(!room||!data||!data.targetId)return;const attacker=room.players[socket.id];if(!attacker)return;
    const targetHuman=room.players[data.targetId],targetBot=room.bots.find(b=>b.id===data.targetId&&b.active!==false),target=targetHuman||targetBot;if(!target)return;if(targetHuman&&isOwner(targetHuman.playerId)&&targetHuman.invulnerable){socket.emit('combat:blocked',{reason:'invulnerable'});return;}
    if(safeZoneAt(attacker.x,attacker.y,attacker.elevation)||safeZoneAt(target.x,target.y,target.elevation)){socket.emit('combat:blocked',{reason:'safe_zone'});return;}
    const dist=Math.hypot(attacker.x-target.x,attacker.y-target.y);if(dist>125)return;const weaponIndex=Math.floor(Number(attacker.weapon));const weaponMax=[26,11,18,22,120][weaponIndex]||20;const amount=Math.max(1,Math.min(weaponMax,Number(data.dmg)||20)),oldHp=typeof target.hp==='number'?target.hp:200,nextHp=Math.max(0,oldHp-amount);target.hp=nextHp;attacker.damageDealt=(attacker.damageDealt||0)+amount;
    if(targetHuman)targetHuman.damageReceived=(targetHuman.damageReceived||0)+amount;persisted.damage[attacker.playerId]=(Number(persisted.damage[attacker.playerId])||0)+amount;
    io.to('srv_'+roomId).emit('player:damaged',{targetId:data.targetId,attackerId:socket.id,attackerName:attacker.name||socket.data.name,dmg:amount,hp:nextHp,damageSource:'human',damageDealt:attacker.damageDealt,damageReceived:target.damageReceived||0});
    if(nextHp<=0){target.hp=200;target.deaths=(target.deaths||0)+1;if(targetHuman)persisted.deaths[targetHuman.playerId]=(Number(persisted.deaths[targetHuman.playerId])||0)+1;attacker.kills=(attacker.kills||0)+1;persisted.kills[attacker.playerId]=killsFor(attacker.playerId)+1;if(!persisted.roomKills[roomId])persisted.roomKills[roomId]={};const previousOwnRoomKills=Number(persisted.roomKills[roomId][attacker.playerId])||0;persisted.roomKills[roomId][attacker.playerId]=previousOwnRoomKills+1;const previousTop=Math.max(0,...Object.entries(persisted.roomKills[roomId]).filter(([id])=>id!==attacker.playerId).map(([,v])=>Number(v)||0));if(previousOwnRoomKills<=previousTop&&persisted.roomKills[roomId][attacker.playerId]>previousTop)persisted.mvp[attacker.playerId]=(Number(persisted.mvp[attacker.playerId])||0)+1;saveData();io.to(attacker.id).emit('player:progress',{kills:killsFor(attacker.playerId),unlockedColors:unlockedColorCount(killsFor(attacker.playerId)),nameColor:persisted.nameColors[attacker.playerId]||0});io.to('srv_'+roomId).emit('player:eliminated',{targetId:data.targetId,attackerId:socket.id,attackerName:attacker.name,targetName:target.name||target.id});}
  });
  socket.on('voice:signal',payload=>{const roomId=socket.data.roomId||'1',room=rooms[roomId];if(!room||!payload||typeof payload.to!=='string'||!room.players[payload.to]||!payload.signal||!['offer','answer','ice'].includes(payload.type))return;io.to(payload.to).emit('voice:signal',{from:socket.id,type:payload.type,signal:payload.signal});});
  socket.on('car:toggle',()=>{const roomId=socket.data.roomId||'1',room=rooms[roomId];if(!room)return;const existing=room.cars.find(c=>c.driverId===socket.id);if(existing){existing.driverId=null;existing.speed=0;existing.abandonedAt=Date.now();if(room.players[socket.id])room.players[socket.id].inCarId=null;io.to('srv_'+roomId).emit('car:update',existing);io.to('srv_'+roomId).emit('cars:update',room.cars);return;}const p=room.players[socket.id];if(!p)return;let nearest=null,best=18;for(const car of room.cars){if(car.driverId&&car.driverId!==socket.id)continue;const d=Math.hypot(car.x-p.x,car.y-p.y);if(d<best){best=d;nearest=car;}}if(nearest){nearest.driverId=socket.id;nearest.abandonedAt=null;nearest.lastDrivenAt=Date.now();p.inCarId=nearest.id;io.to('srv_'+roomId).emit('car:update',nearest);io.to('srv_'+roomId).emit('cars:update',room.cars);}});
  socket.on('car:drive',data=>{const roomId=socket.data.roomId||'1',room=rooms[roomId];if(!room||!data||!data.id)return;const car=room.cars.find(c=>c.id===data.id);if(!car||car.driverId&&car.driverId!==socket.id)return;car.driverId=socket.id;car.abandonedAt=null;car.lastDrivenAt=Date.now();['x','y','angle','speed','altitude','pitch','roll'].forEach(k=>{if(Number.isFinite(data[k]))car[k]=data[k];});socket.to('srv_'+roomId).emit('car:drive',car);socket.to('srv_'+roomId).emit('cars:update',room.cars);});
  const handleChat=payload=>{const roomId=socket.data.roomId||'1',room=rooms[roomId],p=room&&room.players[socket.id];if(!p||!payload||typeof payload.text!=='string')return;const text=payload.text.trim().slice(0,110);if(!text)return;const msg={id:socket.id,playerId:p.playerId,name:p.name,text,verified:p.verified};room.chat.push(msg);room.chat=room.chat.slice(-30);io.to('srv_'+roomId).emit('chat:msg',msg);io.to('srv_'+roomId).emit('chat:message',msg);chatWithBots(roomId,p,text);};socket.on('chat:msg',handleChat);socket.on('chat:send',handleChat);
  socket.on('disconnect',()=>removePlayerFromRoom(socket,socket.data.roomId||initialRoom));
});

// Persiste estatísticas acumuladas de dano sem gravar o disco a cada disparo.
setInterval(()=>{try{saveData();}catch(e){console.error('Falha ao salvar estatísticas:',e.message);}},30000);

// AI update loop: light server-side movement/decision updates, never runs on the players' phones.
setInterval(()=>{const now=Date.now();for(const roomId of ['1','2']){const room=rooms[roomId];if(!room.botsEnabled)continue;for(const bot of room.bots){if(bot.active!==false){bot.frameDt=0.05;botThink(roomId,bot,room,now);}}}},50);

// Veículos abandonados retornam ao ponto original após 40 segundos.
// Sair da cidade, sozinho, não inicia o retorno.
setInterval(()=>{
  const now=Date.now();
  for(const roomId of ['1','2']){
    const room=rooms[roomId];
    let changed=false;
    for(const car of room.cars){
      if(car.driverId||!car.abandonedAt||now-car.abandonedAt<40000)continue;
      const spawn=car.spawn||{x:car.x,y:car.y,angle:car.angle};
      car.x=spawn.x;car.y=spawn.y;car.angle=spawn.angle;
      car.speed=0;car.altitude=0;car.pitch=0;car.roll=0;
      car.driverId=null;car.abandonedAt=null;car.lastDrivenAt=0;
      changed=true;
    }
    if(changed)io.to('srv_'+roomId).emit('cars:update',room.cars);
  }
},1000);

// Admin API
app.get('/api/admin/status',requireAdmin,(_req,res)=>res.json({ok:true,ownerId:persisted.ownerId,uptime:Math.floor(process.uptime()),rooms:Object.fromEntries(['1','2'].map(id=>{const r=rooms[id];return[id,{humans:Object.keys(r.players).length,bots:r.bots.filter(b=>b.active!==false).length,botTargetCount:r.botTargetCount,botAuto:r.botAuto,capacity:MAX_HUMANS_PER_ROOM,cars:r.cars.length}]})),restart:readJson(RESTART_FILE,null)}));
app.get('/api/admin/players',requireAdmin,(_req,res)=>{const list=[];for(const roomId of ['1','2']){const r=rooms[roomId];Object.values(r.players).forEach(p=>list.push({room:roomId,id:p.playerId,socketId:p.id,name:p.name,verified:p.verified,hp:p.hp,damageDealt:p.damageDealt,damageReceived:p.damageReceived,kills:p.kills,deaths:p.deaths,online:true}));r.bots.filter(b=>b.active!==false).forEach(b=>list.push({room:roomId,id:b.id,socketId:b.id,name:b.name,verified:false,hp:b.hp,isBot:true,online:true}));}res.json({ok:true,players:list,profiles:Object.values(persisted.players).map(p=>({id:p.id,name:p.name,firstSeen:p.firstSeen,verified:isVerified(p.id),vip:isVip(p.id),owner:isOwner(p.id),kills:killsFor(p.id),mvp:Number(persisted.mvp[p.id])||0,deaths:Number(persisted.deaths[p.id])||0,damageDealt:Number(persisted.damage[p.id])||0,banned:!!persisted.banned[p.id],online:list.some(x=>x.id===p.id)}))});});
app.post('/api/admin/owner',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();if(!/^DX-\d{6}$/.test(id)||!profileById(id))return res.status(400).json({ok:false,error:'ID permanente não encontrado. Crie a conta no jogo primeiro.'});const grant=!!(req.body&&req.body.owner);const previous=persisted.ownerId;if(grant)persisted.ownerId=id;else if(persisted.ownerId===id)persisted.ownerId=null;else return res.status(400).json({ok:false,error:'Esse ID não é o dono atual.'});saveData();for(const roomId of ['1','2']){const room=rooms[roomId];for(const pl of Object.values(room.players)){if(pl.playerId===id||pl.playerId===previous){pl.invulnerable=false;pl.speedBoost=false;io.to(pl.id).emit('player:identity',{playerId:pl.playerId,verified:isVerified(pl.playerId),owner:isOwner(pl.playerId),kills:killsFor(pl.playerId),nameColor:persisted.nameColors[pl.playerId]||0,unlockedColors:unlockedColorCount(killsFor(pl.playerId)),vip:isVip(pl.playerId),invulnerable:false,speedBoost:false});io.to('srv_'+roomId).emit('player:moved',publicHuman(pl));}}}logAdmin(grant?'Dono definido':'Dono removido',{playerId:id,previousOwner:previous});res.json({ok:true,ownerId:persisted.ownerId});});
app.post('/api/admin/announce',requireAdmin,(req,res)=>{const message=String(req.body&&req.body.message||'').trim().slice(0,180);if(!message)return res.status(400).json({ok:false,error:'Digite um aviso.'});const payload={text:message,at:Date.now(),from:'DISTRITO X'};io.emit('owner:announcement',payload);logAdmin('Aviso global enviado',{message});res.json({ok:true});});
app.post('/api/admin/vip',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();if(!/^DX-\d{6}$/.test(id)||!profileById(id))return res.status(400).json({ok:false,error:'ID permanente não encontrado.'});const vip=!!(req.body&&req.body.vip);if(vip)persisted.vips[id]=true;else delete persisted.vips[id];saveData();for(const roomId of ['1','2'])for(const pl of Object.values(rooms[roomId].players))if(pl.playerId===id)io.to('srv_'+roomId).emit('player:vip',{playerId:id,vip});logAdmin(vip?'VIP concedido':'VIP retirado',{playerId:id});res.json({ok:true,playerId:id,vip});});
app.post('/api/admin/verify',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();if(!/^DX-\d{6}$/.test(id))return res.status(400).json({ok:false,error:'ID permanente inválido.'});const value=!!(req.body&&req.body.verified);persisted.verified[id]=value;if(!value)delete persisted.verified[id];saveData();for(const roomId of ['1','2']){const room=rooms[roomId];for(const p of Object.values(room.players)){if(p.playerId===id){p.verified=value;io.to('srv_'+roomId).emit('player:verification',{playerId:id,verified:value});}}}logAdmin(value?'Verificado concedido':'Verificado retirado',{playerId:id});res.json({ok:true,playerId:id,verified:value});});
app.post('/api/admin/kick',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();let found=null;for(const roomId of ['1','2']){const room=rooms[roomId];const p=Object.values(room.players).find(p=>p.playerId===id);if(p){found={room:roomId,socketId:p.id,name:p.name};break;}}if(!found)return res.status(404).json({ok:false,error:'Jogador não está online.'});const target=io.sockets.sockets.get(found.socketId);if(target)target.disconnect(true);logAdmin('Jogador expulso',{playerId:id,room:found.room});res.json({ok:true,playerId:id});});
app.post('/api/admin/ban',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();if(!/^DX-\d{6}$/.test(id))return res.status(400).json({ok:false,error:'ID permanente inválido.'});persisted.banned[id]=true;saveData();for(const roomId of ['1','2']){const p=Object.values(rooms[roomId].players).find(p=>p.playerId===id);if(p){const target=io.sockets.sockets.get(p.id);if(target)target.disconnect(true);}}logAdmin('Jogador banido',{playerId:id});res.json({ok:true,playerId:id,banned:true});});
app.post('/api/admin/unban',requireAdmin,(req,res)=>{const id=String(req.body&&req.body.playerId||'').trim();delete persisted.banned[id];saveData();logAdmin('Ban removido',{playerId:id});res.json({ok:true,playerId:id,banned:false});});
app.get('/api/admin/bans',requireAdmin,(_req,res)=>res.json({ok:true,bans:Object.keys(persisted.banned)}));
app.post('/api/admin/bots',requireAdmin,(req,res)=>{const roomId=normalizeRoomId(req.body&&req.body.room),room=rooms[roomId];const count=Math.max(0,Math.min(BOT_TOTAL_PER_ROOM,Math.floor(Number(req.body&&req.body.count)||0)));const before=new Set(room.bots.filter(b=>b.active!==false).map(b=>b.id));room.botAuto=false;room.botTargetCount=count;botsApplyCount(room);syncBotPresence(roomId,before);logAdmin('Controle de bots manual',{room:roomId,count});res.json({ok:true,room:roomId,bots:count,auto:false});});
app.post('/api/admin/bot-auto',requireAdmin,(req,res)=>{const roomId=normalizeRoomId(req.body&&req.body.room),room=rooms[roomId];const before=new Set(room.bots.filter(b=>b.active!==false).map(b=>b.id));room.botAuto=!!(req.body&&req.body.enabled);if(room.botAuto)autoBotCount(roomId,room);else botsApplyCount(room);if(!room.botAuto)syncBotPresence(roomId,before);logAdmin('Automação de bots alterada',{room:roomId,enabled:room.botAuto,target:room.botTargetCount});res.json({ok:true,room:roomId,enabled:room.botAuto,bots:room.botTargetCount});});
app.post('/api/admin/restart',requireAdmin,(req,res)=>{const minutes=Math.max(0,Math.min(1440,Number(req.body&&req.body.minutes)||0));if(minutes<=0)return res.status(400).json({ok:false,error:'Informe um prazo de reinício válido.'});const when=Date.now()+minutes*60000;writeJsonAtomic(RESTART_FILE,{at:when,minutes,createdAt:Date.now()});if(restartTimer)clearTimeout(restartTimer);restartTimer=setTimeout(()=>{try{fs.unlinkSync(RESTART_FILE);}catch(_){}console.log('Reinício agendado solicitado pelo painel ADM.');process.exit(1);},Math.max(0,when-Date.now()));logAdmin('Reinício agendado',{minutes,at:when});res.json({ok:true,at:when,minutes});});
app.post('/api/admin/restart-cancel',requireAdmin,(_req,res)=>{try{fs.unlinkSync(RESTART_FILE);}catch(_){}if(restartTimer){clearTimeout(restartTimer);restartTimer=null;}logAdmin('Reinício cancelado',{});res.json({ok:true});});
app.get('/api/admin/log',requireAdmin,(_req,res)=>res.json({ok:true,logs:persisted.adminLog.slice(0,50)}));
let restartTimer=null;
function schedulePersistedRestart(){const schedule=readJson(RESTART_FILE,null);if(!schedule||!schedule.at)return;const delay=Math.max(0,schedule.at-Date.now());restartTimer=setTimeout(()=>{try{fs.unlinkSync(RESTART_FILE);}catch(_){}console.log('Reinício agendado solicitado pelo painel ADM.');process.exit(1);},delay);}
schedulePersistedRestart();

server.listen(PORT,()=>console.log(`Distrito X City Server online na porta ${PORT}. IDs, bots e API ADM ativos.`));
