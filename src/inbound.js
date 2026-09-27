import path from 'node:path';
import fs from 'node:fs';
import { PerChatQueue } from './limiter.js';
import { askAI } from './gemini.js';
import { loadHistory, appendTurn, markOptedOut } from './memory.js';
import { sendHumanLike, sendImageHumanLike, getSock } from './client.js';
import { getFlags, isChatPaused, pauseChat } from './state.js';
import { logMessage, saveLidMapping, loadLidMappings } from './messages.js';
import { pushAlert } from './notify.js';
import { emit } from './events.js';
import { config } from './config.js';
import { recordReplyTime, incrementAgentStat, fetchCatalog, fetchCatalogRaw } from './sheets.js';

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

/**
 * Tanya WhatsApp sendiri: LID ini nomornya berapa?
 *
 * Baileys menyimpan pemetaan LID<->nomor di signalRepository dan bisa
 * menanyakannya ke server kalau belum ada di cache lokal. Ini menutup kasus
 * yang dulu bikin pesan hilang: kontak baru yang menulis duluan, yang
 * stanza-nya tidak pernah membawa senderPn sama sekali.
 *
 * Hasil dari server berbentuk `628xx:0@s.whatsapp.net` (ada nomor perangkat).
 * Nomor perangkat harus dibuang, kalau tidak jid-nya tidak cocok dengan
 * kontak yang sudah ada di database.
 */
