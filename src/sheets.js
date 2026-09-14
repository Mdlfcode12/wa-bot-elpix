import { google } from 'googleapis';
import { config } from './config.js';

/**
 * Layout sheet yang diharapkan (tab "Contacts", baris 1 = header):
 *   A: nomor      B: nama    C: konteks
 *   D: consent    E: status  F: sent_at
 *
 * Kolom D (consent) WAJIB berisi "yes". Baris tanpa consent dilewati.
 * Ini bukan formalitas: UU PDP No. 27/2022 mensyaratkan dasar pemrosesan
 * yang sah untuk data pribadi (nomor telepon termasuk), dan penerima yang
 * tidak mengharapkan pesanmu adalah penyebab nomor satu akun kena banned.
 */

/**
 * Sheets bersifat opsional saat pengembangan. Kamu bisa menguji chatbot-nya
 * lebih dulu (kirim pesan ke nomor bot dari HP lain) tanpa menyiapkan
 * service account sama sekali. Yang tidak jalan hanya fitur pesan pembuka.
 */
export const sheetsConfigured = () =>
  Boolean(config.sheets.serviceAccountJson && config.sheets.spreadsheetId);

function authClient() {
  if (!sheetsConfigured()) {
    throw new Error(
      'Google Sheets belum dikonfigurasi. Isi SHEET_ID dan GOOGLE_SERVICE_ACCOUNT_JSON di .env ' +
      '(lihat SETUP.md langkah 4). Chatbot tetap bisa membalas tanpa ini.'
    );
  }
  let creds;
  try {
    creds = JSON.parse(Buffer.from(config.sheets.serviceAccountJson, 'base64').toString('utf8'));
  } catch {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON bukan base64 yang valid. ' +
      'Buat ulang dengan: base64 -w0 service-account.json'
    );
  }
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

const sheetsApi = () => google.sheets({ version: 'v4', auth: authClient() });

/** Reusable oleh modul lain (report.js). */
export const getSheetsApi = sheetsApi;

export async function fetchTargets() {
  const api = sheetsApi();
  const { data } = await api.spreadsheets.values.get({
    spreadsheetId: config.sheets.spreadsheetId,
    range: config.sheets.range,
  });

  const rows = data.values || [];

  return rows
    .map((r, i) => ({
      rowIndex: i + 2, // +2 karena range mulai A2
      phone: (r[0] || '').trim(),
      name: (r[1] || '').trim(),
      context: (r[2] || '').trim(),
      consent: (r[3] || '').trim().toLowerCase(),
      status: (r[4] || '').trim().toLowerCase(),
    }))
    .filter((r) => r.phone)
    .filter((r) => r.consent === 'yes')   // gerbang consent
    .filter((r) => r.status !== 'sent' && r.status !== 'failed' && r.status !== 'opted_out');
}

export async function fetchCatalog() {
  if (!sheetsConfigured()) return '';
  const api = sheetsApi();
  try {
    const { data } = await api.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: config.sheets.catalogRange,
    });

    let rows = data.values || [];
    if (rows.length === 0) return '';

    if (rows[0] && (rows[0][0] || '').toLowerCase().includes('nama')) {
      rows = rows.slice(1);
    }

    return rows.map(r => {
      const statusRaw = (r[5] || 'Available').trim();
      return `Nama Properti: ${r[0] || '-'}
Deskripsi & Detail Iklan: ${r[1] || '-'}
Link Maps: ${r[2] || '-'}
Komisi: ${r[3] || '-'}
Kontak Info Lanjut (Foto/Survei): ${r[4] || '-'}
Status: ${statusRaw}
Website Detail: ${r[6] || '-'}`;
    }).join('\n\n---\n\n');
  } catch (err) {
    console.error('[sheets] Gagal mengambil katalog:', err.message);
    return '';
  }
}

export async function fetchCatalogRaw() {
  if (!sheetsConfigured()) return [];
  const api = sheetsApi();
  try {
    const { data } = await api.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range: config.sheets.catalogRange,
    });

    let rows = data.values || [];
    if (rows.length === 0) return [];

    if (rows[0] && (rows[0][0] || '').toLowerCase().includes('nama')) {
      rows = rows.slice(1);
    }

    return rows.map(r => {
      const rawPhotos = r[7] || '';
      const photos = rawPhotos.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      return {
        name: r[0] || '',
        description: r[1] || '',
        maps: r[2] || '',
        status: (r[5] || 'Available').trim(),
        photos,
      };
    });
  } catch (err) {
    console.error('[sheets] Gagal mengambil raw katalog:', err.message);
    return [];
  }
}

