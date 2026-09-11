import { pool } from './authState.js';
import { config } from './config.js';

/**
 * KENAPA MEMORY LIMIT ITU PENTING:
 * Setiap panggilan API mengirim ULANG seluruh histori sebagai input token.
 * Percakapan 50 pesan = ~8.000 input token PER BALASAN. Dengan 20 chat aktif
 * bersamaan, kamu tembus ITPM tier 1 hanya dari histori. Sliding window
 * memotong ini jadi konstan, bukan tumbuh linear.
 */

export async function getConversation(jid) {
  const { rows } = await pool.query(
    `SELECT jid, name, context, history, opted_out, last_seen
     FROM conversations WHERE jid=$1`,
    [jid]
  );
  return rows[0] || null;
}

export async function upsertContact(jid, { name, context }) {
  await pool.query(
    `INSERT INTO conversations (jid, name, context) VALUES ($1,$2,$3)
     ON CONFLICT (jid) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, conversations.name),
       context = COALESCE(EXCLUDED.context, conversations.context)`,
    [jid, name, context]
  );
}

export async function markOptedOut(jid) {
  await pool.query(`UPDATE conversations SET opted_out=true WHERE jid=$1`, [jid]);
}

/** Ambil histori yang sudah dipangkas dan siap dikirim ke Claude. */
export async function loadHistory(jid) {
  const convo = await getConversation(jid);
  if (!convo) return { history: [], name: null, context: null, optedOut: false };

  const ageMin = (Date.now() - new Date(convo.last_seen).getTime()) / 60_000;
  // Sesi basi → mulai dari nol. Menghemat token dan menghindari
  // bot menyambung percakapan 3 hari lalu seolah baru kemarin.
  const history = ageMin > config.memory.ttlMinutes ? [] : convo.history || [];

  return {
    history: trim(history),
    name: convo.name,
    context: convo.context,
    optedOut: convo.opted_out,
  };
}

export async function appendTurn(jid, userText, assistantText) {
  const convo = await getConversation(jid);
  const history = trim([
    ...(convo?.history || []),
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ]);

  await pool.query(
    `INSERT INTO conversations (jid, history, last_seen) VALUES ($1,$2,now())
     ON CONFLICT (jid) DO UPDATE SET history=$2, last_seen=now()`,
    [jid, JSON.stringify(history)]
  );
}

/**
 * Dua batas sekaligus:
 *  - maxTurns: jumlah pesan
 *  - maxChars: total karakter (proteksi kalau ada yang paste dokumen panjang)
 * Selalu dipotong dari yang PALING LAMA, dan selalu mulai dari role 'user'
 * karena Messages API menolak histori yang diawali 'assistant'.
 */
function trim(history) {
  let out = history.slice(-config.memory.maxTurns);

  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 2 && total > config.memory.maxChars) {
    total -= out[0].content.length;
    out = out.slice(1);
  }

  while (out.length && out[0].role !== 'user') out = out.slice(1);
  return out;
}
