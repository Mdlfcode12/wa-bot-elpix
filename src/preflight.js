import 'dotenv/config';

/**
 * Jalankan `npm run check` sebelum `npm start`.
 *
 * Kesalahan konfigurasi paling mahal adalah yang baru ketahuan setelah bot
 * tersambung ke WhatsApp dan mulai mengirim pesan. Skrip ini menguji setiap
 * kredensial secara terpisah — tanpa menyentuh WhatsApp sama sekali.
 */

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); gagal++; };
const warn = (m) => console.log(`  ! ${m}`);
let gagal = 0;

console.log('\nCek konfigurasi\n');

// --- Node ---
const major = Number(process.versions.node.split('.')[0]);
major >= 20
  ? ok(`Node ${process.versions.node}`)
  : bad(`Node ${process.versions.node} — Baileys butuh Node 20 atau lebih baru`);

// --- Kunci admin ---
const adminKey = process.env.ADMIN_KEY || '';
if (adminKey.length >= 16) ok(`ADMIN_KEY (${adminKey.length} karakter)`);
else bad('ADMIN_KEY kurang dari 16 karakter. Buat dengan: openssl rand -hex 32');

// --- Database ---
if (!process.env.DATABASE_URL) {
  bad('DATABASE_URL kosong');
} else {
  try {
    const pg = (await import('pg')).default;
    const local = /localhost|127\.0\.0\.1|::1/.test(process.env.DATABASE_URL);
    const c = new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: local ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    await c.connect();
    const { rows } = await c.query('SELECT version()');
    await c.end();
    ok(`Postgres tersambung${local ? ' (lokal)' : ' (remote)'} — ${rows[0].version.split(',')[0]}`);
  } catch (e) {
    bad(`Postgres gagal: ${e.message}`);
  }
}

// --- Gemini ---
if (!process.env.GEMINI_API_KEY) {
  bad('GEMINI_API_KEY kosong');
} else {
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const r = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Balas satu kata: siap' }] }],
      config: { maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } },
    });
    r.text?.trim()
      ? ok(`Gemini menjawab (${model})`)
      : bad(`Gemini tidak mengembalikan teks. Model "${model}" mungkin tidak tersedia untuk project ini.`);
  } catch (e) {
    const m = String(e?.message || '');
    if (/API key not valid|API_KEY_INVALID|401/i.test(m))
      bad('GEMINI_API_KEY ditolak. Ambil kunci baru di aistudio.google.com/apikey');
    else if (/not found|NOT_FOUND|404/i.test(m))
      bad(`Model "${model}" tidak ditemukan. Cek nama model yang tersedia di AI Studio.`);
    else if (/RESOURCE_EXHAUSTED|429|quota/i.test(m))
      bad('Kuota Gemini sudah habis. Cek aistudio.google.com/rate-limit');
    else if (/location|not supported|FAILED_PRECONDITION/i.test(m))
      bad('Gemini API belum tersedia untuk wilayah ini, atau butuh billing aktif.');
    else bad(`Gemini gagal: ${m}`);
  }

  // Limit sebenarnya hanya bisa dilihat per project di AI Studio, jadi yang bisa
  // dicek di sini cuma kewajaran angka yang kamu setel sendiri.
  const rpm = Number(process.env.GEMINI_RPM_BUDGET || 8);
  const rpd = Number(process.env.GEMINI_RPD_BUDGET || 200);
  if (rpm > 15)
    warn(`GEMINI_RPM_BUDGET=${rpm} melebihi limit free tier Gemini 3.1 Flash Lite (15 RPM). Akan kena 429 terus.`);
  else ok(`Anggaran laju: ${rpm} req/menit, ${rpd} req/hari`);
}

// --- Google Sheets (opsional) ---
if (!process.env.SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  warn('Google Sheets belum diisi — fitur pesan pembuka mati. Chatbot tetap bisa membalas.');
} else {
  try {
    const { google } = await import('googleapis');
    const creds = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8')
    );
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const api = google.sheets({ version: 'v4', auth });
    const { data } = await api.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: process.env.SHEET_RANGE || 'Contacts!A2:F',
    });
    const rows = data.values || [];
    const siap = rows.filter((r) => (r[3] || '').toLowerCase().trim() === 'yes').length;
    ok(`Sheets terbaca — ${rows.length} baris, ${siap} punya consent=yes`);
    if (rows.length && !siap)
      warn('Tidak ada baris dengan consent=yes. Kampanye tidak akan mengirim apa pun.');
  } catch (e) {
    if (/permission|403/i.test(e.message))
      bad(`Sheets ditolak. Sudah share spreadsheet ke email service account?`);
    else bad(`Sheets gagal: ${e.message}`);
  }
}

// --- Telegram (opsional) ---
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: 'Cek konfigurasi berhasil. Notifikasi aktif.',
        }),
      }
    );
    r.ok ? ok('Telegram — pesan uji terkirim, cek HP-mu') : bad(`Telegram ditolak (${r.status})`);
  } catch (e) {
    bad(`Telegram gagal: ${e.message}`);
  }
} else {
  warn('Telegram belum diisi — notifikasi hanya muncul saat panel terbuka.');
}

console.log(
  gagal
    ? `\n${gagal} masalah harus dibereskan sebelum menjalankan bot.\n`
    : '\nSemua siap. Jalankan: npm start\n'
);
process.exit(gagal ? 1 : 0);
