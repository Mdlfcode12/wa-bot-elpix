/**
 * Tes kirim pesan langsung tanpa melalui bot.
 * Jalankan SAAT bot sedang menyala (npm start di terminal lain).
 *
 * Cara pakai:  node test_send.js 6285180606949
 */
import 'dotenv/config';
import pg from 'pg';
import makeWASocket, { fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from 'baileys';
import { usePostgresAuthState } from './src/authState.js';
import pino from 'pino';

const target = process.argv[2];
if (!target) {
  console.error('Pakai: node test_send.js 628xxxxxxxxxx');
  process.exit(1);
}
const jid = target.replace(/\D/g, '') + '@s.whatsapp.net';

console.log(`Akan mengirim pesan tes ke: ${jid}`);

const { state, saveCreds } = await usePostgresAuthState();
const { version } = await fetchLatestBaileysVersion();
const logger = pino({ level: 'warn' });

const sock = makeWASocket({
  version,
  logger,
  printQRInTerminal: true,
  markOnlineOnConnect: false,
  syncFullHistory: false,
  auth: {
    creds: state.creds,
    keys: makeCacheableSignalKeyStore(state.keys, logger),
  },
  browser: ['Ubuntu', 'Chrome', '120.0.0'],
});

sock.ev.on('creds.update', saveCreds);

sock.ev.on('connection.update', async (u) => {
  if (u.connection === 'open') {
    console.log('[TEST] Tersambung! Mengirim pesan tes...');

    try {
      // Cek dulu apakah nomor terdaftar di WA
      const [check] = await sock.onWhatsApp(jid.split('@')[0]);
      console.log('[TEST] onWhatsApp result:', JSON.stringify(check));

      if (!check?.exists) {
        console.error('[TEST] Nomor tidak terdaftar di WhatsApp!');
        process.exit(1);
      }

      // Kirim ke JID yang dikembalikan oleh onWhatsApp (bisa beda format)
      const actualJid = check.jid;
      console.log(`[TEST] Mengirim ke JID resmi: ${actualJid}`);

      const sent = await sock.sendMessage(actualJid, {
        text: '🤖 Ini pesan tes dari bot. Jika kamu menerima ini, bot berhasil mengirim!'
      });
      console.log('[TEST] ✓ Pesan terkirim!', JSON.stringify(sent.key));
    } catch (err) {
      console.error('[TEST] ✗ GAGAL:', err);
    }

    setTimeout(() => process.exit(0), 3000);
  }
});
