/**
 * Notifikasi push tanpa perlu nomor WhatsApp kedua.
 *
 * Kalau panel tidak sedang terbuka, kamu tetap perlu tahu saat ada percakapan
 * yang butuh manusia. Telegram Bot API gratis, tidak minta nomor tambahan,
 * dan langsung masuk ke HP. Kosongkan env-nya kalau tidak dipakai —
 * peringatan tetap muncul di panel.
 *
 * Setup: chat @BotFather → /newbot → salin token. Lalu kirim 1 pesan ke bot-mu,
 * buka https://api.telegram.org/bot<TOKEN>/getUpdates untuk melihat chat id.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function pushAlert(text) {
  if (!TOKEN || !CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch (e) {
    console.error('[notify] gagal:', e.message);
    return false;
  }
}
