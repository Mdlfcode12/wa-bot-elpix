/**
 * Controller/Handler Layer for Baileys WhatsApp events.
 * Intercepts user requests, invokes DriveMediaService, and provides graceful fallback error handling.
 */
export class DriveMediaController {
  /**
   * @param {import('../services/driveMedia.service.js').DriveMediaService} driveMediaService
   */
  constructor(driveMediaService) {
    if (!driveMediaService) {
      throw new Error('[DriveMediaController] DriveMediaService dependency is required.');
    }
    this.driveMediaService = driveMediaService;
  }

  /**
   * Handler for user requests specifying catalog or image requests
   * 
   * @param {Object} params
   * @param {Object} params.sock Baileys WASocket instance
   * @param {string} params.jid WhatsApp user JID (e.g., 628123456789@s.whatsapp.net)
   * @param {string} params.driveFileId Target Google Drive File ID extracted from intent
   * @param {string} [params.caption] Optional image caption text
   */
  async handleCatalogImageRequest({ sock, jid, driveFileId, caption }) {
    try {
      await this.driveMediaService.processAndSendMedia({
        sock,
        jid,
        driveFileId,
        caption,
      });
    } catch (error) {
      console.error(`[DriveMediaController] Error processing request for drive_file_id "${driveFileId}":`, error.message);

      // Graceful Error Handling: Send friendly fallback text message to recipient
      const fallbackMessage = 'Maaf, gambar catalog yang Anda minta sedang tidak dapat diakses saat ini. Silakan coba beberapa saat lagi.';

      await sock.sendMessage(jid, { text: fallbackMessage }).catch((sendErr) => {
        console.error(`[DriveMediaController] Failed to send fallback message to ${jid}:`, sendErr.message);
      });
    }
  }
}
