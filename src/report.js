import { GoogleGenAI } from '@google/genai';
import { pool } from './authState.js';
import { config } from './config.js';
import { sheetsConfigured, getSheetsApi } from './sheets.js';
import { usedToday } from './quota.js';
import { emit } from './events.js';

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * LAPORAN HARIAN PER-KONTAK
 *
 * Setiap baris = satu kontak yang berinteraksi hari itu.
 * Dijalankan otomatis setelah jam operasional selesai,
 * atau manual via tombol di panel.
 *
 * Tab: "Laporan" (dibuat otomatis jika belum ada)
 *
 * Kolom:
 *   A  Tanggal
 *   B  No HP
 *   C  Nama
 *   D  Sumber          (Campaign / Organik)
 *   E  Pesan Masuk     (jumlah pesan dari pelanggan)
 *   F  Balasan AI
 *   G  Balasan Manual
 *   H  Status          (Aktif / Dipause / Opt-Out)
 *   I  Eskalasi        (Ya / Tidak)
 *   J  Kesimpulan      (ringkasan minat/hasil percakapan oleh Gemini)
 */

const TZ = config.outbound.timezone;
const TAB_NAME = 'Laporan';
const HEADERS = [
  'Tanggal', 'No HP', 'Nama', 'Sumber',
  'Pesan Masuk', 'Balasan AI', 'Balasan Manual',
  'Status', 'Eskalasi', 'Kesimpulan',
];

/**
 * Prompt khusus untuk meringkas percakapan menjadi insight bisnis.
 * Sengaja pendek dan spesifik supaya hasilnya konsisten.
 */
const SUMMARY_PROMPT = `Kamu menganalisis transkrip percakapan WhatsApp antara bisnis properti dan pelanggan.
Berikan kesimpulan SINGKAT (1 kalimat, maksimal 20 kata) tentang minat atau hasil percakapan pelanggan.

Contoh hasil yang benar:
- Tertarik rumah tipe A2 di BSD Serpong, minta jadwal survei
- Menanyakan harga cicilan KPR untuk rumah 2 lantai
- Komplain keterlambatan serah terima unit
- Sudah deal, tunggu jadwal akad kredit
- Hanya salam, belum ada minat spesifik

ATURAN:
- Langsung tulis kesimpulannya, tanpa awalan "Kesimpulan:" atau tanda kutip.
- Fokus pada APA yang diinginkan pelanggan, bukan apa yang dijawab bot.
- Kalau percakapan terlalu singkat atau tidak jelas, tulis: Belum ada minat spesifik`;

// Jeda antar panggilan Gemini agar tidak kena 429.
// Laporan jalan setelah jam operasional jadi tidak rebutan dengan chat.
const SUMMARIZE_DELAY_MS = Math.ceil(60_000 / config.gemini.rpmBudget) + 500;

/**
 * Ambil pesan hari ini untuk satu kontak, kirim ke Gemini untuk diringkas.
 */
