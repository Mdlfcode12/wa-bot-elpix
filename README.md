# WhatsApp Chatbot + Gemini API

Kerangka kerja: Google Sheets → pesan pembuka WhatsApp → percakapan lanjutan ditangani Gemini.

---

## 1. Tiga hal yang perlu diluruskan dulu

**Gemini free tier membuat biaya AI-nya nol** — tanpa kartu kredit. Tapi ada tiga
konsekuensi yang perlu diketahui sejak awal.

**Batas harian, bukan cuma per-menit.** Free tier punya plafon requests-per-day.
Kalau habis, menunggu satu menit tidak menolong — bot diam sampai tengah malam
waktu Pasifik. Ini ditangani `src/ai/quota.js`.

**Data kamu dipakai melatih model.** Dokumentasi Google menyatakan konten di free tier
bisa dipakai untuk meningkatkan produk mereka, sementara konten di tier berbayar tidak.
Untuk chatbot pelanggan, artinya isi percakapan pelanggan ikut terkirim. Timbang ini
terhadap UU PDP No. 27/2022 — dan setidaknya beri tahu pelangganmu. Mengaktifkan billing
memindahkanmu ke tier berbayar dan menghapus soal ini.

**Angka limitnya tidak lagi diterbitkan.** Google sudah menghapus tabel limit per-model
dari dokumentasi; sekarang tertulis bahwa limit tergantung usage tier dan harus dilihat
di AI Studio, dengan catatan angkanya tidak dijamin. Jadi buka
[aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) untuk melihat
angka project-mu sendiri, lalu setel `GEMINI_RPM_BUDGET` dan `GEMINI_RPD_BUDGET`
**di bawah** angka itu.

Hosting, database, dan Sheets juga bisa $0. Jadi total biaya bisa benar-benar nol,
dengan catatan bot mati kalau komputer dimatikan.

**Baileys tidak akan pernah "aman dari banned".** Baileys memakai protokol WhatsApp Web
tanpa izin Meta, jadi melanggar ToS. Kalau akun diblokir, tidak ada banding dan tidak
ada dukungan. Yang lebih penting: **penyebab utama banned bukan pola waktu, tapi laporan
penerima.** Sepuluh orang menekan "Blokir & Laporkan" akan menjatuhkan nomormu lebih
cepat daripada seribu pesan berjeda rapi. Delay acak dan warm-up ramp di kode ini
mengurangi risiko, tidak menghilangkannya. Kalau ini untuk bisnis yang serius,
WhatsApp Cloud API resmi punya 1.000 percakapan layanan gratis/bulan dan tidak bisa
dibanned sepihak.

**Bot harus mengaku bot.** Kode ini memasang disclosure di pesan pembuka dan melarang
AI mengaku manusia. Ini bukan sekadar etika — WhatsApp Business Policy mewajibkannya,
dan UU PDP No. 27/2022 mewajibkan dasar pemrosesan yang sah untuk nomor telepon. Kolom
`consent` di sheet adalah gerbangnya. Untuk kontak yang sudah kenal bisnismu (pelanggan,
leads yang isi form), sistem ini masuk akal. Untuk nomor hasil beli database, tidak.

---

## 2. Kendala arsitektur terbesar: scale-to-zero vs WebSocket

Ini yang biasanya bikin proyek seperti ini gagal di hari ketiga.

Baileys butuh **koneksi WebSocket hidup terus-menerus**. Sementara itu:

| Platform | Kendala | Cocok? |
|---|---|---|
| Render Free | Tidur setelah 15 menit idle, disk ephemeral | ❌ sesi putus terus |
| Koyeb Free | Scale-to-zero setelah 1 jam, tidak bisa dimatikan. Free tier ditutup untuk pengguna baru setelah akuisisi Mistral (awal 2026) | ❌ |
| Google Apps Script | Tidak bisa WebSocket, eksekusi maks 6 menit | ❌ untuk gateway |
| VPS murah (~$3–5/bln) | Selalu hidup | ✅ |
| PC/mini-PC di rumah + Cloudflare Tunnel | Gratis, selalu hidup | ✅ |

