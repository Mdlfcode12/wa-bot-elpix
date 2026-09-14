import fs from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { usePostgresAuthState, pool } from './authState.js';
import { config } from './config.js';
import { emit } from './events.js';
import { DriveMediaRepository } from './repositories/driveMedia.repository.js';
import { DriveMediaService } from './services/driveMedia.service.js';

const driveRepository = new DriveMediaRepository(pool);
const driveService = new DriveMediaService({ repository: driveRepository });
driveRepository.initSchema().catch((err) => console.error('[DriveCache] Gagal init schema:', err.message));

const logger = pino({ level: 'fatal' });

/**
 * CACHE PESAN TERKIRIM — perbaikan "Waiting for this message".
 *
 * Kalau HP penerima gagal mendekripsi (sesi Signal basi, pre-key habis,
 * penerima ganti HP), WhatsApp TIDAK menyerah: HP itu mengirim "retry receipt"
 * ke kita, artinya "kirim ulang pesan id X, sesi kita rusak".
 *
 * Baileys menangani itu otomatis, TAPI ia perlu isi pesan aslinya kembali —
 * lewat callback getMessage. Bawaannya selalu mengembalikan undefined, jadi
 * Baileys mencatat 'recv retry request, but message not available' dan pesan
 * itu tidak pernah dikirim ulang. Di HP penerima tulisannya menggantung
 * selamanya. assertSessions saja tidak menutup ini: ia mencegah sebagian
 * kasus di awal, tapi tidak bisa menjawab permintaan kirim ulang.
 *
 * 300 pesan terakhir cukup: retry receipt datang dalam hitungan detik sampai
 * beberapa menit, bukan berjam-jam. Disimpan di memori, bukan database —
 * kalau proses restart, sesi Signal-nya juga dibangun ulang.
 */
const MAX_CACHE = 300;
const sentMessages = new Map(); // id -> isi pesan

function cacheSent(id, message) {
  if (!id || !message) return;
  sentMessages.set(id, message);
  if (sentMessages.size > MAX_CACHE) {
    // Map menjaga urutan sisip, jadi kunci pertama adalah yang paling lama.
    sentMessages.delete(sentMessages.keys().next().value);
  }
}
let sock = null;
let ready = false;
let _onMessage = null;

/**
 * Penjaga reconnect. Tanpa ini, setiap event 'close' menjadwalkan startWhatsApp()
 * baru tanpa membatalkan yang sudah dijadwalkan — jaringan yang naik-turun
 * menghasilkan beberapa socket paralel, dan pelanggan menerima balasan ganda
 * dari satu pesan. Satu percobaan reconnect saja yang boleh hidup.
 */
let reconnectTimer = null;
let connecting = false;

function scheduleReconnect(waitMs) {
  if (reconnectTimer) return;              // sudah ada yang antre
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch((e) => {
      console.error('[WA] reconnect gagal:', e.message);
      scheduleReconnect(15_000);
    });
  }, waitMs);
}

export const getSock = () => sock;
export const isReady = () => ready;

