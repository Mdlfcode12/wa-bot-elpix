/**
 * Pemeriksaan batas hari untuk kuota kirim harian.
 *
 * Jalankan saat database hidup:  node scripts/check-timezone.mjs
 *
 * Yang diuji: batas hitungan harus jatuh tepat tengah malam waktu Asia/Jakarta,
 * bukan tengah malam waktu server database. Kalau server database berjalan UTC
 * (Neon, Supabase), cara lama meleset 7 jam dan kuota harian reset jam 07:00 WIB
 * — di tengah jam operasional, sehingga bot bisa mengirim dua kali lipat.
 */
import assert from 'node:assert/strict';
import { pool } from '../src/authState.js';
import { config } from '../src/config.js';

const tz = config.outbound.timezone;

const { rows } = await pool.query(
  `SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS batas,
          date_trunc('day', now())                                AS batas_lama,
          now()                                                   AS sekarang`,
  [tz]
);

const { batas, batas_lama, sekarang } = rows[0];
const jamDi = (d) => d.toLocaleString('sv-SE', { timeZone: tz });

console.log(`zona kirim      : ${tz}`);
console.log(`sekarang        : ${jamDi(sekarang)}`);
console.log(`batas (baru)    : ${jamDi(batas)}`);
console.log(`batas (cara lama): ${jamDi(batas_lama)}`);

assert.ok(batas <= sekarang, 'batas hari tidak boleh di masa depan');
assert.ok(
  sekarang - batas < 24 * 3600_000,
  'batas hari harus dalam 24 jam terakhir'
);
assert.equal(
  jamDi(batas).slice(11),
  '00:00:00',
  `batas harus tepat tengah malam ${tz}, bukan ${jamDi(batas)}`
);

const meleset = Math.round((batas - batas_lama) / 3600_000);
console.log(
  meleset === 0
    ? '\nOK. Server database kebetulan sudah di zona yang sama.'
    : `\nOK. Cara lama meleset ${meleset} jam di server ini — perbaikan ini yang menutupnya.`
);

await pool.end();