**Solusi kalau tetap ingin biaya minimal:**

Pisahkan jadi dua proses.

```
┌──────────────────────────────────────────────────────────────┐
│  GATEWAY (harus selalu hidup)                                │
│  Baileys ── WebSocket ── WhatsApp                            │
│  VPS termurah, atau PC rumah + Cloudflare Tunnel             │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTP webhook
                ▼
┌──────────────────────────────────────────────────────────────┐
│  BRAIN (boleh tidur)                                         │
│  Express → debounce queue → kuota → Gemini API         │
│  Render / Cloud Run free tier                                │
└───────────────┬──────────────────────────────────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
   Postgres         Google Sheets
   (Supabase/Neon)  (sumber kontak + status)
   sesi WA, histori
```

Kode ini ditulis sebagai satu proses agar mudah dipahami. Untuk memecahnya, jadikan
`handlers/inbound.js` sebuah endpoint HTTP dan panggil dari gateway.

**Yang sudah dipecahkan di kode ini:** `src/wa/authState.js` menyimpan sesi Baileys di
Postgres, bukan di disk. Jadi restart/redeploy berapa kali pun tidak perlu scan QR ulang —
ini yang membuat hosting berdisk ephemeral tetap bisa dipakai.

---

## 3. Alur data

**Kampanye (outbound):**
```
POST /campaign/run  (x-api-key)
  → fetchTargets()      baca sheet, filter consent=yes & status kosong
  → isRegistered()      cek nomor benar ada di WhatsApp
  → cek jam kerja + kuota harian + warm-up ramp
  → sendHumanLike()     presence → composing → kirim
  → markRow()           tulis "sent" balik ke sheet (idempoten kalau rerun)
  → sleep(45–180 detik acak)
```

**Balasan masuk (inbound):**
```
messages.upsert
  → filter grup / status / pesan sendiri
  → readMessages()      tandai dibaca
  → PerChatQueue        debounce 4 detik, gabungkan pesan beruntun
  → cek opt-out         "stop"/"berhenti" → keluar, TIDAK dikirim ke Gemini
  → loadHistory()       sliding window 12 pesan / 6.000 char / TTL 3 jam
  → TokenBucket         rem 40 req/menit
  → Semaphore           maks 3 panggilan bersamaan
  → askAI()             cek kuota harian, retry 429, backoff 503
  → sendHumanLike()
  → appendTurn()        simpan histori terpangkas
```

---

## 4. Kenapa tidak kena 429

Lima lapis, dari yang paling murah ke paling mahal:

0. **Kuota harian dihitung sendiri.** Free tier Gemini membatasi requests-per-day, dan
   ini berbeda sifatnya dari limit per-menit: 429 karena RPM sembuh dengan menunggu
   beberapa detik, 429 karena RPD tidak sembuh sampai tengah malam waktu Pasifik.
   Kalau keduanya diperlakukan sama, bot akan mengulang-ulang sepanjang sore untuk
   sesuatu yang mustahil berhasil. `src/ai/quota.js` menghitungnya di database
   (bukan di memori, supaya restart tidak mereset), lalu berhenti mencoba dan
   memberi tahu kamu lewat panel.


1. **Debounce per-kontak (4 detik).** User yang mengirim "halo" / "mau tanya" /
   "soal harga" berturut-turut = 1 panggilan API, bukan 3. Ini penghemat terbesar.
2. **Sliding window histori.** Setiap panggilan mengirim ulang seluruh histori sebagai
   input token. Tanpa pemangkasan, percakapan 50 pesan ≈ 8.000 input token *per balasan*.
   Dengan window, biaya per balasan konstan, bukan tumbuh linear. Ini kunci ITPM.
3. **Token bucket 40 RPM.** Plafon yang kita paksakan sendiri di bawah limit tier,
   jadi 429 nyaris tidak pernah terjadi.
