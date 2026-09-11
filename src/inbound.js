import { PerChatQueue } from './limiter.js';
import { askAI } from './gemini.js';
import { loadHistory, appendTurn, markOptedOut } from './memory.js';
import { sendHumanLike, getSock } from './client.js';
import { getFlags, isChatPaused, pauseChat } from './state.js';
import { logMessage, saveLidMapping, loadLidMappings } from './messages.js';
import { pushAlert } from './notify.js';
import { emit } from './events.js';
import { config } from './config.js';
import { recordReplyTime, incrementAgentStat } from './sheets.js';

export const queue = new PerChatQueue({ debounceMs: 4000 });

/**
 * LID → nomor telepon. Diisi saat WhatsApp menyertakan keduanya dalam satu
 * pesan, dipakai saat ia hanya mengirim LID. Cukup di memori: kalau proses
 * restart, pemetaan terbentuk lagi dari pesan berikutnya yang lengkap.
 */
const lidToPhone = new Map();

/**
 * ALAMAT BALASAN per kontak (nomor -> alamat yang dipakai WhatsApp).
 *
 * WhatsApp sedang memindahkan pengalamatan dari nomor (@s.whatsapp.net) ke
 * LID (@lid). Kalau pesan masuk datang lewat LID, balasan yang dikirim ke
 * alamat nomor bisa gagal didekripsi di HP penerima — tampil sebagai
 * "Waiting for this message" selamanya, walau server melaporkan terkirim.
 *
 * Jadi kita balas ke alamat yang SAMA dengan yang dipakai pesan masuk.
 * Itu satu-satunya alamat yang pasti punya sesi enkripsi hidup di kedua sisi.
 */
const alamatBalasan = new Map();

/** Alamat untuk membalas kontak ini. Default: nomornya sendiri. */
export function alamatKirim(jid) {
  return alamatBalasan.get(jid) || jid;
}

/** Muat pemetaan yang sudah dikenal dari database saat bot start. */
export async function initLidCache() {
  for (const r of await loadLidMappings()) {
    lidToPhone.set(r.lid, r.phone_jid);
    // Kontak yang pernah memakai LID kemungkinan besar masih memakainya.
    alamatBalasan.set(r.phone_jid, r.lid);
  }
  if (lidToPhone.size) console.log(`[WA-IN] ${lidToPhone.size} pemetaan LID dimuat dari database.`);
}

/** Simpan pemetaan baru ke memori DAN database. */
function ingatLid(lid, phoneJid) {
  if (!lid || !phoneJid || lidToPhone.get(lid) === phoneJid) return;
  lidToPhone.set(lid, phoneJid);
  saveLidMapping(lid, phoneJid).catch((e) => console.error('[WA-IN] gagal simpan pemetaan LID:', e.message));
}

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

  /**
   * PEMETAAN LID → NOMOR
   *
   * WhatsApp versi baru mengirim identitas pengirim dalam dua bentuk: nomor
   * biasa (@s.whatsapp.net) dan LID (@lid). Atribut sender_pn yang memetakan
   * keduanya TIDAK selalu disertakan — WhatsApp hanya mengirimnya di sebagian
   * stanza.
   *
   * Versi sebelumnya membuang setiap pesan LID tanpa senderPn, dengan asumsi
   * selalu ada kembaran ber-nomor yang menyusul. Asumsi itu salah: kalau
   * kembarannya tidak datang, pesan pelanggan hilang diam-diam — tidak dibalas
   * dan tidak muncul di panel.
   *
   * Karena itu pemetaannya diingat begitu terlihat sekali, lalu dipakai sebagai
   * cadangan. Pesan hanya dibuang kalau LID-nya benar-benar belum pernah
   * dikenali, dan itu dicatat sebagai peringatan supaya terlihat.
   */
  const rawJid = msg.key.remoteJid;

  if (msg.key.senderLid && msg.key.senderPn) ingatLid(msg.key.senderLid, msg.key.senderPn);
  if (rawJid?.endsWith('@lid') && msg.key.senderPn) ingatLid(rawJid, msg.key.senderPn);

  let jid = msg.key.senderPn || rawJid;

  if (jid?.endsWith('@lid')) {
    const dikenal = lidToPhone.get(jid);
    if (dikenal) {
      jid = dikenal; // kembaran ber-nomor sudah pernah terlihat
    } else {
      console.warn(`[WA-IN] LID belum dikenal, pesan diabaikan: ${rawJid}. Minta kontak mengirim ulang.`);
      return;
    }
  }

  // Alamat yang dipakai WhatsApp untuk pesan INI adalah alamat yang sehat
  // untuk membalas. Simpan, lalu pakai di replyAs.
  if (rawJid && rawJid !== jid) alamatBalasan.set(jid, rawJid);

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
  // Kirim ke alamat yang sehat (bisa @lid), tapi catat di panel dengan nomor
  // supaya riwayat percakapan tidak terpecah jadi dua kontak.
  await sendHumanLike(alamatKirim(jid), text);
  await logMessage(jid, 'out', sender, text);
}
