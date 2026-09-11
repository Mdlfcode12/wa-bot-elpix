import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWhatsApp, isReady, toJid, forceRelogin } from './client.js';
import { initSchema, pool } from './authState.js';
import { initSettings, setFlag, getStatus, pauseChat, resumeChat } from './state.js';
import { initMessages, listConversations, getThread } from './messages.js';
import { initQuota, remainingToday, usedToday } from './quota.js';
import { bus, emit } from './events.js';
import { handleIncoming, queue, replyAs } from './inbound.js';
import { runCampaign } from './sender.js';
import { generateDailyReport, scheduleDailyReport } from './report.js';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

/**
 * Sesi berbasis cookie, bukan kunci di setiap request.
 * Alasannya teknis: EventSource (SSE) tidak bisa mengirim header custom,
 * jadi kalau pakai x-api-key, feed langsung harus menaruh kunci di URL —
 * dan URL bocor ke log server serta riwayat browser. Cookie httpOnly tidak.
 */
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 60 * 60 * 1000;

/**
 * Express 4 TIDAK menangkap rejection dari handler async: kalau database putus
 * sesaat, rejection-nya lolos ke process dan Node 20 mematikan proses. Setiap
 * restart memutus WebSocket WhatsApp, jadi satu query gagal tidak boleh
 * berarti sesi terputus. Pembungkus ini meneruskan error ke error handler.
 */
const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const parseCookies = (h = '') =>
  Object.fromEntries(h.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));

function auth(req, res, next) {
  const token = parseCookies(req.get('cookie')).sid;
  const exp = token && sessions.get(token);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/admin/login', (req, res) => {
  const key = String(req.body?.key || '');
  const expected = process.env.ADMIN_KEY || '';
  // Tanpa penjagaan ini, ADMIN_KEY yang lupa diisi membuat panel terbuka
  // untuk siapa pun yang mengirim string kosong.
  if (expected.length < 16) {
    console.error('[admin] ADMIN_KEY kosong atau kurang dari 16 karakter. Login ditolak.');
    return res.status(500).json({ error: 'ADMIN_KEY belum diatur dengan benar di server' });
  }
  const ok =
    key.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'Kunci salah' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.cookie?.('sid', token);
  res.setHeader(
    'Set-Cookie',
    `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${
      process.env.NODE_ENV === 'production' ? '; Secure' : ''
    }`
  );
  res.json({ ok: true });
});

app.post('/admin/logout', auth, (req, res) => {
  sessions.delete(parseCookies(req.get('cookie')).sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

/**
 * Health check harus benar-benar menguji dependensi. Versi yang selalu
 * menjawab "ok" membuat platform hosting mengira semuanya sehat padahal
 * database sudah mati — persis saat kamu paling butuh tahu.
 */
app.get('/health', a(async (_req, res) => {
  let db = false;
  try {
    await pool.query('SELECT 1');
    db = true;
  } catch (e) {
    console.error('[health] database tidak merespons:', e.message);
  }
  const sehat = db; // WhatsApp boleh sedang reconnect, itu normal dan sementara
  res.status(sehat ? 200 : 503).json({
    ok: sehat,
    database: db ? 'ok' : 'down',
    whatsapp: isReady() ? 'connected' : 'disconnected',
  });
}));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'panel.html')));

// ---------- Feed langsung ----------
app.get('/admin/stream', auth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', send);

  // Ping supaya proxy tidak memutus koneksi idle.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

// ---------- Baca ----------
app.get('/admin/status', auth, a(async (_req, res) =>
  res.json({
    ...(await getStatus()),
    whatsapp: isReady(),
    queued: queue.size(),
    ai_used_today: await usedToday(),
    ai_left_today: await remainingToday(),
  })
));
app.get('/admin/conversations', auth, a(async (_req, res) => res.json(await listConversations())));
app.get('/admin/thread', auth, a(async (req, res) => res.json(await getThread(req.query.jid))));

// ---------- Kontrol ----------
app.post('/admin/ai', auth, a(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  await setFlag('ai_enabled', enabled, 'panel');
  const dropped = enabled ? 0 : queue.clearAll();
  emit('flags', { ai_enabled: enabled, dropped });
  console.log(`[admin] AI ${enabled ? 'ON' : 'OFF'}${dropped ? `, ${dropped} balasan dibatalkan` : ''}`);
  res.json({ ai_enabled: enabled, dropped });
}));

app.post('/admin/campaign', auth, a(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  await setFlag('campaign_enabled', enabled, 'panel');
  emit('flags', { campaign_enabled: enabled });
  res.json({ campaign_enabled: enabled });
}));