4. **Backoff yang benar saat tetap kena.** 429 → pakai `retryDelay` dari detail error
   kalau ada, kalau tidak eksponensial + jitter. 503 `UNAVAILABLE` (server Google sibuk,
   bukan kuotamu) → eksponensial. 400/401/404 → jangan retry, itu bug konfigurasi.
   Respons kosong karena safety filter juga ditangani — tanpa itu, bot mengirim
   pesan kosong ke pelanggan.

Bonus: `thinkingConfig: { thinkingBudget: 0 }`. Model Gemini 2.5+ menyalakan penalaran
internal secara default. Untuk balasan WhatsApp 2–3 kalimat itu mubazir — menambah
latensi beberapa detik dan memakan token output yang dihitung ke kuota.

---

## 5. Setup

Panduan lengkap langkah demi langkah ada di **[SETUP.md](SETUP.md)** — termasuk
pemasangan di komputer sendiri, yang justru lebih cocok untuk Baileys daripada
hosting gratis karena tidak ada scale-to-zero.

Ringkasnya:

```bash
npm install
cp .env.example .env   # isi semua nilai
npm run check          # uji tiap kredensial TANPA menyentuh WhatsApp
npm start              # scan QR di terminal, sekali saja
```

`npm run check` memanggil Gemini dan membaca Sheets sungguhan, lalu melaporkan
persis mana yang belum benar. Jalankan ini sebelum `npm start` — kesalahan
konfigurasi paling mahal adalah yang baru ketahuan setelah bot mengirim pesan.

**Database** — Supabase atau Neon free tier, ambil connection string → `DATABASE_URL`.
Tabel dibuat otomatis saat start.

**Google Sheets** — Google Cloud Console → buat service account → download JSON →
`base64 -w0 service-account.json` → masukkan ke `GOOGLE_SERVICE_ACCOUNT_JSON`.
Lalu **share spreadsheet ke email service account** (tanpa ini, error 403).

Layout tab `Contacts`:

| A: nomor | B: nama | C: konteks | D: consent | E: status | F: sent_at |
|---|---|---|---|---|---|
| 081234567890 | Budi | follow-up pesanan #1123 | yes | | |

**Jalankan kampanye:**
```bash
curl -X POST https://host-kamu/campaign/run -H "x-api-key: $ADMIN_KEY"
```

**Keep-alive** (kalau hosting suka tidur) — cron-job.org ping `/health` tiap 10 menit.
Ini menahan tidur idle, tapi tidak menahan restart platform. Auth state di Postgres yang
menyelamatkan kasus kedua.

---

## 6. Kontrol admin — panel web

Semua kontrol ada di satu halaman: `https://host-kamu/`. Tidak perlu nomor WhatsApp kedua
dan tidak perlu menghafal perintah apa pun.

```
┌─────────────────────────────────────────────┐
│  AI AKTIF                    [ Hentikan ]   │  ← status + kill switch
│  12 pesan pembuka hari ini · 2 dipegang     │
├──────────────────┬──────────────────────────┤
│ ● Budi           │  Budi   [ Ambil alih ]   │
│   masih ready?   │                          │
│ ◐ Sari           │  Pelanggan  masih ready? │
│   ↩ Saya cek…    │  AI         Masih ada…   │
│ ○ Andi           │  Kamu       Besok kirim  │
│   ↩ Baik, kamu…  │                          │
│                  ├──────────────────────────┤
│                  │ [ketik balasan…] [Kirim] │
└──────────────────┴──────────────────────────┘
   ● AI   ◐ kamu pegang   ○ minta berhenti
```

**Yang bisa dilakukan dari sini:**

| | |
|---|---|
| Tombol `Hentikan` | Matikan semua balasan AI seketika |
| Tombol `Ambil alih` | AI diam untuk satu percakapan saja |
| Kotak balasan | Balas pelanggan langsung dari browser |
| Feed langsung | Pesan masuk muncul sendiri, tanpa refresh |

