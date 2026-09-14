import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import axios from 'axios';

/**
 * Service Layer for Google Drive Media operations with PostgreSQL Caching.
 * Enforces clean separation of concerns, dependency injection, and caching logic.
 */
export class DriveMediaService {
  /**
   * @param {Object} dependencies
   * @param {import('../repositories/driveMedia.repository.js').DriveMediaRepository} dependencies.repository
   * @param {string} [dependencies.storageDir] Local directory for storing cached media files
   * @param {import('axios').AxiosInstance} [dependencies.httpClient] Axios instance
   */
  constructor({ repository, storageDir, httpClient }) {
    if (!repository) {
      throw new Error('[DriveMediaService] Repository dependency is required.');
    }
    this.repository = repository;
    this.storageDir = storageDir || path.join(process.cwd(), 'storage', 'drive_cache');
    this.http = httpClient || axios;

    // Ensure local storage directory exists
    if (!fsSync.existsSync(this.storageDir)) {
      fsSync.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Constructs direct download URL for Google Drive file
   * @param {string} driveFileId 
   * @returns {string}
   */
  getGoogleDriveUrl(driveFileId) {
    return `https://drive.google.com/uc?export=download&id=${driveFileId}`;
  }

  /**
   * Fetches image buffer from Google Drive via Axios using CDN fallbacks
   * @param {string} driveFileId 
   * @returns {Promise<{ buffer: Buffer, mimeType: string, fileSize: number }>}
   */
  async fetchFromDrive(driveFileId) {
    const candidateUrls = [
      `https://lh3.googleusercontent.com/d/${driveFileId}`,
      `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w1600`,
      `https://drive.google.com/uc?export=download&id=${driveFileId}`,
    ];

    let lastError = null;
    for (const url of candidateUrls) {
      try {
        const response = await this.http.get(url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });

        const buffer = Buffer.from(response.data);
        const contentType = (response.headers['content-type'] || 'image/jpeg').toLowerCase();

        // Skip HTML warning / virus scan prompt pages
        if (contentType.includes('html') || buffer.slice(0, 15).toString().includes('<!DOCTYPE')) {
          continue;
        }

        if (buffer.length > 500) {
          return {
            buffer,
            mimeType: contentType.includes('png') ? 'image/png' : 'image/jpeg',
            fileSize: buffer.length,
          };
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(lastError?.message || `Gagal mengunduh foto Google Drive (${driveFileId}) setelah beberapa percobaan.`);
  }

  /**
   * Core workflow logic:
   * 1. Check PostgreSQL cache
   * 2. Cache Hit -> Retrieve cached media file reference & send directly via Baileys
   * 3. Cache Miss -> Download from Drive via Axios -> Save to disk & PostgreSQL cache -> Send via Baileys
   * 
   * @param {Object} params
   * @param {Object} params.sock Baileys WASocket instance
   * @param {string} params.jid Recipient WhatsApp JID
   * @param {string} params.driveFileId Target Google Drive File ID
   * @param {string} [params.caption] Optional image caption
   * @returns {Promise<{ success: boolean, cacheHit: boolean, mediaPath: string }>}
   */
  async processAndSendMedia({ sock, jid, driveFileId, caption = '' }) {
    if (!driveFileId) {
      throw new Error('Missing drive_file_id parameter.');
    }

    // Step 1 & 2: Check PostgreSQL Cache
    const cachedRecord = await this.repository.findByDriveId(driveFileId);

    if (cachedRecord && fsSync.existsSync(cachedRecord.wa_media_url)) {
      console.log(`[DriveMediaService] Cache HIT for drive_file_id: ${driveFileId}`);

      const cachedBuffer = await fs.readFile(cachedRecord.wa_media_url);

      // Cache Hit: Send media directly via Baileys using cached Buffer
      await sock.sendMessage(jid, {
        image: cachedBuffer,
        caption: caption || undefined,
      });

      return {
        success: true,
        cacheHit: true,
        mediaPath: cachedRecord.wa_media_url,
      };
    }

    // Step 3: Cache Miss
    console.log(`[DriveMediaService] Cache MISS for drive_file_id: ${driveFileId}. Downloading from Google Drive...`);

    const { buffer, mimeType, fileSize } = await this.fetchFromDrive(driveFileId);

    // Save image buffer to local filesystem cache
    const extension = mimeType.includes('png') ? 'png' : 'jpg';
    const cachedFilePath = path.join(this.storageDir, `${driveFileId}.${extension}`);
    await fs.writeFile(cachedFilePath, buffer);

    // Send image buffer directly to the user via Baileys socket
    await sock.sendMessage(jid, {
      image: buffer,
      caption: caption || undefined,
    });

    // Save reference / state to PostgreSQL drive_media_cache table
    await this.repository.saveCache({
      driveFileId,
      waMediaUrl: cachedFilePath,
      mimeType,
      fileSize,
    });

    console.log(`[DriveMediaService] Successfully cached and sent image for drive_file_id: ${driveFileId}`);

    return {
      success: true,
      cacheHit: false,
      mediaPath: cachedFilePath,
    };
  }
}
