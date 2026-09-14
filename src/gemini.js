import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { TokenBucket, Semaphore } from './limiter.js';
import { takeDailyQuota, remainingToday } from './quota.js';
import { fetchCatalog } from './sheets.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const bucket = new TokenBucket(config.gemini.rpmBudget);
const sem = new Semaphore(config.gemini.concurrency);

const SYSTEM_PROMPT = `Kamu adalah asisten WhatsApp untuk {{BUSINESS}} sekaligus rekan kerja yang santai dan suportif.

Aturan:
- Gunakan bahasa Indonesia yang kasual, natural, asik, dan akrab layaknya ngobrol dengan teman kerja (misal: pakai "aku/saya", "kamu", sapaan ramah).
- Posisikan dirimu setara sebagai partner/rekan kerja, BUKAN sebagai pelayan atau bawahan kaku.
- DI AWAL PERCAKAPAN (jika baru pertama ngobrol dan namanya belum diketahui), kamu WAJIB menanyakan nama lawan bicaramu dengan santai.
- Jika nama lawan bicara sudah ada di konteks, SELALU sapa mereka dengan namanya secara spesifik (contoh: "Halo Mas Dafa", "Oke Mbak", dsb).
- Kamu adalah asisten AI. Kalau ditanya "ini bot ya?", jawab jujur dengan santai kalau kamu asisten otomatis, dan tawarkan nyambung ke tim manusia. JANGAN PERNAH mengaku sebagai manusia.
- ATURAN RESPON PESAN:
  a. Jika pelanggan HANYA bertanya pertanyaan umum (salam, sapaan, tanya harga, lokasi, atau pertanyaan singkat), jawab secara alami dan ramah via TEKS SAJA. JANGAN sertakan tag [KIRIM_FOTO].
  b. Jika pelanggan meminta detail lengkap properti/kost, berikan SELURUH ISI LENGKAP dari "Deskripsi & Detail Iklan" (Copy_Script_Jualan) secara utuh, beserta Link Maps dan Website Detail dan fotonya.
  c. HANYA JIKA pelanggan secara EKSPLISIT meminta FOTO / GAMBAR / KATALOG VISUAL (contoh: "minta foto", "kirim foto", "bisa lihat gambarnya?", "spill fotonya"), tambahkan tag [KIRIM_FOTO] di akhir pesanmu agar sistem mengirimkan foto produk!
  d. JANGAN PERNAH MENCANTUMKAN LINK FOTO GOOGLE DRIVE DI DALAM TEKS BALASAN, karena foto dikirimkan otomatis oleh sistem secara terpisah.
- PENTING (Kontak Bu Elisa / Info Lanjut): Berikan isi dari "Kontak Info Lanjut" (kontak Bu Elisa) HANYA JIKA pelanggan meminta foto properti lengkap atau ingin menjadwalkan survei lokasi. JANGAN berikan kontak ini pada pertanyaan umum lainnya.
- Jika ada pertanyaan yang jawabannya tidak ada di katalog, cukup katakan jujur bahwa data tersebut belum tersedia.
- Jangan pernah menjanjikan harga, diskon, atau ketersediaan stok yang tidak ada di konteks.
- Kalau lawan bicara minta berhenti dihubungi, konfirmasi dengan singkat dan sopan.
- PENTING: Jika di dalam chat ini agen mengonfirmasi atau sepakat untuk jadwal survei properti, tambahkan tag [SURVEI] di akhir pesanmu (contoh: "Baik pak, ditunggu kehadirannya besok. [SURVEI]").
- PENTING: Jika agen menyatakan deal berhasil menjual atau membawa pembeli (buyer), tambahkan tag [BUYER] di akhir pesanmu (contoh: "Terima kasih pak atas kerjasamanya! [BUYER]").

Katalog Produk (JANGAN tawarkan produk di luar list ini):
PENTING: Perhatikan 'Status' pada tiap properti. Jika 'Status' bukan 'Available' (misal: 'SoldOut'), beritahu dengan sopan bahwa properti tersebut sudah terjual.
{{CATALOG}}

Konteks kontak ini: {{CONTEXT}}`;

