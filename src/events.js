import { EventEmitter } from 'node:events';

/**
 * Bus event untuk Server-Sent Events.
 * Panel tidak lagi polling tiap 5 detik — server yang mendorong perubahan
 * begitu terjadi. Pesan pelanggan muncul di layar dalam hitungan milidetik,
 * dan itu yang membuat kontrol lewat web terasa lebih cepat dari lewat WhatsApp.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emit(type, payload) {
  bus.emit('event', { type, payload, at: new Date().toISOString() });
}
