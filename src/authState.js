/**
 * MASALAH INTI HOSTING GRATIS:
 * Baileys default pakai useMultiFileAuthState() yang menulis ke disk.
 * Render/Koyeb/Railway punya filesystem EPHEMERAL — setiap redeploy atau
 * restart, folder auth hilang → harus scan QR ulang. Tidak bisa dipakai produksi.
 *
 * Solusi: simpan creds + signal keys di Postgres (Supabase/Neon free tier).
 * Restart berapa kali pun, sesi tetap hidup tanpa scan QR.
 */
import pg from 'pg';
import { initAuthCreds, BufferJSON, proto } from 'baileys';
import { config } from './config.js';

/**
 * Postgres lokal (Docker / instalasi biasa) TIDAK memakai SSL, sedangkan
 * Supabase/Neon mewajibkannya. Memaksa salah satu akan menggagalkan yang lain,
 * jadi SSL dinyalakan hanya untuk host non-lokal.
 */
const isLocalDb = /localhost|127\.0\.0\.1|::1/.test(config.databaseUrl || '');

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  max: 4,
});

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_auth (
      session_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      jid        TEXT PRIMARY KEY,
      name       TEXT,
      context    TEXT,
      history    JSONB DEFAULT '[]'::jsonb,
      opted_out  BOOLEAN DEFAULT false,
      last_seen  TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS outbound_log (
      id         BIGSERIAL PRIMARY KEY,
      jid        TEXT NOT NULL,
      sheet_row  INT,
      status     TEXT,
      sent_at    TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_sent ON outbound_log (sent_at);
  `);
}

const write = async (key, value) =>
  pool.query(
    `INSERT INTO wa_auth (session_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (session_id, key) DO UPDATE SET value = $3, updated_at = now()`,
    [config.sessionId, key, JSON.stringify(value, BufferJSON.replacer)]
  );

const read = async (key) => {
  const { rows } = await pool.query(
    `SELECT value FROM wa_auth WHERE session_id=$1 AND key=$2`,
    [config.sessionId, key]
  );
  if (!rows.length) return null;
  return JSON.parse(JSON.stringify(rows[0].value), BufferJSON.reviver);
};

const remove = async (key) =>
  pool.query(`DELETE FROM wa_auth WHERE session_id=$1 AND key=$2`, [config.sessionId, key]);

/** Drop-in pengganti useMultiFileAuthState() */
export async function usePostgresAuthState() {
  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}`);
              // app-state-sync-key harus di-hydrate jadi proto object
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              if (value) data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const key = `${type}-${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => write('creds', creds),
    clearSession: () =>
      pool.query(`DELETE FROM wa_auth WHERE session_id=$1`, [config.sessionId]),
  };
}

export { pool };
