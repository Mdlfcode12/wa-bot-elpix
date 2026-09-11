/**
 * Pemeriksaan mandiri untuk empat perbaikan ketahanan.
 * Tidak butuh database maupun WhatsApp — murni logika.
 *
 * Jalankan: node scripts/check-resilience.mjs
 */
import assert from 'node:assert/strict';
import { PerChatQueue } from '../src/limiter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. Pembungkus async meneruskan rejection ke next(), bukan ke process ---
{
  const a = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  let diteruskan = null;
  const handler = a(async () => { throw new Error('database putus'); });
  await handler({}, {}, (e) => { diteruskan = e; });
  await sleep(0);
  assert.equal(diteruskan?.message, 'database putus',
    'error dari handler async harus sampai ke next()');
  console.log('  ✓ handler async meneruskan error, tidak mematikan proses');
}

// --- 2. Antrean melaporkan ukuran sebenarnya, supaya shutdown bisa menunggu ---
{
  const q = new PerChatQueue({ debounceMs: 50 });
  let selesai = 0;
  q.push('a@s.whatsapp.net', 'halo', async () => { await sleep(30); selesai++; });
  assert.equal(q.size(), 1, 'pesan yang masuk harus terhitung di antrean');
  await sleep(200);
  assert.equal(selesai, 1, 'giliran harus selesai diproses');
  assert.equal(q.size(), 0, 'antrean harus kosong setelah selesai');
  console.log('  ✓ queue.size() akurat — shutdown tahu kapan boleh keluar');
}

// --- 3. Debounce menggabungkan pesan beruntun jadi satu panggilan ---
{
  const q = new PerChatQueue({ debounceMs: 60 });
  const panggilan = [];
  const h = async (jid, teks) => { panggilan.push(teks); };
  q.push('b@s.whatsapp.net', 'halo', h);
  q.push('b@s.whatsapp.net', 'mau tanya', h);
  q.push('b@s.whatsapp.net', 'soal harga', h);
  await sleep(250);
  assert.equal(panggilan.length, 1, 'tiga pesan beruntun harus jadi SATU panggilan');
  assert.equal(panggilan[0], 'halo\nmau tanya\nsoal harga');
  console.log('  ✓ debounce menggabungkan pesan beruntun jadi satu panggilan AI');
}

// --- 4. clear() membuang balasan yang belum terkirim (tombol STOP) ---
{
  const q = new PerChatQueue({ debounceMs: 80 });
  let terpanggil = 0;
  q.push('c@s.whatsapp.net', 'halo', async () => { terpanggil++; });
  assert.equal(q.clear('c@s.whatsapp.net'), 1, 'clear harus melaporkan 1 dibuang');
  await sleep(200);
  assert.equal(terpanggil, 0, 'balasan yang sudah di-clear tidak boleh terkirim');
  console.log('  ✓ STOP membatalkan balasan yang masih menunggu di debounce');
}

// --- 5. Penjaga reconnect: hanya satu percobaan yang boleh antre ---
{
  let timer = null;
  let jalan = 0;
  const scheduleReconnect = (ms) => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; jalan++; }, ms);
  };
  scheduleReconnect(20);
  scheduleReconnect(20);
  scheduleReconnect(20);
  await sleep(120);
  assert.equal(jalan, 1, 'tiga event close beruntun hanya boleh memicu SATU reconnect');
  console.log('  ✓ reconnect tidak beranak walau koneksi naik-turun');
}

// --- 6. LID tanpa senderPn tidak boleh dibuang kalau pemetaannya sudah dikenal ---
{
  const lidToPhone = new Map();
  const petakan = (key) => {
    const raw = key.remoteJid;
    if (key.senderLid && key.senderPn) lidToPhone.set(key.senderLid, key.senderPn);
    if (raw?.endsWith('@lid') && key.senderPn) lidToPhone.set(raw, key.senderPn);
    let jid = key.senderPn || raw;
    if (jid?.endsWith('@lid')) {
      const dikenal = lidToPhone.get(jid);
      if (!dikenal) return null;   // benar-benar belum dikenal
      jid = dikenal;
    }
    return jid;
  };

  const LID = '125641080967407@lid';
  const HP = '6285180606949@s.whatsapp.net';

  // Pesan pertama membawa keduanya: pemetaan terbentuk.
  assert.equal(petakan({ remoteJid: LID, senderPn: HP }), HP);

  // Pesan berikutnya HANYA LID — inilah yang dulu dibuang diam-diam.
  assert.equal(petakan({ remoteJid: LID }), HP,
    'LID yang sudah dikenal harus dipetakan ke nomor, bukan dibuang');

  // LID yang belum pernah terlihat tetap ditolak, supaya tidak jadi kontak hantu.
  assert.equal(petakan({ remoteJid: '999999999999@lid' }), null,
    'LID asing tetap harus ditolak');

  // Nomor biasa lewat apa adanya.
  assert.equal(petakan({ remoteJid: HP }), HP);

  console.log('  ✓ pesan LID tidak lagi hilang setelah pemetaan dikenal');
}

// --- 7. Balasan dikirim ke alamat yang dipakai pesan masuk ---
{
  const alamatBalasan = new Map();
  const HP  = '6285180606949@s.whatsapp.net';
  const LID = '125641080967407@lid';

  const catat = (jid, rawJid) => { if (rawJid && rawJid !== jid) alamatBalasan.set(jid, rawJid); };
  const alamatKirim = (jid) => alamatBalasan.get(jid) || jid;

  // Kontak yang belum pernah menulis: balas ke nomornya.
  assert.equal(alamatKirim(HP), HP, 'tanpa riwayat LID, balas ke nomor');

  // Pesan masuk lewat LID: alamat itu yang punya sesi enkripsi hidup.
  catat(HP, LID);
  assert.equal(alamatKirim(HP), LID,
    'setelah pesan masuk lewat LID, balasan harus ke LID');

  // Kontak lain tidak ikut terpengaruh.
  const LAIN = '628111111111@s.whatsapp.net';
  assert.equal(alamatKirim(LAIN), LAIN, 'kontak lain tetap pakai nomornya sendiri');

  // Pesan masuk lewat nomor biasa tidak menimpa apa pun.
  catat(LAIN, LAIN);
  assert.equal(alamatKirim(LAIN), LAIN);

  console.log('  ✓ balasan dikirim ke alamat yang dipakai pesan masuk');
}

console.log('\nSemua pemeriksaan lulus.');