export async function startWhatsApp(onMessage) {
  if (onMessage) _onMessage = onMessage; // simpan agar bisa dipakai ulang saat reconnect
  if (connecting) {
    console.warn('[WA] Koneksi lain sedang dibangun, permintaan ini diabaikan.');
    return sock;
  }
  connecting = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Socket lama harus dilepas listener-nya, kalau tidak handler-nya menumpuk
  // dan satu pesan masuk diproses sekali per socket yang pernah dibuat.
  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end?.(); } catch { /* sudah mati */ }
  }
  // Dua panggilan ini bisa gagal (database atau jaringan). Kalau dibiarkan
  // melempar, flag connecting tersangkut di true dan bot tidak pernah
  // mencoba reconnect lagi — mati diam-diam sampai ada yang menyadarinya.
  let state, saveCreds, clearSession, version;
  try {
    ({ state, saveCreds, clearSession } = await usePostgresAuthState());
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    connecting = false;
    console.error('[WA] Gagal menyiapkan koneksi:', e.message);
    scheduleReconnect(15_000);
    return null;
  }

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    // markOnlineOnConnect: false → HP kamu tetap dapat notifikasi,
    // dan bot tidak "merebut" status online 24 jam.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Ubuntu', 'Chrome', '120.0.0'],

    /**
     * Dipanggil Baileys saat penerima minta pesan dikirim ulang.
     * Tanpa ini, "Waiting for this message" tidak pernah pulih sendiri.
     */
    getMessage: async (key) => sentMessages.get(key.id),
  });

  connecting = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      console.log('\n[WA] Scan QR ini dari WhatsApp > Perangkat Tertaut:\n');
      qrcode.generate(qr, { small: true });
      // Kirim QR ke panel via SSE sebagai teks (panel render dengan library QR)
      emit('wa_qr', { qr });
    }

    if (connection === 'open') {
      ready = true;
      console.log('[WA] Tersambung sebagai', sock.user?.id);
      emit('wa_connected', { id: sock.user?.id });
    }

    if (connection === 'close') {
      ready = false;
      emit('wa_disconnected', {});
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (code === DisconnectReason.loggedOut) {
        // Sesi dicabut dari HP, atau akun kena aksi WhatsApp.
        console.error('[WA] Logged out. Sesi dihapus, perlu scan QR baru.');
        await clearSession();
        return scheduleReconnect(1_000);
      }

      if (code === DisconnectReason.connectionReplaced) {
        // 440 = stream error 'conflict': sesi WhatsApp Web lain mengambil alih
        // slot ini. Reconnect otomatis justru merebutnya balik, sesi lawan
        // merebut lagi, dan keduanya saling tendang tanpa henti — tidak ada
        // pesan yang terkirim selama itu. Berhenti dan minta manusia memilih
        // sesi mana yang hidup.
        console.error('[WA] Koneksi diambil alih sesi lain (440).');
        console.error('[WA] Tutup WhatsApp Web / bot lain yang memakai nomor ini, lalu start ulang.');
        emit('wa_conflict', {});
        return;
      }

      // Reconnect dengan backoff supaya tidak spam koneksi.
      const wait = 5_000 + Math.random() * 10_000;
      console.warn(`[WA] Terputus (${code}). Reconnect dalam ${Math.round(wait / 1000)}s`);
      scheduleReconnect(wait);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      // fromMe TIDAK di-skip di sini: perintah admin bisa dikirim lewat
      // fitur "Pesan ke diri sendiri". Handler yang memutuskan.
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;   // abaikan grup
      if (msg.key.remoteJid === 'status@broadcast') continue;
      try {
        await _onMessage(msg);
      } catch (e) {
        console.error('[WA] handler error:', e.message);
      }
    }
  });

  return sock;
}

/**
 * Hapus sesi dari DB lalu reconnect — panel akan menampilkan QR baru.
 * Dipanggil dari endpoint /admin/wa-logout.
 */
export async function forceRelogin() {
  console.log('[WA] Force re-login diminta admin. Menghapus sesi…');
  ready = false;
  emit('wa_disconnected', {});
  try { sock?.end?.(); } catch (_) { }
  const { clearSession } = await usePostgresAuthState();
  await clearSession();
  console.log('[WA] Sesi dihapus. Memulai ulang koneksi…');
  return startWhatsApp();
}

/** Normalisasi nomor Indonesia → JID WhatsApp */
export function toJid(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  if (n.startsWith('8')) n = '62' + n;
  return `${n}@s.whatsapp.net`;
}

