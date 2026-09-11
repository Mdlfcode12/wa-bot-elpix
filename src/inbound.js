import { PerChatQueue } from './limiter.js';
import { askAI } from './gemini.js';
import { loadHistory, appendTurn, markOptedOut } from './memory.js';
import { sendHumanLike, getSock } from './client.js';
import { getFlags, isChatPaused, pauseChat } from './state.js';
import { logMessage } from './messages.js';
import { pushAlert } from './notify.js';
import { emit } from './events.js';
import { config } from './config.js';
import { recordReplyTime, incrementAgentStat } from './sheets.js';

export const queue = new PerChatQueue({ debounceMs: 4000 });

/** Frasa yang menandakan percakapan sebaiknya dipegang manusia. */
const ESCALATE = [
  'lapor polisi', 'tuntut', 'pengacara', 'penipu', 'penipuan', 'tipu',
  'kecewa berat', 'refund', 'uang kembali', 'komplain', 'somasi',
  'bicara dengan orang', 'bicara sama manusia', 'jangan bot', 'ini bot ya',
];

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text ||
         m.imageMessage?.caption || m.videoMessage?.caption || null;
}

export async function handleIncoming(msg) {
  if (msg.key.fromMe) return;

  // WhatsApp versi terbaru mengirim pesan ganda (satu @s.whatsapp.net, satu @lid).
  // Jika kita memproses LID yang tidak punya senderPn, akan muncul kontak duplikat 
  // (misal 125641080967407) dan bot akan membalas dua kali ke pengguna yang sama.
  const rawJid = msg.key.remoteJid;
  if (rawJid?.includes('@lid') && !msg.key.senderPn) {
    console.log(`[WA-IN] Abaikan pesan duplikat dari LID: ${rawJid}`);
    return;
  }
  const jid = msg.key.senderPn || rawJid;

  console.log(`[WA-IN] Pesan dari: ${jid}${rawJid !== jid ? ` (LID: ${rawJid})` : ''}`);

  const text = extractText(msg);
  if (!text) return;

  // Catat DULU, sebelum keputusan apa pun. Pesan pelanggan harus muncul
  // di panel walaupun AI sedang mati — itu justru saat kamu paling perlu melihatnya.
  await logMessage(jid, 'in', 'customer', text);
  await getSock().readMessages([msg.key]).catch(() => {});

  const flags = await getFlags();
  if (!flags.ai_enabled) return;          // kill switch global
  if (await isChatPaused(jid)) return;    // kamu sedang pegang chat ini

  queue.push(jid, text, processTurn);
}

async function processTurn(jid, userText) {
  const lower = userText.toLowerCase();

  if (config.optOutKeywords.some((k) => lower.includes(k))) {
    await markOptedOut(jid);
    await replyAs(jid, 'ai', 'Baik, kamu tidak akan kami hubungi lagi. Terima kasih dan maaf atas gangguannya.');
    emit('optout', { jid });
    return;
  }

  if (ESCALATE.some((k) => lower.includes(k))) {
    await pauseChat(jid, 'perlu penanganan manusia', 'system');
    await replyAs(jid, 'ai', 'Baik, aku sambungkan ke tim kami ya. Mohon tunggu sebentar.');
    const nomor = jid.split('@')[0];
    emit('escalation', { jid, text: userText });
    await pushAlert(`Percakapan ${nomor} butuh kamu.\n\n"${userText.slice(0, 200)}"\n\nBuka panel untuk membalas.`);
    return;
  }

  // Flag bisa berubah selama debounce 4 detik.
  const flags = await getFlags();
  if (!flags.ai_enabled || (await isChatPaused(jid))) return;

  const { history, name, context, optedOut } = await loadHistory(jid);
  if (optedOut) return;

  // Catat waktu balas ke ScorringAgent sheet
  recordReplyTime(jid, name).catch(e => console.error('[scoring] gagal merekam waktu balas:', e.message));

  let reply;
  try {
    reply = await askAI({
      history: [...history, { role: 'user', content: userText }],
      name, context,
      business: process.env.BUSINESS_NAME || 'kami',
    });
  } catch (e) {
    console.error('[inbound] Gemini gagal:', e.message);
    emit('error', { jid, message: e.message });
    await pushAlert(`Gemini gagal membalas ${jid.split('@')[0]}: ${e.message}`);
    await replyAs(jid, 'ai', 'Maaf, sistem kami sedang sibuk. Tim kami akan membalas sebentar lagi ya.');
    return;
  }

  // Cek TERAKHIR. Panggilan Claude makan beberapa detik — kalau kamu menekan
  // stop di tengah itu, balasan ini tidak boleh lolos.
  const final = await getFlags();
  if (!final.ai_enabled || (await isChatPaused(jid))) {
    console.log(`[inbound] Balasan untuk ${jid} dibatalkan (dihentikan admin)`);
    emit('cancelled', { jid });
    return;
  }

  let cleanReply = reply;
  if (cleanReply.includes('[SURVEI]')) {
    cleanReply = cleanReply.replace(/\[SURVEI\]/g, '').trim();
    incrementAgentStat(jid, name, 'survei').catch(e => console.error('[scoring] gagal tambah survei:', e.message));
  }
  if (cleanReply.includes('[BUYER]')) {
    cleanReply = cleanReply.replace(/\[BUYER\]/g, '').trim();
    incrementAgentStat(jid, name, 'buyer').catch(e => console.error('[scoring] gagal tambah buyer:', e.message));
  }

  await replyAs(jid, 'ai', cleanReply);
  await appendTurn(jid, userText, cleanReply);
}

/** Satu jalur kirim untuk AI maupun balasan manusia dari panel. */
export async function replyAs(jid, sender, text) {
  await sendHumanLike(jid, text);
  await logMessage(jid, 'out', sender, text);
}