async function tanyaNomor(lid) {
  try {
    const pn = await getSock()?.signalRepository?.lidMapping?.getPNForLID?.(lid);
    if (!pn) return null;
    const bersih = pn.replace(/:\d+@/, '@');
    ingatLid(lid, bersih);
    console.log(`[WA-IN] LID ${lid} dipetakan lewat WhatsApp -> ${bersih}`);
    return bersih;
  } catch (e) {
    console.warn(`[WA-IN] gagal menanyakan nomor untuk ${lid}: ${e.message}`);
    return null;
  }
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

/** Konversi link Google Drive file biasa ke direct CDN image URL agar WhatsApp bisa menampilkan gambar */
function convertGDriveUrl(url) {
  if (!url) return url;
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return `https://lh3.googleusercontent.com/d/${match[1]}`;
  }
  return url;
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
    const dikenal = lidToPhone.get(jid) || (await tanyaNomor(jid));
    if (dikenal) {
      jid = dikenal;
    } else {
      // Tidak ketemu juga. JANGAN dibuang: pesan pelanggan hilang diam-diam
      // adalah kegagalan yang lebih buruk daripada riwayat terpecah.
      // LID-nya sendiri dipakai sebagai identitas — stabil per kontak, dan
      // balasan ke alamat itu pasti punya sesi enkripsi hidup.
      // ponytail: riwayat kontak ini terpisah dari riwayat ber-nomornya kalau
      // nomornya baru terlihat belakangan. Gabungkan (UPDATE conversations
      // SET jid) kalau kontak dobel mulai mengganggu di panel.
      console.warn(`[WA-IN] LID ${rawJid} tak terpetakan ke nomor. Diproses sebagai kontak LID.`);
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
  //
  // Tapi kegagalan database TIDAK BOLEH membatalkan balasan. Sebelumnya
  // logMessage yang melempar (Postgres putus) menghentikan handler di sini,
  // dan pesan pelanggan hilang tanpa jejak — persis yang terjadi saat testing,
  // 60 ECONNREFUSED di log dan tidak satu pun pesan dibalas. Mencatat itu
  // penting; membalas lebih penting.
  await logMessage(jid, 'in', 'customer', text)
    .catch((e) => console.error('[WA-IN] gagal mencatat pesan masuk:', e.message));
  await getSock().readMessages([msg.key]).catch(() => {});

  // Flag dibaca dari cache; kalau database putus, pakai nilai terakhir yang
  // diketahui daripada mendiamkan pelanggan.
  const flags = await getFlags().catch(() => ({ ai_enabled: true }));
  if (!flags.ai_enabled) return;          // kill switch global
  // Gagal cek pause → anggap tidak dipause. Risiko: satu balasan AI nyasar ke
  // chat yang sedang kamu pegang. Itu jauh lebih ringan daripada pelanggan
  // didiamkan karena database sedang batuk.
  if (await isChatPaused(jid).catch(() => false)) return;

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
  const flags = await getFlags().catch(() => ({ ai_enabled: true }));
  if (!flags.ai_enabled || (await isChatPaused(jid).catch(() => false))) return;

  // Histori kosong jauh lebih baik daripada tidak membalas: bot kehilangan
  // konteks percakapan, tapi pelanggan tetap dijawab.
  const { history, name, context, optedOut } = await loadHistory(jid)
    .catch((e) => {
      console.error('[inbound] gagal memuat histori, lanjut tanpa konteks:', e.message);
      return { history: [], name: null, context: null, optedOut: false };
    });
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
  const final = await getFlags().catch(() => ({ ai_enabled: true }));
  if (!final.ai_enabled || (await isChatPaused(jid).catch(() => false))) {
    console.log(`[inbound] Balasan untuk ${jid} dibatalkan (dihentikan admin)`);
    emit('cancelled', { jid });
    return;
  }

  let cleanReply = reply;
  const photosToSend = [];

  // Cek apakah ada permintaan foto secara eksplisit dari pesan user atau tag [KIRIM_FOTO] / [FOTO:] dari AI
  const hasKirimFotoTag = /\[KIRIM_FOTO\]/i.test(reply) || /\[FOTO:/i.test(reply);
  const userWantsPhotos = /foto|gambar|spill|katalog|lihat|penampakan|pict|picture|photo|detail/i.test(userText);
  const shouldSendPhotos = hasKirimFotoTag || userWantsPhotos;

  if (shouldSendPhotos) {
    // 1. Ekstrak tag [FOTO: ...] jika ada
    const fotoMatches = [...cleanReply.matchAll(/\[FOTO:\s*([^\]]+)\]/gi)];
    if (fotoMatches.length > 0) {
      for (const m of fotoMatches) {
        const rawUrls = m[1].split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
        for (let u of rawUrls) {
          u = convertGDriveUrl(u);
          if (u.startsWith('http://') || u.startsWith('https://')) {
            photosToSend.push(u);
          }
        }
      }
    }

    // 2. Ambil foto langsung dari Katalog Sheets jika photosToSend masih kosong & user/AI memang minta foto
    if (photosToSend.length === 0) {
      try {
        const rawCatalog = await fetchCatalogRaw();
        const fullSearchText = (userText + ' ' + cleanReply).toLowerCase();
        for (const item of rawCatalog) {
          const propName = item.name.toLowerCase().trim();
          const keywords = propName.split(/\s+/).filter(k => k.length > 3 && !['rumah', 'kost', 'di', 'dan', 'siap', 'huni'].includes(k));

          const isMatch = keywords.some(kw => fullSearchText.includes(kw));
          if (isMatch && item.photos.length > 0) {
            for (let u of item.photos) {
              const converted = convertGDriveUrl(u);
              if (converted.startsWith('http://') || converted.startsWith('https://')) {
                photosToSend.push(converted);
              }
            }
            if (photosToSend.length > 0) {
              console.log(`[WA-IN] 📸 Foto dikirim atas permintaan untuk properti: "${item.name}" (${photosToSend.length} foto)`);
              break;
            }
          }
        }
      } catch (err) {
        console.error('[WA-IN] Gagal auto-match foto dari katalog:', err.message);
      }
    }
  }

  if (cleanReply.includes('[SURVEI]')) {
    cleanReply = cleanReply.replace(/\[SURVEI\]/g, '').trim();
    incrementAgentStat(jid, name, 'survei').catch(e => console.error('[scoring] gagal tambah survei:', e.message));
  }
  if (cleanReply.includes('[BUYER]')) {
    cleanReply = cleanReply.replace(/\[BUYER\]/g, '').trim();
    incrementAgentStat(jid, name, 'buyer').catch(e => console.error('[scoring] gagal tambah buyer:', e.message));
  }

  // Sembunyikan/bersihkan semua tag internal [KIRIM_FOTO], [FOTO:...], dan link Drive dari teks balasan
  cleanReply = cleanReply
    .replace(/\[KIRIM_FOTO\]/gi, '')
    .replace(/\[FOTO:\s*([^\]]+)\]/gi, '')
    .replace(/Link Foto:\s*https?:\/\/[^\s\n]+/gi, '')
    .replace(/Link Foto:\s*-[^\n]*/gi, '')
    .replace(/https?:\/\/(?:drive\.google\.com\/file\/d\/[a-zA-Z0-9_-]+|lh3\.googleusercontent\.com\/d\/[a-zA-Z0-9_-]+)[^\s,\]]*/gi, '')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  await replyAs(jid, 'ai', cleanReply);

  // Kirim foto secara otomatis jika ada (dengan deduplikasi & jeda bertahap)
  const uniquePhotos = [...new Set(photosToSend)];
  for (let i = 0; i < uniquePhotos.length; i++) {
    const imgUrl = uniquePhotos[i];
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      await sendImageHumanLike(alamatKirim(jid), imgUrl);
      await logMessage(jid, 'out', 'ai', `📷 [Foto Terkirim (${i + 1}/${uniquePhotos.length}): ${imgUrl}]`)
        .catch((e) => console.error('[WA-OUT] gagal mencatat foto:', e.message));
    } catch (err) {
      console.error(`[inbound] Gagal mengirim foto ${i + 1} (${imgUrl}):`, err.message);
    }
  }

  // Pesan sudah terkirim. Gagal menyimpan histori tidak boleh dilaporkan
  // sebagai giliran yang gagal.
  await appendTurn(jid, userText, cleanReply)
    .catch((err) => console.error('[inbound] gagal menyimpan histori:', err.message));
}

/** Satu jalur kirim untuk AI maupun balasan manusia dari panel. */
export async function replyAs(jid, sender, text) {
  // Kirim ke alamat yang sehat (bisa @lid), tapi catat di panel dengan nomor
  // supaya riwayat percakapan tidak terpecah jadi dua kontak.
  await sendHumanLike(alamatKirim(jid), text);
  await logMessage(jid, 'out', sender, text)
    .catch((e) => console.error('[WA-OUT] gagal mencatat balasan:', e.message));
}
