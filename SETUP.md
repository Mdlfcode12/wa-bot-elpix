# Panduan Pasang di Komputer Sendiri

Perkiraan waktu: 45–60 menit. Sebagian besar dihabiskan menunggu verifikasi Google
dan Google, bukan mengetik.

Komputer lokal justru **lebih cocok** untuk Baileys daripada hosting gratis: tidak ada
scale-to-zero yang memutus koneksi WhatsApp. Kelemahannya, bot mati kalau komputer
dimatikan atau internet putus.

---

## Langkah 1 — Node.js

Butuh versi 20 atau lebih baru.

```bash
node -v
```

Kalau belum ada atau versinya di bawah 20, unduh dari [nodejs.org](https://nodejs.org)
(pilih LTS). Windows: pakai installer. macOS: `brew install node`.
Linux: pakai [nvm](https://github.com/nvm-sh/nvm).

---

## Langkah 2 — Siapkan proyek

Letakkan folder `wa-claude-bot` di mana saja, lalu:

```bash
cd wa-claude-bot
npm install
cp .env.example .env
```

Windows PowerShell pakai `copy .env.example .env`.

Buka `.env` dengan editor teks. Sisa panduan ini mengisi file itu.

---

## Langkah 3 — Database

Sesi WhatsApp, riwayat percakapan, dan status tombol semuanya disimpan di sini.

**Cara termudah — Neon (cloud, gratis, tanpa install):**

1. Daftar di [neon.tech](https://neon.tech), buat project baru
2. Salin connection string (bentuknya `postgresql://user:pass@ep-xxx.neon.tech/neondb`)
3. Tempel ke `DATABASE_URL` di `.env`

Ini juga berarti kalau nanti pindah ke server, databasenya ikut tanpa migrasi.

**Alternatif — Postgres lokal via Docker.** Panduan lengkapnya ada di
[DOCKER.md](DOCKER.md). Ringkasnya: pasang Docker, lalu dari folder proyek

```bash
docker compose up -d
```

lalu isi `.env`:

```
DATABASE_URL=postgresql://wabot:PASSWORD_KAMU@localhost:5432/wabot
```

Kode mendeteksi `localhost` dan mematikan SSL otomatis. Tabel dibuat sendiri saat
pertama kali `npm start` — tidak ada migrasi manual.

Pilih Neon kalau ingin cepat selesai dan tidak mau mengurus backup. Pilih Docker kalau
ingin datanya tidak keluar dari komputermu, atau sering bekerja tanpa internet.

---

## Langkah 4 — Kunci Gemini

Gratis, tanpa kartu kredit.

1. Buka [aistudio.google.com/apikey](https://aistudio.google.com/apikey), masuk dengan
   akun Google
2. **Create API key** → pilih atau buat project → salin
3. Tempel ke `GEMINI_API_KEY` di `.env`

**Lalu buka [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit).**
Jangan lewati langkah ini. Google sudah menghapus tabel limit per-model dari
dokumentasinya — angka RPM dan RPD sekarang hanya bisa dilihat per project di halaman
itu, dan bisa berbeda antar akun serta antar wilayah.

Catat angkanya, lalu isi di `.env` dengan nilai **lebih rendah** dari yang tertera:

```
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_RPM_BUDGET=12     # kalau AI Studio menunjukkan 15 RPM
GEMINI_RPD_BUDGET=400    # kalau AI Studio menunjukkan 500 RPD
```

Menyisakan jarak itu disengaja: kalau kamu setel sama persis, satu request yang
telat terhitung sudah cukup untuk memicu 429.

Kalau `gemini-3.1-flash-lite` tidak ada di daftar project-mu, pakai model Flash atau
Flash-Lite mana pun yang tercantum. Flash-Lite biasanya punya kuota lebih longgar
dengan kualitas sedikit di bawahnya — untuk balasan WhatsApp pendek, bedanya kecil.

**Dua hal yang perlu diketahui soal free tier:**

Isi percakapan pelanggan bisa dipakai Google untuk meningkatkan produk mereka —
dokumentasi Google menyatakan konten free tier dipakai untuk itu, sementara konten
tier berbayar tidak. Timbang ini terhadap UU PDP No. 27/2022, dan setidaknya beri
tahu pelangganmu. Mengaktifkan billing memindahkanmu ke tier berbayar dan menghapus
soal ini.

Langganan Gemini Advanced / Google AI Pro **tidak** memberi akses API. Sama seperti
Claude Pro, itu produk terpisah. Kunci dari AI Studio di atas yang kamu butuhkan.

## Langkah 5 — Kunci admin panel

```bash
openssl rand -hex 32
```

Windows tanpa openssl:
```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
```

Salin hasilnya ke `ADMIN_KEY`. Minimal 16 karakter — kalau kurang, panel menolak login
sama sekali (supaya lupa mengisi tidak berarti panel terbuka untuk siapa saja).

---

## Langkah 6 — Google Sheets (boleh dilewati dulu)

Ini hanya untuk fitur pesan pembuka. Chatbot balasannya tetap jalan tanpa ini,
jadi kamu bisa lompat ke Langkah 7 dan kembali ke sini nanti.

**Buat service account:**

1. [console.cloud.google.com](https://console.cloud.google.com) → buat project baru
2. **APIs & Services** → **Library** → cari "Google Sheets API" → **Enable**
3. **APIs & Services** → **Credentials** → **Create Credentials** →
   **Service account** → beri nama apa saja → **Done**
4. Klik service account yang baru dibuat → tab **Keys** → **Add Key** →
   **Create new key** → **JSON** → file terunduh

**Ubah ke base64:**

```bash
base64 -w0 service-account.json          # Linux
base64 -i service-account.json           # macOS
```
```powershell
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

Tempel hasilnya (satu baris panjang) ke `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Simpan file JSON-nya di luar folder proyek.** Hanya string base64 di `.env` yang
dibaca aplikasi — file aslinya tidak pernah dibuka oleh kode. Gitignore mencegahnya
ter-commit, tapi tidak mencegahnya ikut tersalin waktu folder proyek dizip atau
dikirim ke orang lain. Taruh di `~/.secrets/wa-claude-bot/` (Windows:
`%USERPROFILE%\.secrets\wa-claude-bot\`).

**Siapkan spreadsheet:**

Buat spreadsheet baru, ganti nama tab pertama jadi `Contacts`, isi baris 1 sebagai header:

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| nomor | nama | konteks | consent | status | sent_at |
| 081234567890 | Budi | follow-up pesanan #1123 | yes | | |

Kolom **consent** wajib `yes`. Baris tanpa itu dilewati — ini gerbang yang mencegah
kamu mengirim ke orang yang tidak mengharapkannya.

Ambil `SHEET_ID` dari URL:
`docs.google.com/spreadsheets/d/`**`INI_BAGIAN_ID_NYA`**`/edit`

**Yang paling sering terlewat:** klik **Share** di spreadsheet, tambahkan email service
account (bentuknya `nama@project.iam.gserviceaccount.com`, ada di file JSON tadi),
beri akses **Editor**. Tanpa ini kamu akan dapat error 403.

---

## Langkah 7 — Telegram untuk notifikasi (opsional)

Supaya kamu tetap tahu ada percakapan butuh manusia walau panel sedang tertutup.

1. Chat [@BotFather](https://t.me/botfather) di Telegram → `/newbot` → ikuti → salin token
2. Kirim satu pesan apa saja ke bot barumu
3. Buka `https://api.telegram.org/bot<TOKEN>/getUpdates` di browser, cari angka
   di `"chat":{"id":...}`
4. Isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID`

---

## Langkah 8 — Cek sebelum menyalakan

```bash
npm run check
```

Skrip ini menguji setiap kredensial secara terpisah — termasuk memanggil Gemini sungguhan
dan membaca Sheets sungguhan — **tanpa menyentuh WhatsApp sama sekali**. Kesalahan
konfigurasi paling mahal adalah yang baru ketahuan setelah bot mulai mengirim pesan.

Tampilan kalau ada yang salah:

```
  ✓ Node 22.22.2
  ✗ ADMIN_KEY kurang dari 16 karakter. Buat dengan: openssl rand -hex 32
  ✗ Postgres gagal: connect ECONNREFUSED 127.0.0.1:5432
  ✗ GEMINI_API_KEY ditolak. Ambil kunci baru di aistudio.google.com/apikey
  ! Google Sheets belum diisi — fitur pesan pembuka mati.

3 masalah harus dibereskan sebelum menjalankan bot.
```

Tanda `!` adalah peringatan, boleh diabaikan. Tanda `✗` harus dibereskan.

---

## Langkah 9 — Nyalakan dan sambungkan WhatsApp

```bash
npm start
```

QR code muncul di terminal. Di HP: **WhatsApp** → **Setelan** → **Perangkat Tertaut** →
**Tautkan Perangkat** → scan.

Kalau berhasil:
```
[WA] Tersambung sebagai 628xxx:12@s.whatsapp.net
[http] panel di :3000
```

Scan QR hanya sekali. Sesinya tersimpan di database, jadi restart berapa kali pun
tidak perlu scan lagi.

**Pakai nomor terpisah**, bukan nomor pribadi atau nomor utama bisnis. Baileys melanggar
ToS WhatsApp; kalau akun diblokir, tidak ada banding.

---

## Langkah 10 — Buka panel dan uji

Buka `http://localhost:3000`, tempel `ADMIN_KEY`.

Uji dari HP lain: kirim pesan ke nomor bot. Dalam beberapa detik pesannya muncul di panel
dan AI membalas.

Uji tombolnya juga:

- Tekan **Hentikan** → kirim pesan lagi → harus masuk ke panel tapi tidak dibalas
- Tekan **Nyalakan** → AI jalan lagi
- Buka satu percakapan → ketik di kotak balasan → **Kirim**. Pesan terkirim dan
  chat itu otomatis diambil alih (AI diam di sana)

---

## Langkah 11 — Kampanye pesan pembuka

Setelah Sheets siap:

```bash
curl -X POST http://localhost:3000/campaign/run \
  -H "Content-Type: application/json" \
  -b "sid=..." 
```

Lebih mudah: buka DevTools browser (F12) di panel yang sudah login, tab Console, jalankan:

```js
fetch('/campaign/run', { method: 'POST' }).then(r => r.json()).then(console.log)
```

Cookie sesi ikut terkirim otomatis. Progres muncul di terminal.

**Uji ke 3–5 nomor milikmu sendiri dulu, minimal dua hari**, sebelum menyentuh
pelanggan asli.

---

## Membuka panel dari HP

Selama satu jaringan WiFi, cari IP lokal komputermu (`ipconfig` di Windows,
`ifconfig | grep inet` di macOS/Linux), lalu buka `http://192.168.x.x:3000` dari HP.

Kalau ingin diakses dari mana saja, pakai Cloudflare Tunnel — gratis, tidak perlu
buka port router:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Perintah itu mengeluarkan URL publik. Set `NODE_ENV=production` di `.env` supaya
cookie sesi memakai flag `Secure`.

---

## Kalau macet

| Gejala | Sebabnya biasanya |
|---|---|
| `ECONNREFUSED ...:5432` | Postgres belum jalan, atau `DATABASE_URL` salah |
| QR muncul terus, tidak tersambung | QR kedaluwarsa dalam ~20 detik. Tunggu QR baru, scan lebih cepat |
| `Logged out`, minta scan ulang | Sesi dicabut dari HP, atau akun kena aksi WhatsApp |
| Error 403 dari Sheets | Spreadsheet belum di-share ke email service account |
| Panel bilang "Kunci salah" | `ADMIN_KEY` di `.env` beda dengan yang kamu tempel, atau server belum di-restart |
| AI tidak membalas tapi pesan masuk ke panel | Tombol dalam posisi Hentikan, atau chat itu sedang diambil alih |
| `429` di log | Normal sesekali. Kode menunggu lalu mencoba lagi |
| Bot mendadak diam sore hari | Kuota harian habis. Cek sisa kuota di baris status panel. Reset tengah malam waktu Pasifik |
| `Model not found` | Nama model di `.env` tidak tersedia untuk project-mu. Cek daftar di AI Studio |

Baca log terminal lebih dulu — hampir semua masalah sudah dijelaskan di sana.

---

## Agar tetap jalan saat terminal ditutup

**macOS / Linux:**
```bash
npm install -g pm2
pm2 start src/index.js --name wabot
pm2 save
pm2 startup        # ikuti perintah yang muncul, agar auto-start saat boot
pm2 logs wabot
```

**Windows:** pakai `pm2` juga, atau jalankan lewat WSL.

Matikan juga sleep otomatis di pengaturan daya — komputer yang tidur memutus koneksi
WhatsApp.
