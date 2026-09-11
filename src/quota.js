import { pool } from './authState.js';
import { config } from './config.js';

/**
 * Free tier Gemini punya batas requests-per-day (RPD), bukan cuma per-menit.
 * Ini berbeda dari Claude dan butuh penanganan sendiri:
 *
 *   429 karena RPM  → tunggu beberapa detik, lalu berhasil
 *   429 karena RPD  → menunggu tidak menolong sama sekali sampai tengah malam
 *
 * Kalau keduanya diperlakukan sama, bot akan mencoba ulang berkali-kali
 * sepanjang sore untuk sesuatu yang mustahil berhasil, dan pelanggan
 * menunggu tanpa jawaban. Jadi kuota harian dihitung di sisi kita sendiri.
 *
 * Hitungan disimpan di database supaya restart tidak mereset penghitung —
 * kuota di sisi Google tetap terpakai walaupun proses kita mati dan hidup lagi.
 *
 * RPD Google reset tengah malam waktu Pasifik, bukan waktu lokal.
 */

const PACIFIC = 'America/Los_Angeles';

/** Tanggal hari ini menurut waktu Pasifik, format YYYY-MM-DD. */
function pacificDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function initQuota() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_quota (
      day   TEXT PRIMARY KEY,
      used  INT NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Ambil satu jatah. Mengembalikan false kalau kuota hari ini sudah habis.
 *
 * Selalu increment lebih dulu, baru periksa hasilnya. Bentuk ini dipilih
 * karena perilakunya tidak ambigu: satu pernyataan atomik, satu baris balik,
 * keputusan diambil dari angka yang jelas. Varian `ON CONFLICT ... WHERE ...
 * RETURNING` lebih ringkas tapi bergantung pada seluk-beluk kapan baris
 * dikembalikan saat kondisinya gagal — dan kalau salah paham, bot menembus
 * kuota tanpa sadar.
 *
 * Efek sampingnya: penghitung ikut naik pada percobaan yang ditolak, jadi
 * bisa melewati batas. Itu tidak masalah — ini anggaran milik kita sendiri,
 * bukan hitungan Google, dan reset tiap hari.
 */
export async function takeDailyQuota() {
  const { rows } = await pool.query(
    `INSERT INTO ai_quota (day, used) VALUES ($1, 1)
     ON CONFLICT (day) DO UPDATE SET used = ai_quota.used + 1
     RETURNING used`,
    [pacificDay()]
  );
  return rows[0].used <= config.gemini.rpdBudget;
}

export async function remainingToday() {
  const { rows } = await pool.query(`SELECT used FROM ai_quota WHERE day=$1`, [pacificDay()]);
  return Math.max(0, config.gemini.rpdBudget - (rows[0]?.used || 0));
}

export async function usedToday() {
  const { rows } = await pool.query(`SELECT used FROM ai_quota WHERE day=$1`, [pacificDay()]);
  return rows[0]?.used || 0;
}