app.post('/admin/pause', auth, a(async (req, res) => {
  await pauseChat(req.body.jid, req.body.reason || 'diambil alih', 'panel');
  queue.clear(req.body.jid);
  emit('paused', { jid: req.body.jid });
  res.json({ ok: true });
}));

app.post('/admin/resume', auth, a(async (req, res) => {
  await resumeChat(req.body.jid, 'panel');
  emit('resumed', { jid: req.body.jid });
  res.json({ ok: true });
}));

/**
 * Balas manual dari panel. Ini yang menggantikan "buka WhatsApp di HP".
 * Mengirim lewat chat yang dipause akan otomatis mempausenya dulu —
 * supaya AI tidak ikut menyahut di tengah kamu mengetik.
 */
app.post('/admin/send', auth, a(async (req, res) => {
  const { jid, text } = req.body || {};
  if (!jid || !text?.trim()) return res.status(400).json({ error: 'jid dan text wajib' });
  if (!isReady()) return res.status(503).json({ error: 'WhatsApp belum tersambung' });

  await pauseChat(jid, 'diambil alih', 'panel');
  queue.clear(jid);
  await replyAs(jid, 'human', text.trim());
  res.json({ ok: true });
}));

app.post('/admin/new-chat', auth, a(async (req, res) => {
  const jid = toJid(req.body?.phone || '');
  const text = String(req.body?.text || '').trim();
  if (!jid || !text) return res.status(400).json({ error: 'phone dan text wajib' });
  await pauseChat(jid, 'diambil alih', 'panel');
  await replyAs(jid, 'human', text);
  res.json({ ok: true, jid });
}));

app.post('/campaign/run', auth, (_req, res) => {
  runCampaign()
    .then((r) => { console.log('[campaign] selesai', r); emit('campaign', r); })
    .catch((e) => console.error('[campaign]', e));
  res.json({ started: true });
});

/**
 * Re-login WhatsApp: hapus sesi di DB, lalu reconnect.
 * Panel akan otomatis menampilkan QR lewat SSE (event wa_qr).
 */
app.post('/admin/wa-logout', auth, a(async (_req, res) => {
  try {
    forceRelogin().catch((e) => console.error('[WA] re-login gagal:', e.message));
    res.json({ ok: true, message: 'Sesi dihapus. Scan QR baru yang muncul di panel.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

app.post('/admin/report', auth, (_req, res) => {
  generateDailyReport()
    .then((r) => { console.log('[report] manual:', r); emit('report', r); })
    .catch((e) => { console.error('[report]', e); emit('error', { message: 'Laporan gagal: ' + e.message }); });
  res.json({ started: true });
});

/**
 * Error handler terakhir. Empat argumen wajib — itu yang membuat Express
 * mengenalinya sebagai error handler, bukan middleware biasa.
 */
app.use((err, _req, res, _next) => {
  console.error('[http] error tak tertangani:', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Terjadi kesalahan di server' });
});

/**
 * Buang token sesi yang sudah kadaluarsa. Tanpa ini Map tumbuh terus
 * selama proses hidup — kecil, tapi tidak ada alasan membiarkannya.
 */
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60 * 60 * 1000).unref();

async function main() {
  await initSchema();
  await initSettings();
  await initMessages();
  await initQuota();
  await startWhatsApp(handleIncoming);
  scheduleDailyReport();
  const server = app.listen(config.port, () => console.log(`[http] panel di :${config.port}`));

  /**
   * Shutdown rapi. Docker dan PM2 mengirim SIGTERM lalu menunggu; kalau proses
   * mati seketika, pesan yang masih menunggu di debounce 4 detik hilang tanpa
   * jejak — pelanggan melihat pesannya dibaca tapi tidak pernah dibalas.
   * Jeda singkat memberi antrean kesempatan menyelesaikan giliran terakhir.
   */
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`[exit] ${signal} diterima, menutup dengan rapi…`);
    server.close();
    const menunggu = queue.size();
    if (menunggu) {
      console.log(`[exit] menunggu ${menunggu} balasan di antrean (maks 10 detik)…`);
      const batas = Date.now() + 10_000;
      while (queue.size() && Date.now() < batas) await new Promise((r) => setTimeout(r, 500));
    }
    await pool.end().catch(() => {});
    console.log('[exit] selesai.');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Jaring pengaman terakhir. Dicatat, tidak mematikan proses: koneksi WhatsApp
 * jauh lebih mahal untuk dibangun ulang daripada satu operasi yang gagal.
 * Kalau sesuatu benar-benar rusak, PM2 max_memory_restart yang menanganinya.
 */
process.on('unhandledRejection', (e) => console.error('[proses] rejection tak tertangani:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[proses] exception tak tertangani:', e?.message || e));

main().catch((e) => { console.error('Gagal start:', e); process.exit(1); });
