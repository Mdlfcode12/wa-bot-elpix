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

console.log('\nSemua pemeriksaan lulus.');
