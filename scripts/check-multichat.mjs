/**
 * Pemeriksaan mandiri untuk perbaikan "bot tidak bisa menangani banyak chat".
 * Tidak butuh database maupun WhatsApp — murni logika antrean dan pemetaan.
 *
 * Jalankan: node scripts/check-multichat.mjs
 */
import assert from 'node:assert/strict';
import { PerChatQueue, Semaphore } from '../src/limiter.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. Banyak kontak diproses BERSAMAAN, bukan bergantian ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  const mulai = [];
  const handler = async (jid) => { mulai.push(jid); await sleep(80); };

  for (let i = 0; i < 5; i++) q.push(`k${i}@s.whatsapp.net`, 'halo', handler);

  await sleep(60); // lewat debounce, tapi handler pertama belum selesai
  assert.equal(mulai.length, 5,
    'lima kontak berbeda harus mulai diproses bersamaan, bukan antre satu-satu');

  await sleep(150);
  assert.equal(q.size(), 0, 'antrean harus bersih setelah semua selesai');
  console.log('  ✓ lima kontak diproses paralel, antrean bersih');
}

// --- 2. Pesan yang datang saat giliran berjalan TIDAK hilang dan TIDAK mundur ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  const batch = [];
  const handler = async (jid, teks) => { batch.push(teks); await sleep(100); };
  const JID = 'sibuk@s.whatsapp.net';

  q.push(JID, 'pesan-1', handler);
  await sleep(50);                       // giliran 1 sedang jalan
  assert.deepEqual(batch, ['pesan-1']);

  q.push(JID, 'pesan-2', handler);       // datang di tengah giliran 1
  q.push(JID, 'pesan-3', handler);

  await sleep(300);
  assert.deepEqual(batch, ['pesan-1', 'pesan-2\npesan-3'],
    'pesan yang masuk saat sibuk harus diproses setelahnya, digabung sekali');
  assert.equal(q.size(), 0);
  console.log('  ✓ pesan saat chat sibuk tidak hilang dan tidak mundur terus');
}

// --- 3. Giliran lanjutan berjalan SEKALI, bukan berulang ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  let panggilan = 0;
  const handler = async () => { panggilan++; await sleep(60); };
  const JID = 'ulang@s.whatsapp.net';

  q.push(JID, 'a', handler);
  await sleep(40);
  q.push(JID, 'b', handler);

  await sleep(400);
  assert.equal(panggilan, 2,
    'dua gelombang pesan harus jadi tepat dua panggilan, tanpa giliran hantu');
  console.log('  ✓ tidak ada giliran berulang setelah handler selesai');
}

// --- 4. Handler yang melempar tidak menyangkutkan antrean kontak itu ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  const JID = 'error@s.whatsapp.net';
  let kedua = false;

  q.push(JID, 'bikin-error', async () => { throw new Error('Gemini mati'); });
  await sleep(120);
  assert.equal(q.size(), 0, 'kegagalan handler harus membersihkan antrean');

  q.push(JID, 'lagi', async () => { kedua = true; });
  await sleep(120);
  assert.equal(kedua, true, 'kontak yang sempat error harus tetap bisa dilayani lagi');
  console.log('  ✓ satu giliran gagal tidak mematikan chat itu selamanya');
}

// --- 5. clear() saat handler berjalan tidak membuang antrean giliran baru ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  const JID = 'stop@s.whatsapp.net';
  const teks = [];
  const lambat = async (jid, t) => { teks.push(t); await sleep(100); };

  q.push(JID, 'pertama', lambat);
  await sleep(50);          // handler 'pertama' sedang jalan
  q.clear(JID);             // admin menekan STOP
  q.push(JID, 'sesudah-stop', lambat);   // pesan baru masuk setelahnya

  await sleep(300);
  assert.deepEqual(teks, ['pertama', 'sesudah-stop'],
    'pesan yang masuk setelah STOP tidak boleh ikut terbuang oleh giliran lama');
  console.log('  ✓ STOP saat sibuk tidak membuang antrean berikutnya');
}

