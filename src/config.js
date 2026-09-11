import 'dotenv/config';

const num = (v, d) => (v === undefined ? d : Number(v));

export const config = {
  // --- Gemini ---
  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    // Google TIDAK lagi menerbitkan tabel limit per-model di dokumentasi.
    // Cek model mana yang gratis untuk project-mu di
    // https://aistudio.google.com/rate-limit lalu sesuaikan tiga nilai di bawah.
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    maxTokens: num(process.env.GEMINI_MAX_TOKENS, 400),
    concurrency: num(process.env.GEMINI_CONCURRENCY, 2),
    // Gemini 3.1 Flash Lite free tier: RPM limit=15, RPD limit=500.
    // Setel DI BAWAH limit asli project-mu, bukan sama persis.
    rpmBudget: num(process.env.GEMINI_RPM_BUDGET, 12),
    // Batas harian 500 RPD jauh lebih aman untuk penggunaan harian.
    rpdBudget: num(process.env.GEMINI_RPD_BUDGET, 400),
  },

  // --- Memory / histori percakapan ---
  memory: {
    maxTurns: num(process.env.MEMORY_MAX_TURNS, 12),      // 12 pesan terakhir (6 pertukaran)
    maxChars: num(process.env.MEMORY_MAX_CHARS, 6000),    // hard cap karakter histori
    ttlMinutes: num(process.env.MEMORY_TTL_MINUTES, 180), // sesi dianggap basi setelah 3 jam
  },

  // --- Pengiriman pesan pembuka (outbound) ---
  outbound: {
    minDelayMs: num(process.env.OUT_MIN_DELAY_MS, 45_000),   // 45 detik
    maxDelayMs: num(process.env.OUT_MAX_DELAY_MS, 180_000),  // 3 menit
    dailyCap: num(process.env.OUT_DAILY_CAP, 40),            // batas kirim per hari
    warmupDays: num(process.env.OUT_WARMUP_DAYS, 7),         // ramp-up bertahap
    windowStartHour: num(process.env.OUT_WINDOW_START, 9),   // jam lokal 09:00
    windowEndHour: num(process.env.OUT_WINDOW_END, 19),      // s/d 19:00
    timezone: process.env.TZ || 'Asia/Jakarta',
  },

  // --- Typing indicator ---
  typing: {
    charsPerSecond: num(process.env.TYPING_CPS, 18),
    minMs: num(process.env.TYPING_MIN_MS, 1200),
    maxMs: num(process.env.TYPING_MAX_MS, 9000),
    readDelayMs: num(process.env.READ_DELAY_MS, 2500), // jeda "membaca" sebelum mulai mengetik
  },

  // --- Google Sheets ---
  sheets: {
    spreadsheetId: process.env.SHEET_ID,
    range: process.env.SHEET_RANGE || 'Contacts!A2:F',
    catalogRange: process.env.SHEET_CATALOG_RANGE || 'Katalog!A2:L',
    scoringRange: process.env.SHEET_SCORING_RANGE || 'ScorringAgent!A:K',
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON, // base64
  },

  // --- Persistensi ---
  databaseUrl: process.env.DATABASE_URL, // Postgres (Supabase/Neon free tier)
  sessionId: process.env.WA_SESSION_ID || 'default',
  port: num(process.env.PORT, 3000),

  // Kalimat disclosure bot. WAJIB ada di pesan pembuka.
  botDisclosure:
    process.env.BOT_DISCLOSURE ||
    'Pesan ini dikirim oleh asisten otomatis. Balas STOP kalau tidak ingin dihubungi lagi.',
  optOutKeywords: (process.env.OPT_OUT_KEYWORDS || 'stop,berhenti,unsubscribe,jangan hubungi')
    .split(',')
    .map((s) => s.trim().toLowerCase()),
};

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Env ${key} wajib diisi`);
  return v;
}
