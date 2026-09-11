import { pool } from './authState.js';
import { config } from './config.js';

/**
 * KENAPA FLAG DISIMPAN DI POSTGRES, BUKAN VARIABEL BIASA:
 * Hosting gratis me-restart proses kapan saja. Kalau kill switch cuma variabel
 * di memori, bot yang kamu matikan jam 10 malam akan hidup lagi sendiri setelah
 * restart jam 3 pagi — dan mulai membalas pelanggan tanpa kamu tahu.
 * Flag di DB tetap mati sampai kamu yang menyalakan.
 *
 * Cache in-memory dipakai supaya tidak query DB di setiap pesan masuk.
 * Penulisan langsung memperbarui cache, jadi tombol STOP terasa instan.
 */

const DEFAULTS = {
  ai_enabled: true,        // AI membalas pesan masuk
  campaign_enabled: true,  // pengiriman pesan pembuka
};

let cache = { ...DEFAULTS };
let lastFetch = 0;
const TTL_MS = 10_000;

export async function initSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN DEFAULT false;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS pause_reason TEXT;

    CREATE TABLE IF NOT EXISTS admin_audit (
      id         BIGSERIAL PRIMARY KEY,
      action     TEXT NOT NULL,
      target     TEXT,
      actor      TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await refresh(true);
}

async function refresh(force = false) {
  if (!force && Date.now() - lastFetch < TTL_MS) return cache;
  const { rows } = await pool.query(`SELECT key, value FROM bot_settings`);
  const next = { ...DEFAULTS };
  for (const r of rows) next[r.key] = r.value;
  cache = next;
  lastFetch = Date.now();
  return cache;
}

/** Dipakai di jalur panas (setiap pesan). Murah — biasanya baca cache. */
export async function getFlags() {
  return refresh();
}

export async function setFlag(key, value, actor = 'system') {
  if (!(key in DEFAULTS)) throw new Error(`Flag tidak dikenal: ${key}`);
  await pool.query(
    `INSERT INTO bot_settings (key, value, updated_by, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=now()`,
    [key, JSON.stringify(value), actor]
  );
  cache[key] = value;      // efek langsung, tanpa menunggu TTL
  await audit(value ? `${key}_on` : `${key}_off`, null, actor);
}

// ---------- Kontrol per-percakapan ----------

/**
 * Pause satu kontak = ambil alih manual.
 * Baileys jalan sebagai perangkat tertaut, jadi pesan pelanggan tetap masuk
 * ke aplikasi WhatsApp di HP-mu. Begitu AI dipause, kamu tinggal membalas
 * sendiri dari HP seperti biasa — tidak ada yang perlu disiapkan lagi.
 */
export async function pauseChat(jid, reason = 'manual', actor = 'admin') {
  await pool.query(
    `INSERT INTO conversations (jid, ai_paused, pause_reason) VALUES ($1,true,$2)
     ON CONFLICT (jid) DO UPDATE SET ai_paused=true, pause_reason=$2`,
    [jid, reason]
  );
  await audit('pause_chat', jid, actor);
}

export async function resumeChat(jid, actor = 'admin') {
  await pool.query(
    `UPDATE conversations SET ai_paused=false, pause_reason=NULL WHERE jid=$1`,
    [jid]
  );
  await audit('resume_chat', jid, actor);
}

export async function isChatPaused(jid) {
  const { rows } = await pool.query(
    `SELECT ai_paused FROM conversations WHERE jid=$1`,
    [jid]
  );
  return Boolean(rows[0]?.ai_paused);
}

export async function audit(action, target, actor) {
  await pool
    .query(`INSERT INTO admin_audit (action, target, actor) VALUES ($1,$2,$3)`, [
      action,
      target,
      actor,
    ])
    .catch(() => { });
}

export async function getStatus() {
  const flags = await refresh(true);
  const { rows: [counts] } = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM conversations WHERE ai_paused)  AS paused,
      (SELECT count(*)::int FROM conversations WHERE opted_out)  AS opted_out,
      (SELECT count(*)::int FROM outbound_log
         WHERE status='sent'
           AND sent_at >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS sent_today
  `, [config.outbound.timezone]);
  const { rows: recent } = await pool.query(
    `SELECT action, target, actor, created_at FROM admin_audit
     ORDER BY id DESC LIMIT 10`
  );
  return { ...flags, ...counts, recent };
}

/** Daftar chat yang sedang dipause, untuk ditampilkan di panel. */
export async function listPaused() {
  const { rows } = await pool.query(
    `SELECT jid, name, pause_reason, last_seen FROM conversations
     WHERE ai_paused ORDER BY last_seen DESC LIMIT 50`
  );
  return rows;
}
