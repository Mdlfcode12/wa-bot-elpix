/**
 * Hapus sesi Signal untuk SATU nomor, tanpa menyentuh login WhatsApp.
 *
 *   node scripts/reset-signal-session.mjs 6285180606949
 *
 * Kapan dipakai: penerima terus melihat "Waiting for this message" padahal
 * log bot bilang pesan terkirim. Artinya sesi kriptografi antara bot dan HP
 * itu tidak lagi cocok, dan tidak ada pihak yang bisa memperbaikinya sendiri.
 *
 * Yang dihapus HANYA kunci sesi untuk nomor tersebut. Baris 'creds' tidak
 * disentuh, jadi TIDAK perlu scan QR ulang. Sesi baru dibangun otomatis pada
 * pesan berikutnya, lewat assertSessions di src/client.js.
 */
import { pool } from '../src/authState.js';
import { config } from '../src/config.js';

const nomor = String(process.argv[2] || '').replace(/\D/g, '');
if (!nomor) {
  console.error('Nomor wajib diisi. Contoh:\n  node scripts/reset-signal-session.mjs 6285180606949');
  process.exit(1);
}

const { rows: sebelum } = await pool.query(
  `SELECT key FROM wa_auth WHERE session_id=$1 AND key LIKE $2 ORDER BY key`,
  [config.sessionId, `session-${nomor}.%`]
);

if (!sebelum.length) {
  console.log(`Tidak ada sesi tersimpan untuk ${nomor}. Tidak ada yang dihapus.`);
  await pool.end();
  process.exit(0);
}

console.log(`Akan dihapus ${sebelum.length} kunci sesi untuk ${nomor}:`);
for (const r of sebelum) console.log('  -', r.key);

const { rowCount } = await pool.query(
  `DELETE FROM wa_auth WHERE session_id=$1 AND key LIKE $2`,
  [config.sessionId, `session-${nomor}.%`]
);

console.log(`\n${rowCount} kunci dihapus. Login WhatsApp TIDAK terpengaruh.`);
console.log('Restart bot, lalu minta nomor itu mengirim satu pesan.');
console.log('Sesi baru terbentuk otomatis dan pesan berikutnya akan terbaca.');

await pool.end();
