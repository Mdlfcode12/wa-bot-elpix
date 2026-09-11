import { fetchTargets, markRow } from './sheets.js';
import { toJid, isRegistered, sendHumanLike, sleep, isReady } from './client.js';
import { upsertContact } from './memory.js';
import { pool } from './authState.js';
import { getFlags } from './state.js';
import { logMessage } from './messages.js';
import { emit } from './events.js';
import { config } from './config.js';

let running = false;
let campaignStartDate = null;

const rand = (min, max) => min + Math.random() * (max - min);

/**
 * Jeda antar pesan bisa sampai 3 menit. Kalau pakai sleep biasa, tombol STOP
 * baru terasa setelah jeda itu habis. Ini bangun tiap detik untuk mengecek flag,
 * jadi kampanye berhenti hampir seketika.
 */
async function pausableSleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(Math.min(1000, until - Date.now()));
    const { campaign_enabled } = await getFlags();
    if (!campaign_enabled) return false; // dihentikan admin
  }
  return true;
}

/**
 * Warm-up ramp: nomor baru yang tiba-tiba mengirim 40 chat di hari pertama
 * adalah pola paling mencolok. Mulai dari ~15% kuota, naik bertahap.
 */
function todayCap() {
  const days = campaignStartDate
    ? Math.floor((Date.now() - campaignStartDate) / 86_400_000) + 1
    : 1;
  const ratio = Math.min(1, days / config.outbound.warmupDays);
  return Math.max(5, Math.floor(config.outbound.dailyCap * (0.15 + 0.85 * ratio)));
}

function insideWindow() {
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: config.outbound.timezone })
  );
  const h = now.getHours();
  const day = now.getDay();
  if (day === 0) return false; // lewati Minggu
  return h >= config.outbound.windowStartHour && h < config.outbound.windowEndHour;
}

/**
 * Hitungan harus memakai zona waktu KIRIM (Asia/Jakarta), bukan zona server
 * database. date_trunc('day', now()) mengikuti setelan server: di Postgres
 * lokal biasanya kebetulan cocok, tapi Neon dan Supabase berjalan UTC —
 * di sana penghitung reset jam 07:00 WIB, di tengah jam operasional, dan bot
 * bisa mengirim dua kali kuota harian. Itu persis pola yang memicu banned.
 */
async function sentToday() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM outbound_log
     WHERE status='sent'
       AND sent_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1`,
    [config.outbound.timezone]
  );
  return rows[0].n;
}

function buildOpener({ name, context }) {
  const business = process.env.BUSINESS_NAME || 'kami';
  const greet = name ? `Halo ${name},` : 'Halo,';
  return `${greet} perkenalkan aku asisten AI dari ${business}. Tujuanku ngehubungin kamu buat ngobrolin soal ini:\n${context}\n\n${config.botDisclosure}`;
}

export async function runCampaign() {
  if (running) return { skipped: 'sudah berjalan' };
  if (!isReady()) return { skipped: 'WhatsApp belum tersambung' };
  const { campaign_enabled } = await getFlags();
  if (!campaign_enabled) return { skipped: 'pengiriman sedang dimatikan admin' };

  running = true;
  campaignStartDate ??= Date.now();
  const result = { sent: 0, skipped: 0, failed: 0 };

  try {
    const targets = await fetchTargets();
    const cap = todayCap();
    let alreadySent = await sentToday();

    for (const t of targets) {
      const { campaign_enabled } = await getFlags();
      if (!campaign_enabled) {
        console.log('[campaign] Dihentikan admin. Sisa target tidak disentuh.');
        result.stopped = true;
        break;
      }

      if (alreadySent >= cap) {
        console.log(`[campaign] Kuota harian tercapai (${cap}). Sisanya besok.`);
        break;
      }

      if (!insideWindow()) {
        console.log('[campaign] Di luar jam kirim. Berhenti.');
        break;
      }

      const jid = toJid(t.phone);

      try {
        if (!(await isRegistered(jid))) {
          await markRow(t.rowIndex, 'not_on_whatsapp');
          result.skipped++;
          continue;
        }

        await upsertContact(jid, { name: t.name, context: t.context });
        const opener = buildOpener(t);
        await sendHumanLike(jid, opener);
        await logMessage(jid, 'out', 'ai', opener); // muncul di panel

        await pool.query(
          `INSERT INTO outbound_log (jid, sheet_row, status) VALUES ($1,$2,'sent')`,
          [jid, t.rowIndex]
        );
        await markRow(t.rowIndex, 'sent');

        result.sent++;
        alreadySent++;

        // Jeda acak antar pesan. Ini bukan trik siluman — ini pengendalian laju:
        // menjaga volume tetap wajar dan memberi kamu waktu menghentikan
        // kampanye kalau balasan pertama menunjukkan ada yang salah.
        const gap = rand(config.outbound.minDelayMs, config.outbound.maxDelayMs);
        console.log(`[campaign] Terkirim ke ${t.name}. Jeda ${Math.round(gap / 1000)}s`);
        emit('campaign_progress', { sent: result.sent, cap, name: t.name });
        if (!(await pausableSleep(gap))) {
          result.stopped = true;
          break;
        }
      } catch (e) {
        console.error(`[campaign] Gagal ${t.phone}:`, e.message);
        await markRow(t.rowIndex, 'failed').catch(() => {});
        result.failed++;
        await sleep(30_000);
      }
    }
  } finally {
    running = false;
  }

  return result;
}

export const isCampaignRunning = () => running;