/**
 * Histori disimpan di database dengan format netral ('user' / 'assistant').
 * Gemini memakai 'model', bukan 'assistant'. Konversi dilakukan di sini saja,
 * supaya database tetap portabel kalau suatu saat ganti penyedia AI lagi.
 */
const toGeminiContents = (history) =>
  history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

let cachedCatalog = null;
let lastCatalogFetch = 0;
const CATALOG_TTL = 60000; // 1 menit

async function getCatalogContext() {
  const now = Date.now();
  if (cachedCatalog === null || (now - lastCatalogFetch > CATALOG_TTL)) {
    cachedCatalog = await fetchCatalog();
    lastCatalogFetch = now;
  }
  return cachedCatalog;
}

export async function askAI({ history, name, context, business = 'kami' }) {
  const catalogData = await getCatalogContext();

  const systemInstruction = SYSTEM_PROMPT
    .replace('{{BUSINESS}}', business)
    .replace('{{CATALOG}}', catalogData || '(Belum ada data katalog)')
    .replace('{{CONTEXT}}', `Nama: ${name || 'tidak diketahui'}. ${context || '-'}`);

  return sem.run(async () => {
    // Kuota HARIAN dicek lebih dulu. Ini batas yang tidak ada di Claude:
    // free tier Gemini punya plafon requests-per-day, dan kalau habis,
    // menunggu satu menit tidak menolong — harus tunggu tengah malam waktu Pasifik.
    if (!(await takeDailyQuota())) {
      throw new Error(`Kuota harian Gemini habis (${config.gemini.rpdBudget} request). Reset tengah malam waktu Pasifik.`);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await bucket.take();

      try {
        const res = await ai.models.generateContent({
          model: config.gemini.model,
          contents: toGeminiContents(history),
          config: {
            systemInstruction,
            maxOutputTokens: config.gemini.maxTokens,
            temperature: 0.7,
            // Model Gemini 2.5+ menyalakan "thinking" secara default. Untuk balasan
            // WhatsApp 2-3 kalimat itu mubazir: menambah latensi beberapa detik dan
            // memakan token output yang dihitung ke kuota. Dimatikan.
            thinkingConfig: { thinkingBudget: 0 },
          },
        });

        const text = res.text?.trim();

        if (!text) {
          // Gemini bisa memblokir respons lewat safety filter dan mengembalikan
          // kandidat kosong tanpa melempar error. Tanpa penanganan ini,
          // bot akan mengirim pesan kosong ke pelanggan.
          const reason =
            res.promptFeedback?.blockReason ||
            res.candidates?.[0]?.finishReason ||
            'tidak diketahui';
          throw new Error(`Gemini tidak mengembalikan teks (alasan: ${reason})`);
        }

        return text;
      } catch (err) {
        const status = err?.status ?? err?.code;
        const msg = String(err?.message || '');

        if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
          // Gemini kadang menyertakan retryDelay di detail error.
          const hinted = msg.match(/retryDelay["\s:]+(\d+)s/)?.[1];
          const waitMs = (hinted ? Number(hinted) : 2 ** attempt * 2) * 1000 + Math.random() * 1000;
          console.warn(`[gemini] 429, tunggu ${Math.round(waitMs / 1000)}s (sisa hari ini: ${await remainingToday()})`);
          await sleep(waitMs);
          continue;
        }

        if ([500, 502, 503, 504].includes(status) || /UNAVAILABLE|overloaded/i.test(msg)) {
          const waitMs = 2 ** attempt * 1000 + Math.random() * 1000;
          console.warn(`[gemini] ${status || 'UNAVAILABLE'}, backoff ${Math.round(waitMs / 1000)}s`);
          await sleep(waitMs);
          continue;
        }

        throw err; // 400/401/403/404 = salah konfigurasi, percuma diulang
      }
    }

    throw new Error('Gemini tidak merespons setelah beberapa percobaan');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
