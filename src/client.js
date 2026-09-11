import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { usePostgresAuthState } from './authState.js';
import { config } from './config.js';
import { emit } from './events.js';

const logger = pino({ level: 'fatal' });
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
    console.log(`[WA-SEND] ✓ Berhasil kirim ke ${jid}, id: ${sent?.key?.id || '?'}`);
    return sent;
  } catch (err) {
    console.error(`[WA-SEND] ✗ GAGAL kirim ke ${jid}:`, err.message || err);
    throw err;
  }
}