// --- 6. LID tanpa nomor diproses, bukan dibuang (perbaikan pesan hilang) ---
{
  // Meniru alur src/inbound.js: peta lokal -> tanya WhatsApp -> pakai LID apa adanya.
  const lidToPhone = new Map();
  const dariServer = new Map([['111@lid', '628111:0@s.whatsapp.net']]);

  const tanyaNomor = async (lid) => {
    const pn = dariServer.get(lid);
    if (!pn) return null;
    const bersih = pn.replace(/:\d+@/, '@');
    lidToPhone.set(lid, bersih);
    return bersih;
  };

  const petakan = async (key) => {
    const raw = key.remoteJid;
    if (key.senderLid && key.senderPn) lidToPhone.set(key.senderLid, key.senderPn);
    if (raw?.endsWith('@lid') && key.senderPn) lidToPhone.set(raw, key.senderPn);
    let jid = key.senderPn || raw;
    if (jid?.endsWith('@lid')) jid = lidToPhone.get(jid) || (await tanyaNomor(jid)) || jid;
    return jid;
  };

  // LID yang bisa ditanyakan ke WhatsApp: dipetakan, dan nomor perangkat dibuang.
  assert.equal(await petakan({ remoteJid: '111@lid' }), '628111@s.whatsapp.net',
    'LID harus dipetakan lewat WhatsApp, tanpa sufiks perangkat');

  // Pemetaan diingat, panggilan kedua tidak perlu bertanya lagi.
  dariServer.clear();
  assert.equal(await petakan({ remoteJid: '111@lid' }), '628111@s.whatsapp.net',
    'pemetaan yang sudah didapat harus diingat');

  // LID yang tidak bisa dipetakan sama sekali TETAP diproses — ini inti perbaikannya.
  const asing = await petakan({ remoteJid: '999@lid' });
  assert.equal(asing, '999@lid',
    'LID tak dikenal harus diproses sebagai kontak LID, bukan dibuang');

  // Nomor biasa lewat apa adanya.
  const HP = '6285180606949@s.whatsapp.net';
  assert.equal(await petakan({ remoteJid: HP }), HP);
  console.log('  ✓ pesan dari LID tak dikenal tidak lagi hilang diam-diam');
}

// --- 7. Semaphore melepas slot walau tugasnya melempar ---
{
  const sem = new Semaphore(2);
  await assert.rejects(sem.run(async () => { throw new Error('gagal'); }));
  assert.equal(sem.active, 0, 'slot harus kembali walau tugas gagal');

  let selesai = 0;
  await Promise.all([1, 2, 3, 4].map(() => sem.run(async () => { await sleep(20); selesai++; })));
  assert.equal(selesai, 4, 'semua tugas berikutnya harus tetap kebagian slot');
  console.log('  ✓ batas paralel AI tidak bocor saat ada panggilan gagal');
}

// --- 8. Satu kontak tidak pernah punya DUA balasan berjalan bersamaan ---
{
  // Ini bug yang paling halus. clear() dulu menghapus entry walau handler-nya
  // masih jalan; push() berikutnya lalu membuat entry baru yang tidak tahu ada
  // giliran berjalan, dan dua balasan untuk orang yang sama terkirim bersamaan
  // dengan urutan acak di HP pelanggan.
  const q = new PerChatQueue({ debounceMs: 20 });
  const JID = 'serial@s.whatsapp.net';
  let aktif = 0, maxAktif = 0;
  const lambat = async () => {
    aktif++;
    maxAktif = Math.max(maxAktif, aktif);
    await sleep(150);
    aktif--;
  };

  q.push(JID, 'A', lambat);
  await sleep(40);            // A sedang jalan
  q.clear(JID);               // admin menekan STOP di tengah A
  await sleep(5);
  q.push(JID, 'B', lambat);   // pesan baru masuk
  await sleep(160);           // blok finally milik A jalan di sini
  q.push(JID, 'C', lambat);
  await sleep(400);

  assert.equal(maxAktif, 1,
    'satu kontak hanya boleh punya satu balasan berjalan; dua berarti urutan pesan bisa terbalik');
  assert.equal(q.size(), 0, 'antrean harus bersih di akhir');
  console.log('  ✓ satu kontak tidak pernah dibalas dua kali bersamaan');
}

// --- 9. clear() saat sibuk tidak membocorkan entry (shutdown harus bisa selesai) ---
{
  const q = new PerChatQueue({ debounceMs: 20 });
  const JID = 'bocor@s.whatsapp.net';
  q.push(JID, 'x', async () => { await sleep(120); });
  await sleep(40);
  q.clear(JID);
  assert.equal(q.size(), 1,
    'selama handler jalan, antrean tetap terhitung supaya shutdown menunggunya');
  await sleep(300);
  assert.equal(q.size(), 0, 'entry harus hilang setelah handler selesai, bukan menggantung');
  console.log('  ✓ STOP saat sibuk tidak menggantungkan antrean');
}

console.log('\nSemua pemeriksaan multi-chat lulus.');
