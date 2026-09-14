/**
 * Membuktikan kode 440 (connectionReplaced) tidak memicu reconnect.
 *
 * Bug-nya: 440 berarti sesi WhatsApp Web lain merebut slot ini. Reconnect
 * otomatis merebutnya balik, lawan merebut lagi — ping-pong tanpa henti dan
 * tidak ada pesan yang terkirim selama itu. Log lapangan menunjukkan 16 siklus.
 *
 * Tes ini membaca cabang keputusan langsung dari sumber, bukan menjalankan
 * socket sungguhan: menyalakan Baileys butuh jaringan dan akun aktif.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DisconnectReason } from 'baileys';

const src = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');

// Potong blok penanganan connection === 'close'.
const mulai = src.indexOf("if (connection === 'close')");
assert.ok(mulai > 0, "blok connection === 'close' tidak ditemukan");
const blok = src.slice(mulai, src.indexOf("sock.ev.on('messages.upsert'", mulai));

const cabang = blok.indexOf('DisconnectReason.connectionReplaced');
assert.ok(cabang > 0, '440 tidak ditangani khusus — akan jatuh ke reconnect biasa');
console.log('  ✓ kode 440 punya cabang sendiri');

// Cabang 440 harus keluar sebelum baris scheduleReconnect umum.
const backoff = blok.indexOf('scheduleReconnect(wait)');
assert.ok(backoff > cabang, 'cabang 440 berada setelah reconnect umum — tidak pernah terpakai');
const isiCabang = blok.slice(cabang, backoff);
assert.ok(/\breturn;/.test(isiCabang), 'cabang 440 tidak return — eksekusi lanjut ke reconnect');
assert.ok(!/scheduleReconnect/.test(isiCabang), 'cabang 440 masih memanggil scheduleReconnect');
console.log('  ✓ cabang 440 berhenti, tidak menjadwalkan reconnect');

// loggedOut (401) justru HARUS reconnect setelah sesi dihapus — jangan sampai
// tambalan 440 ikut mematikannya.
const keluar = blok.indexOf('DisconnectReason.loggedOut');
assert.ok(keluar > 0 && keluar < cabang, 'cabang loggedOut hilang atau tergeser');
assert.ok(/scheduleReconnect\(1_000\)/.test(blok.slice(keluar, cabang)), 'loggedOut tidak lagi reconnect');
console.log('  ✓ jalur logout (401) tetap reconnect seperti semula');

// Putus biasa (408, 428, 515) tetap harus reconnect otomatis.
assert.ok(/scheduleReconnect\(wait\)/.test(blok), 'reconnect backoff untuk putus biasa hilang');
console.log('  ✓ putus biasa (408/428/515) tetap reconnect otomatis');

assert.equal(DisconnectReason.connectionReplaced, 440, 'enum Baileys berubah, tes ini perlu ditinjau');
console.log('  ✓ DisconnectReason.connectionReplaced masih 440');

console.log('\nSemua pemeriksaan konflik sesi lulus.');