/** Cek nomor benar-benar terdaftar di WhatsApp sebelum dikirimi pesan. */
export async function isRegistered(jid) {
  const [res] = await sock.onWhatsApp(jid.split('@')[0]);
  return Boolean(res?.exists);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kirim pesan dengan ritme manusia: baca → mengetik → kirim.
 * Durasi mengetik proporsional dengan panjang teks.
 */
export async function sendHumanLike(jid, text) {
  const { charsPerSecond, minMs, maxMs, readDelayMs } = config.typing;

  /**
   * FIX "Waiting for this message":
   * WhatsApp pakai Signal Protocol untuk enkripsi E2E. Kalau sesi kriptografi
   * dengan penerima belum ada atau pre-key bundle kadaluarsa, pesan masuk ke
   * server WA tapi penerima tidak bisa mendekripsi → muncul pesan itu.
   *
   * assertSessions memastikan pre-key bundle sudah di-fetch dan sesi enkripsi
   * terbentuk SEBELUM pesan dikirim. Kalau gagal (misal koneksi lambat),
   * catch kosong agar pengiriman tetap lanjut — lebih baik terkirim dengan
   * risiko kecil "waiting" daripada gagal total.
   */
  await sock.assertSessions([jid]).catch(() => { });

  await sleep(readDelayMs * (0.7 + Math.random() * 0.6));

  const typingMs = Math.min(
    maxMs,
    Math.max(minMs, (text.length / charsPerSecond) * 1000 * (0.85 + Math.random() * 0.3))
  );

  // Kirim sinyal "...sedang mengetik" ke WhatsApp pelanggan
  await sock.sendPresenceUpdate('composing', jid).catch(() => { });
  await sleep(typingMs);
  await sock.sendPresenceUpdate('paused', jid).catch(() => { });

  console.log(`[WA-SEND] Mengirim ke: ${jid} (${text.length} karakter)`);
  try {
    const sent = await sock.sendMessage(jid, { text });
    // Simpan supaya bisa dikirim ulang kalau penerima minta retry.
    cacheSent(sent?.key?.id, sent?.message);
    console.log(`[WA-SEND] ✓ Berhasil kirim ke ${jid}, id: ${sent?.key?.id || '?'}`);
    return sent;
  } catch (err) {
    console.error(`[WA-SEND] ✗ GAGAL kirim ke ${jid}:`, err.message || err);
    throw err;
  }
}

/** Helper untuk mengunduh biner gambar dari HTTP/HTTPS dengan fallback Google Drive */
async function fetchImageBuffer(url) {
  const fileIdMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const fileId = fileIdMatch ? fileIdMatch[1] : null;

  const candidateUrls = [url];
  if (fileId) {
    candidateUrls.push(
      `https://lh3.googleusercontent.com/d/${fileId}`,
      `https://drive.google.com/uc?export=download&id=${fileId}`,
      `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`
    );
  }

  const uniqueUrls = [...new Set(candidateUrls)];

  let lastErr = null;
  for (const candidate of uniqueUrls) {
    try {
      const res = await fetch(candidate, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!res.ok) continue;
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('html') && !contentType.includes('image')) {
        continue;
      }
      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      if (buf.length > 500) {
        return buf;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(lastErr?.message || `Gagal mengunduh biner foto dari ${url}`);
}

/**
 * Kirim pesan gambar/foto dengan caption opsional via Baileys.
 * Otomatis menggunakan DriveMediaService & PostgreSQL cache bila URL berasal dari Google Drive.
 */
export async function sendImageHumanLike(jid, imageUrl, caption = '') {
  await sock.assertSessions([jid]).catch(() => { });
  await sleep(1000);

  // Cek apakah URL merupakan Google Drive Link dari Spreadsheet
  const driveMatch = typeof imageUrl === 'string'
    ? (imageUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || imageUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/) || imageUrl.match(/\/d\/([a-zA-Z0-9_-]+)/))
    : null;

  if (driveMatch && driveMatch[1]) {
    const driveFileId = driveMatch[1];
    console.log(`[WA-SEND-IMG] Link Google Drive terdeteksi dari Katalog (${driveFileId}). Menggunakan DriveMediaService (PostgreSQL Cache)...`);
    return await driveService.processAndSendMedia({
      sock,
      jid,
      driveFileId,
      caption,
    });
  }

  console.log(`[WA-SEND-IMG] Mengunduh & mengirim foto ke: ${jid} (${imageUrl})`);
  try {
    let imageSource;
    if (typeof imageUrl === 'string' && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
      imageSource = await fetchImageBuffer(imageUrl);
    } else if (typeof imageUrl === 'string' && fs.existsSync(imageUrl)) {
      imageSource = fs.readFileSync(imageUrl);
    } else {
      imageSource = { url: imageUrl };
    }

    const messageContent = {
      image: imageSource,
      ...(caption ? { caption } : {})
    };
    const sent = await sock.sendMessage(jid, messageContent);
    cacheSent(sent?.key?.id, sent?.message);
    console.log(`[WA-SEND-IMG] ✓ Berhasil kirim foto asli ke ${jid}`);
    return sent;
  } catch (err) {
    console.error(`[WA-SEND-IMG] ✗ GAGAL kirim foto ke ${jid}:`, err.message || err);
    throw err;
  }
}


