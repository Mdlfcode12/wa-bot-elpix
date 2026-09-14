/**
 * Tiga lapis proteksi supaya tidak pernah kena 429 dari Claude:
 *
 *  1. TokenBucket  — plafon request/menit yang kita paksakan sendiri (< limit tier).
 *  2. Concurrency  — berapa panggilan Claude boleh jalan bersamaan.
 *  3. PerChatQueue — 1 kontak = 1 antrean serial. 5 pesan beruntun dari orang
 *                    yang sama tidak jadi 5 panggilan API, tapi digabung.
 */

export class TokenBucket {
  constructor(ratePerMinute) {
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.refillPerMs = ratePerMinute / 60_000;
    this.last = Date.now();
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }

  async take() {
    for (; ;) {
      this.#refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * Antrean per-kontak dengan DEBOUNCE.
 * Kalau user mengirim "halo" / "mau tanya" / "soal harga" dalam 3 detik,
 * kita tunggu sampai dia berhenti mengetik, gabungkan jadi satu prompt,
 * lalu panggil Claude SEKALI. Ini penghemat kuota terbesar.
 */
export class PerChatQueue {
  constructor({ debounceMs = 4000 } = {}) {
    this.debounceMs = debounceMs;
    this.pending = new Map(); // jid -> { texts, timer, running }
  }

  push(jid, text, handler) {
    let entry = this.pending.get(jid);
    if (!entry) {
      entry = { texts: [], timer: null, running: false };
      this.pending.set(jid, entry);
    }

    if (text) entry.texts.push(text);

    // Kalau giliran kontak ini sedang jalan, JANGAN pasang timer baru.
    // Versi sebelumnya memasang rantai timer yang menjadwalkan push('') ulang
    // tiap debounce sampai handler selesai. Hasil akhirnya sama, tapi setiap
    // penjadwalan ulang itu membuat entry baru kalau clear() sempat menghapus
    // entry lama di tengah jalan — di situlah dua balasan untuk satu kontak
    // bisa jalan bersamaan. Sekarang pesan yang menunggu diambil oleh blok
    // finally begitu giliran sekarang selesai: sekali, tanpa rantai timer.
    if (entry.running) return;
    this.#pasangTimer(jid, entry, handler);
  }

  #pasangTimer(jid, entry, handler) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.#proses(jid, entry, handler), this.debounceMs);
  }

  async #proses(jid, entry, handler) {
    entry.timer = null;
    const batch = entry.texts.join('\n').trim();
    entry.texts = [];

    if (!batch) {
      if (this.pending.get(jid) === entry) this.pending.delete(jid);
      return;
    }

    entry.running = true;
    try {
      await handler(jid, batch);
    } catch (e) {
      console.error(`[queue] ${jid}:`, e.message);
    } finally {
      entry.running = false;
      // clear() bisa dipanggil selama handler jalan, dan push() sesudahnya
      // bisa sudah memasang entry BARU di kunci yang sama. Menghapus tanpa
      // memeriksa akan membuang antrean milik giliran berikutnya.
      if (this.pending.get(jid) !== entry) return;
      if (entry.texts.length) this.#pasangTimer(jid, entry, handler);
      else this.pending.delete(jid);
    }
  }

  /**
   * Buang balasan yang masih menunggu di antrean.
   * Penting untuk tombol STOP: tanpa ini, pesan yang sudah masuk debounce
   * 4 detik sebelum kamu menekan STOP tetap akan terkirim setelahnya.
   */
  clear(jid) {
    const entry = this.pending.get(jid);
    if (!entry) return 0;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    entry.texts = [];
    // Handler yang SUDAH berjalan tidak bisa ditarik kembali. Entry-nya harus
    // tetap di peta, kalau tidak push() berikutnya tidak melihat giliran yang
    // sedang jalan, membuat entry baru, dan dua balasan untuk kontak yang sama
    // dikirim bersamaan — urutannya jadi acak di HP pelanggan.
    // Blok finally di #proses yang akan membersihkannya.
    if (!entry.running) this.pending.delete(jid);
    return 1;
  }

  clearAll() {
    let n = 0;
    for (const jid of [...this.pending.keys()]) n += this.clear(jid);
    return n;
  }

  size() {
    return this.pending.size;
  }
}
