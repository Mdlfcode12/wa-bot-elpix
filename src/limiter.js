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
    for (;;) {
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

    entry.texts.push(text);
    if (entry.timer) clearTimeout(entry.timer);

    entry.timer = setTimeout(async () => {
      if (entry.running) {
        // Balasan sebelumnya masih diproses — jadwalkan ulang, jangan tumpuk.
        entry.timer = setTimeout(() => this.push(jid, '', handler), this.debounceMs);
        return;
      }
      const batch = entry.texts.join('\n').trim();
      entry.texts = [];
      entry.running = true;
      try {
        if (batch) await handler(jid, batch);
      } catch (e) {
        console.error(`[queue] ${jid}:`, e.message);
      } finally {
        entry.running = false;
        if (!entry.texts.length) this.pending.delete(jid);
      }
    }, this.debounceMs);
  }

  /**
   * Buang balasan yang masih menunggu di antrean.
   * Penting untuk tombol STOP: tanpa ini, pesan yang sudah masuk debounce
   * 4 detik sebelum kamu menekan STOP tetap akan terkirim setelahnya.
   */
  clear(jid) {
    const entry = this.pending.get(jid);
    if (!entry) return 0;
    if (entry.timer) clearTimeout(entry.timer);
    entry.texts = [];
    this.pending.delete(jid);
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