Mengirim balasan manual otomatis mengambil alih percakapan itu, supaya AI tidak
menyahut di tengah kamu mengetik. Klik `Kembalikan ke AI` kalau sudah selesai.

Layout menyesuaikan layar HP: daftar percakapan dulu, ketuk untuk membuka isinya.
Tambahkan ke layar utama lewat menu browser kalau ingin seperti aplikasi.

### Kenapa cookie, bukan kunci di setiap request

`EventSource` (yang dipakai feed langsung) tidak bisa mengirim header custom. Kalau
autentikasi pakai `x-api-key`, kunci harus ditaruh di URL — dan URL bocor ke log server,
riwayat browser, serta header `Referer`. Jadi login sekali menukar `ADMIN_KEY` dengan
cookie `HttpOnly; SameSite=Strict` yang berlaku 12 jam. Perbandingan kunci memakai
`timingSafeEqual`, dan login ditolak kalau `ADMIN_KEY` kurang dari 16 karakter.

### Notifikasi saat panel tidak terbuka

Set `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` (opsional). Telegram Bot API gratis dan
tidak minta nomor tambahan. Kamu akan didorong pesan saat ada percakapan yang dieskalasi
atau saat Gemini gagal membalas. Kosongkan kalau tidak perlu — peringatan tetap muncul
di panel.

### Eskalasi otomatis

Kalau pelanggan menyebut hal seperti "penipuan", "refund", "somasi", atau "mau bicara
sama manusia", AI langsung berhenti untuk chat itu, menutup dengan satu kalimat sopan,
dan menandainya di panel. Daftar frasanya ada di `ESCALATE` dalam
`src/handlers/inbound.js` — sesuaikan dengan bisnismu.

### Tiga hal yang membuat tombol ini benar-benar bekerja

1. **Flag disimpan di Postgres, bukan di memori.** Hosting gratis me-restart proses kapan
   saja. Kalau kill switch cuma variabel, bot yang kamu matikan malam hari akan hidup lagi
   sendiri setelah restart dan mulai membalas pelanggan tanpa kamu tahu.

2. **Dicek di tiga titik, bukan satu.** Saat pesan masuk, sebelum memanggil Gemini, dan
   sekali lagi tepat sebelum mengirim. Panggilan Gemini makan beberapa detik — kalau STOP
   ditekan di tengah itu, balasannya tidak boleh lolos.

3. **Antrean debounce ikut dibuang.** Pesan yang sudah masuk jeda 4 detik sebelum kamu
   menekan STOP tetap akan terkirim kalau antreannya tidak dikosongkan. Tombol Hentikan
   memanggil `queue.clearAll()` dan melaporkan berapa balasan yang dibatalkan.

**Dua log yang berbeda.** `conversations.history` dipangkas — itu yang dilihat Gemini,
demi menghemat token. Tabel `messages` menyimpan semuanya utuh — itu yang kamu lihat di
panel. Memangkas konteks AI tidak boleh berarti kamu ikut kehilangan riwayat.

Setiap penekanan tombol dicatat di `admin_audit` beserta pelaku dan waktunya.

---

## 7. Checklist sebelum produksi

- [ ] Uji ke 3–5 nomor sendiri dulu, minimal 2 hari
- [ ] Pakai nomor terpisah, jangan nomor pribadi atau nomor utama bisnis
- [ ] Nomor sudah "hangat": ada riwayat chat normal, foto profil, nama bisnis terisi
- [ ] `ADMIN_KEY` minimal 16 karakter acak (`openssl rand -hex 32`); `.env` masuk `.gitignore`
- [ ] Panel hanya diakses lewat HTTPS, dan `NODE_ENV=production` supaya cookie `Secure`
- [ ] Pantau rasio balasan hari pertama. Kalau banyak yang tidak membalas atau
      memblokir, hentikan — daftar kontaknya yang bermasalah, bukan kodenya
- [ ] Siapkan jalur eskalasi ke manusia; jangan biarkan AI menangani keluhan serius
- [ ] Pantau sisa kuota harian di baris status panel selama minggu pertama
