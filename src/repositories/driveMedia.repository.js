/**
 * Repository Layer for Drive Media Cache
 * Handles all direct interaction with the PostgreSQL database.
 */
export class DriveMediaRepository {
  /**
   * @param {import('pg').Pool} dbPool PostgreSQL pool instance
   */
  constructor(dbPool) {
    if (!dbPool) {
      throw new Error('[DriveMediaRepository] Database pool instance is required.');
    }
    this.pool = dbPool;
  }

  /**
   * Initialize PostgreSQL table schema for caching
   */
  async initSchema() {
    const query = `
      CREATE TABLE IF NOT EXISTS drive_media_cache (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        drive_file_id VARCHAR(255) UNIQUE NOT NULL,
        wa_media_url TEXT NOT NULL,
        mime_type VARCHAR(100) DEFAULT 'image/jpeg',
        file_size BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_drive_media_cache_file_id ON drive_media_cache(drive_file_id);
    `;
    await this.pool.query(query);
  }

  /**
   * Find cache record by Google Drive File ID
   * @param {string} driveFileId 
   * @returns {Promise<Object|null>}
   */
  async findByDriveId(driveFileId) {
    const query = `
      SELECT id, drive_file_id, wa_media_url, mime_type, file_size, created_at, updated_at
      FROM drive_media_cache 
      WHERE drive_file_id = $1 
      LIMIT 1;
    `;
    const { rows } = await this.pool.query(query, [driveFileId]);
    return rows[0] || null;
  }

  /**
   * Insert or update cached media entry
   * @param {Object} data 
   * @param {string} data.driveFileId 
   * @param {string} data.waMediaUrl Local buffer path or media URL reference
   * @param {string} [data.mimeType] 
   * @param {number} [data.fileSize] 
   * @returns {Promise<Object>}
   */
  async saveCache({ driveFileId, waMediaUrl, mimeType = 'image/jpeg', fileSize = null }) {
    const query = `
      INSERT INTO drive_media_cache (drive_file_id, wa_media_url, mime_type, file_size, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (drive_file_id) 
      DO UPDATE SET 
        wa_media_url = EXCLUDED.wa_media_url,
        mime_type = EXCLUDED.mime_type,
        file_size = EXCLUDED.file_size,
        updated_at = NOW()
      RETURNING *;
    `;
    const { rows } = await this.pool.query(query, [
      driveFileId,
      waMediaUrl,
      mimeType,
      fileSize,
    ]);
    return rows[0];
  }
}
