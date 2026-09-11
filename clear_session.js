import { pool } from './src/authState.js';

pool.query('DELETE FROM wa_auth').then(() => {
  console.log('Sesi WhatsApp lama berhasil dihapus dari database!');
  process.exit(0);
}).catch((err) => {
  console.error('Gagal menghapus sesi:', err);
  process.exit(1);
});