async function summarizeConversation(jid, start) {
  const { rows } = await pool.query(
    `SELECT direction, sender, body FROM messages
     WHERE jid = $1 AND created_at >= $2
     ORDER BY id ASC LIMIT 40`,
    [jid, start]
  );

  if (!rows.length) return '-';

  const transcript = rows
    .map((r) => {
      const who = r.direction === 'in' ? 'Pelanggan' : r.sender === 'ai' ? 'Bot' : 'Admin';
      return `${who}: ${r.body}`;
    })
    .join('\n');

  try {
    const res = await ai.models.generateContent({
      model: config.gemini.model,
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config: {
        systemInstruction: SUMMARY_PROMPT,
        maxOutputTokens: 100,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return res.text?.trim() || '-';
  } catch (e) {
    console.warn(`[report] Gagal meringkas ${jid.split('@')[0]}:`, e.message);
    return '-';
  }
}

// ---- Inti laporan ----

export async function generateDailyReport() {
  if (!sheetsConfigured()) {
    console.log('[report] Google Sheets belum dikonfigurasi, laporan dilewati');
    return { skipped: 'sheets not configured' };
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // Midnight hari ini di timezone lokal, dikonversi ke timestamptz.
  const { rows: [{ start }] } = await pool.query(
    `SELECT date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1 AS start`,
    [TZ]
  );

  const { rows } = await pool.query(`
    WITH today_msgs AS (
      SELECT jid, direction, sender, count(*)::int AS cnt
      FROM messages
      WHERE created_at >= $1
      GROUP BY jid, direction, sender
    ),
    today_campaign AS (
      SELECT DISTINCT jid FROM outbound_log
      WHERE status = 'sent' AND sent_at >= $1
    ),
    today_escalation AS (
      SELECT DISTINCT target AS jid FROM admin_audit
      WHERE action = 'pause_chat' AND actor = 'system' AND created_at >= $1
    ),
    active_contacts AS (
      SELECT DISTINCT jid FROM today_msgs
      UNION
      SELECT jid FROM today_campaign
    )
    SELECT
      ac.jid,
      c.name,
      COALESCE((SELECT cnt FROM today_msgs t
                WHERE t.jid = ac.jid AND t.direction = 'in'), 0)  AS msg_in,
      COALESCE((SELECT cnt FROM today_msgs t
                WHERE t.jid = ac.jid AND t.direction = 'out'
                AND t.sender = 'ai'), 0)                          AS reply_ai,
      COALESCE((SELECT cnt FROM today_msgs t
                WHERE t.jid = ac.jid AND t.direction = 'out'
                AND t.sender = 'human'), 0)                       AS reply_human,
      EXISTS(SELECT 1 FROM today_campaign tc
             WHERE tc.jid = ac.jid)                               AS from_campaign,
      COALESCE(c.ai_paused, false)                                AS ai_paused,
      COALESCE(c.opted_out, false)                                AS opted_out,
      EXISTS(SELECT 1 FROM today_escalation te
             WHERE te.jid = ac.jid)                               AS escalated
    FROM active_contacts ac
    LEFT JOIN conversations c ON c.jid = ac.jid
    ORDER BY msg_in DESC, ac.jid
  `, [start]);

  if (!rows.length) {
    console.log('[report] Tidak ada aktivitas hari ini, laporan dilewati');
    return { skipped: 'no activity', date: today };
  }

  // ---- Ringkas setiap percakapan dengan Gemini ----
  console.log(`[report] Meringkas ${rows.length} percakapan (jeda ${Math.round(SUMMARIZE_DELAY_MS / 1000)}s antar panggilan)…`);
  emit('report_progress', { phase: 'summarizing', total: rows.length, done: 0 });

  const summaries = [];
  for (let i = 0; i < rows.length; i++) {
    const summary = await summarizeConversation(rows[i].jid, start);
    summaries.push(summary);
    console.log(`[report]   ${i + 1}/${rows.length} ${rows[i].jid.split('@')[0]}: ${summary}`);
    emit('report_progress', { phase: 'summarizing', total: rows.length, done: i + 1 });
    // Jeda antar panggilan, kecuali yang terakhir
    if (i < rows.length - 1) await sleep(SUMMARIZE_DELAY_MS);
  }

  // Bangun baris data — 1 baris per kontak
  const dataRows = rows.map((r, i) => {
    const phone = r.jid.split('@')[0];
    return [
      today,
      phone,
      r.name || '-',
      r.from_campaign ? 'Campaign' : 'Organik',
      r.msg_in,
      r.reply_ai,
      r.reply_human,
      r.opted_out ? 'Opt-Out' : r.ai_paused ? 'Dipause' : 'Aktif',
      r.escalated ? 'Ya' : 'Tidak',
      summaries[i],
    ];
  });

  // Baris ringkasan di akhir blok hari ini
  const quota = await usedToday();
  const totalIn = rows.reduce((s, r) => s + r.msg_in, 0);
  const totalAi = rows.reduce((s, r) => s + r.reply_ai, 0);
  const totalHuman = rows.reduce((s, r) => s + r.reply_human, 0);
  const totalCampaign = rows.filter((r) => r.from_campaign).length;

  dataRows.push([
    today,
    `RINGKASAN (${rows.length} kontak)`,
    '',
    `Campaign: ${totalCampaign}`,
    totalIn,
    totalAi,
    totalHuman,
    `Kuota AI: ${quota}/${config.gemini.rpdBudget}`,
    '',
    '',
  ]);

  // ---- Tulis ke Google Sheets ----
  const api = getSheetsApi();
  const spreadsheetId = config.sheets.spreadsheetId;

  await ensureTab(api, spreadsheetId);

  // Tulis header jika tab masih kosong
  const existing = await api.spreadsheets.values
    .get({ spreadsheetId, range: `${TAB_NAME}!A1:J1` })
    .catch(() => null);

  const values = [];
  if (!existing?.data?.values?.length) {
    values.push(HEADERS);
  }
  values.push(...dataRows);

  await api.spreadsheets.values.append({
    spreadsheetId,
    range: `${TAB_NAME}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  const result = { contacts: rows.length, date: today };
  console.log(`[report] Laporan harian ditulis: ${rows.length} kontak, tanggal ${today}`);
  emit('report', result);
  return result;
}

// ---- Tab management ----

async function ensureTab(api, spreadsheetId) {
  const { data } = await api.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });
  if (data.sheets.some((s) => s.properties.title === TAB_NAME)) return;

  await api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB_NAME } } }],
    },
  });
  console.log(`[report] Tab "${TAB_NAME}" dibuat di spreadsheet`);
}

// ---- Penjadwalan otomatis ----

let reportedToday = null;

/**
 * Cek setiap 15 menit. Jalankan sekali di jam windowEndHour (default: 19).
 * Tidak pakai cron library — satu setInterval sudah cukup.
 */
export function scheduleDailyReport() {
  const check = async () => {
    const now = new Date(
      new Date().toLocaleString('en-US', { timeZone: TZ })
    );
    const h = now.getHours();
    const day = now.toISOString().slice(0, 10);

    if (h >= config.outbound.windowEndHour && reportedToday !== day) {
      reportedToday = day;
      try {
        const r = await generateDailyReport();
        console.log('[report] Laporan otomatis:', r);
      } catch (e) {
        console.error('[report] Gagal generate laporan otomatis:', e.message);
        reportedToday = null; // izinkan retry di interval berikutnya
      }
    }
  };

  // Cek segera saat startup (kalau sudah lewat jam operasional tapi belum laporan)
  check();
  setInterval(check, 15 * 60_000);
  console.log(`[report] Penjadwalan aktif — laporan otomatis jam ${config.outbound.windowEndHour}:00 ${TZ}`);
}
