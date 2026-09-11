import { pool } from './authState.js';
import { emit } from './events.js';

/**
 * Log pesan LENGKAP, terpisah dari conversations.history.
 *
 * Dua hal berbeda yang sering dicampur orang:
 *   - conversations.history → dipangkas, itu yang dilihat Gemini (hemat kuota)
 *   - messages             → utuh, itu yang kamu lihat di panel
 * Memangkas konteks AI tidak boleh berarti kamu ikut kehilangan riwayat.
 */
export async function initMessages() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         BIGSERIAL PRIMARY KEY,
      jid        TEXT NOT NULL,
      direction  TEXT NOT NULL,          -- in | out
      sender     TEXT NOT NULL,          -- customer | ai | human
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_jid ON messages (jid, id DESC);
  `);
}

export async function logMessage(jid, direction, sender, body) {
  const { rows } = await pool.query(
    `INSERT INTO messages (jid, direction, sender, body) VALUES ($1,$2,$3,$4)
     RETURNING id, created_at`,
    [jid, direction, sender, body]
  );
  await pool.query(
    `INSERT INTO conversations (jid, last_seen) VALUES ($1, now())
     ON CONFLICT (jid) DO UPDATE SET last_seen = now()`,
    [jid]
  );
  emit('message', { jid, direction, sender, body, id: rows[0].id, at: rows[0].created_at });
}

/** Daftar percakapan untuk panel kiri, terbaru di atas. */
export async function listConversations(limit = 40) {
  const { rows } = await pool.query(
    `SELECT c.jid, c.name, c.ai_paused, c.pause_reason, c.opted_out, c.last_seen,
            (SELECT body FROM messages m WHERE m.jid = c.jid ORDER BY m.id DESC LIMIT 1) AS preview,
            (SELECT sender FROM messages m WHERE m.jid = c.jid ORDER BY m.id DESC LIMIT 1) AS last_sender
     FROM conversations c
     WHERE EXISTS (SELECT 1 FROM messages m WHERE m.jid = c.jid)
     ORDER BY c.last_seen DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getThread(jid, limit = 60) {
  const { rows } = await pool.query(
    `SELECT id, direction, sender, body, created_at FROM messages
     WHERE jid=$1 ORDER BY id DESC LIMIT $2`,
    [jid, limit]
  );
  return rows.reverse();
}