export async function markRow(rowIndex, status) {
  const api = sheetsApi();
  const tab = config.sheets.range.split('!')[0];
  await api.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: `${tab}!E${rowIndex}:F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status, new Date().toISOString()]] },
  });
}

function colNumToLetter(colNum) {
  let temp, letter = '';
  while (colNum > 0) {
    temp = (colNum - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colNum = (colNum - temp - 1) / 26;
  }
  return letter;
}

/**
 * Cache peta ScorringAgent.
 *
 * recordReplyTime dan incrementAgentStat dipanggil di jalur panas — sekali
 * per pesan masuk. Tanpa cache, 10 pelanggan yang chat bersamaan berarti 10
 * pembacaan penuh tab ScorringAgent, dan kuota baca Sheets (60 permintaan per
 * menit per pengguna) habis justru saat bot paling sibuk. Begitu kena limit,
 * pemanggilnya melempar dan statistik agen diam-diam berhenti tercatat.
 *
 * Promise-nya yang disimpan, bukan hasilnya: lima pesan yang tiba berbarengan
 * ikut menunggu SATU pembacaan, bukan memicu lima.
 */
const SCORING_TTL_MS = 60_000;
let scoringCache = null;
let scoringAt = 0;

/** Dipanggil setelah menulis ke sheet, supaya pembacaan berikutnya segar. */
function invalidateScoringCache() {
  scoringCache = null;
  scoringAt = 0;
}

export async function getScoringAgentMap() {
  if (!sheetsConfigured()) return null;
  if (scoringCache && Date.now() - scoringAt < SCORING_TTL_MS) return scoringCache;

  const p = fetchScoringAgentMap();
  scoringCache = p;
  scoringAt = Date.now();
  // Kegagalan tidak boleh dikunci selama satu menit penuh.
  p.catch(() => invalidateScoringCache());
  return p;
}

async function fetchScoringAgentMap() {
  const api = sheetsApi();
  const range = config.sheets.scoringRange || 'ScorringAgent!A:K';
  const tab = range.split('!')[0];
  try {
    const { data } = await api.spreadsheets.values.get({
      spreadsheetId: config.sheets.spreadsheetId,
      range,
    });
    
    const rows = data.values || [];
    if (rows.length === 0) return null;
    
    // Parse Headers
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idxPhone = headers.findIndex(h => h.includes('wa') || h.includes('whatsapp') || h.includes('hp'));
    const idxWaktuBalas = headers.findIndex(h => h === 'waktu_balas' || h === 'waktu balas');
    const idxJmlSurvei = headers.findIndex(h => h === 'jml_survei' || h === 'jml survei' || h.includes('survei'));
    const idxJmlBuyer = headers.findIndex(h => h === 'jml_buyer' || h === 'jml buyer' || h.includes('buyer'));
    const idxName = headers.findIndex(h => h === 'nama_agen' || h === 'nama agen' || h.includes('nama'));
    
    return {
      rows,
      tab,
      indices: {
        phone: idxPhone,
        name: idxName,
        waktuBalas: idxWaktuBalas,
        jmlSurvei: idxJmlSurvei,
        jmlBuyer: idxJmlBuyer
      }
    };
  } catch (err) {
    console.error('[sheets] Gagal mengambil ScorringAgent:', err.message);
    return null;
  }
}

export async function recordReplyTime(jid, name) {
  const map = await getScoringAgentMap();
  if (!map) return;
  const { rows, tab, indices } = map;
  if (indices.waktuBalas === -1) return;
  
  const phone = jid.split('@')[0];
  
  let rowIndex = -1;
  if (indices.phone !== -1) {
    rowIndex = rows.findIndex((r, i) => i > 0 && r[indices.phone] && r[indices.phone].replace(/\D/g, '').endsWith(phone.slice(-9)));
  }
  if (rowIndex === -1 && indices.name !== -1 && name) {
    rowIndex = rows.findIndex((r, i) => i > 0 && r[indices.name] && r[indices.name].trim().toLowerCase() === name.trim().toLowerCase());
  }
  
  if (rowIndex === -1) return; // Agen tidak ditemukan
  
  const targetRow = rows[rowIndex];
  if (!targetRow[indices.waktuBalas]) {
    const colLetter = colNumToLetter(indices.waktuBalas + 1);
    const cellRange = `${tab}!${colLetter}${rowIndex + 1}`;
    
    const now = new Date();
    // Format Waktu Excel HH:MM:SS
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: config.outbound.timezone || 'Asia/Jakarta' });
    
    const api = sheetsApi();
    await api.spreadsheets.values.update({
      spreadsheetId: config.sheets.spreadsheetId,
      range: cellRange,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[timeStr]] },
    });
    // Baris di cache ikut ditandai. Tanpa ini, pesan berikutnya dalam jendela
    // cache masih melihat sel kosong dan menulis ulang waktu balas.
    targetRow[indices.waktuBalas] = timeStr;
    console.log(`[scoring] Waktu balas dicatat untuk ${name || phone} di cell ${cellRange}`);
  }
}

export async function incrementAgentStat(jid, name, type) {
  const map = await getScoringAgentMap();
  if (!map) return;
  const { rows, tab, indices } = map;
  
  const idx = type === 'survei' ? indices.jmlSurvei : indices.jmlBuyer;
  if (idx === -1) return;
  
  const phone = jid.split('@')[0];
  
  let rowIndex = -1;
  if (indices.phone !== -1) {
    rowIndex = rows.findIndex((r, i) => i > 0 && r[indices.phone] && r[indices.phone].replace(/\D/g, '').endsWith(phone.slice(-9)));
  }
  if (rowIndex === -1 && indices.name !== -1 && name) {
    rowIndex = rows.findIndex((r, i) => i > 0 && r[indices.name] && r[indices.name].trim().toLowerCase() === name.trim().toLowerCase());
  }
  
  if (rowIndex === -1) return;
  
  const targetRow = rows[rowIndex];
  const currentVal = parseInt(targetRow[idx], 10) || 0;
  const newVal = currentVal + 1;
  
  const colLetter = colNumToLetter(idx + 1);
  const cellRange = `${tab}!${colLetter}${rowIndex + 1}`;
  
  const api = sheetsApi();
  await api.spreadsheets.values.update({
    spreadsheetId: config.sheets.spreadsheetId,
    range: cellRange,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newVal]] },
  });
  // Nilai baru ditulis balik ke baris cache. Tanpa ini, dua kenaikan dalam
  // satu jendela cache sama-sama membaca angka lama dan yang kedua menimpa
  // yang pertama — hitungannya naik satu, bukan dua.
  targetRow[idx] = String(newVal);
  console.log(`[scoring] Jml_${type} ditambah jadi ${newVal} untuk ${name || phone} di cell ${cellRange}`);
}
