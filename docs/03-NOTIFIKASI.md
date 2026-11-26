# Notifikasi tamu: email (Resend) dan WhatsApp (Cloud API)

Kode pengiriman sudah siap dan sudah live. Selama kunci belum diisi, pesan menunggu di antrean (`notification_outbox`) dan **dilewati bila belum terkirim dalam 48 jam**, supaya tamu tidak menerima konfirmasi yang sudah basi begitu kunci baru dipasang. Status setiap pesan terlihat di kartu **"Pesan ke tamu"** pada halaman reservasi staf.

**Keputusan pemilik (26 Nov 2026):** pesan dikirim lewat email dan WhatsApp, ke saluran yang datanya ada (keduanya bila tamu memberi email dan nomor HP). Email berisi rincian lengkap; WhatsApp berisi ringkasan singkat dengan tautan ke halaman booking.

## Pesan yang dikirim

| Jenis | Kapan | Template WhatsApp |
|---|---|---|
| Konfirmasi pesanan | Booking terkonfirmasi (bayar, garansi tanpa deposit, reservasi staf) | `booking_confirmed` |
| Perubahan pesanan | Tanggal, vila, atau harga berubah | `booking_modified` |
| Pembatalan | Booking terkonfirmasi dibatalkan (dengan info refund) | `booking_cancelled` |
| Keputusan late check-out | Staf menyetujui (dengan/tanpa biaya) atau menolak | `late_checkout_approved` / `late_checkout_declined` |
| Keputusan early check-in | Sama seperti di atas | `early_checkin_approved` / `early_checkin_declined` |
| Pengingat pre-check-in | 3 hari sebelum tiba (atau kurang), bila belum diisi | `precheckin_reminder` |
| Pengingat pembayaran | Sehari sebelum jatuh tempo sisa tagihan atau deposit garansi, bila belum lunas | `payment_reminder` |

Pengingat dibuat oleh tugas terjadwal (lihat bagian Cron). Pesan lain dikirim segera setelah kejadiannya (bila kunci sudah ada), dan dicoba ulang otomatis sampai 5 kali bila gagal sementara.

## 1. Email lewat Resend

Langkah ini dikerjakan pemilik akun:

1. Daftar di resend.com.
2. **Domains → Add domain**, misalnya `attarahospitality.com`, lalu tambahkan record DNS (SPF, DKIM) yang diminta Resend di pengelola DNS domain. Tunggu sampai statusnya *Verified*.
3. **API Keys → Create API key** dengan izin *Sending access*.
4. Di hPanel → Website `be.attarahospitality.com` → Node.js → Environment variables, isi:

| Variabel | Isi |
|---|---|
| `RESEND_API_KEY` | API key dari langkah 3 |
| `EMAIL_FROM` | Pengirim di domain yang sudah diverifikasi, misalnya `Attara Hospitality <booking@attarahospitality.com>` |
| `EMAIL_REPLY_TO` | (opsional) alamat yang menerima balasan tamu, misalnya `reservasi@attarahospitality.com` |

5. Deploy ulang (atau restart aplikasi) agar variabel terbaca.

## 2. WhatsApp lewat WhatsApp Cloud API (Meta)

Pesan yang dimulai oleh bisnis wajib memakai **template yang sudah disetujui Meta**. Langkah:

1. Buat atau pakai **Meta Business Account**, lalu di developers.facebook.com buat App bertipe *Business* dan tambahkan produk **WhatsApp**.
2. Daftarkan nomor WhatsApp bisnis (nomor yang belum dipakai di aplikasi WhatsApp biasa), verifikasi bisnis bila diminta.
3. Catat **Phone number ID** dari WhatsApp → API Setup.
4. Buat **token permanen**: Business Settings → Users → System users → tambah system user (Admin) → Generate token dengan izin `whatsapp_business_messaging` dan `whatsapp_business_management`.
5. Buat template di WhatsApp Manager → Message templates, kategori **Utility**, dengan **nama persis** seperti di bawah, dalam bahasa **Indonesian (id)** dan **English (en)**. Urutan parameter `{{1}}`, `{{2}}`, … harus sama.
6. Isi di hPanel:

| Variabel | Isi |
|---|---|
| `WHATSAPP_TOKEN` | Token permanen dari langkah 4 |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number ID dari langkah 3 |
| `WHATSAPP_API_VERSION` | (opsional) versi Graph API, bawaan `v23.0` |

Nomor HP tamu yang diawali `0` dianggap nomor Indonesia (`08…` → `628…`). Nomor yang tidak valid tidak dikirimi WhatsApp.

### Template yang perlu didaftarkan

Contoh teks bahasa Indonesia (versi Inggris dibuat dengan arti yang sama dan urutan parameter yang sama):

- **`booking_confirmed`**: `Halo {{1}}, pesanan {{2}} di {{3}} untuk {{4}} sudah terkonfirmasi. Rincian dan pre-check-in online: {{5}}`
  - {{1}} nama depan · {{2}} kode pesanan · {{3}} tipe vila · properti · {{4}} tanggal menginap · {{5}} tautan halaman booking
- **`booking_modified`**: `Halo {{1}}, pesanan {{2}} sudah diubah. Tanggal menginap sekarang: {{3}}. Rincian terbaru: {{4}}`
- **`booking_cancelled`**: `Halo {{1}}, pesanan {{2}} sudah dibatalkan. Refund: {{3}}. Rincian: {{4}}`
- **`late_checkout_approved`**: `Halo {{1}}, late check-out sampai pukul {{2}} sudah disetujui. Biaya: {{3}}. Rincian: {{4}}`
- **`late_checkout_declined`**: `Halo {{1}}, mohon maaf, late check-out sampai pukul {{2}} tidak dapat kami penuhi. Rincian pesanan: {{3}}`
- **`early_checkin_approved`**: `Halo {{1}}, early check-in mulai pukul {{2}} sudah disetujui. Biaya: {{3}}. Rincian: {{4}}`
- **`early_checkin_declined`**: `Halo {{1}}, mohon maaf, early check-in mulai pukul {{2}} tidak dapat kami penuhi. Rincian pesanan: {{3}}`
- **`precheckin_reminder`**: `Halo {{1}}, kedatangan Anda di {{2}} pada {{3}} sudah dekat. Isi pre-check-in online agar check-in lebih cepat: {{4}}`
- **`payment_reminder`**: `Halo {{1}}, pengingat pembayaran {{2}} yang jatuh tempo pada {{3}}. Abaikan bila sudah membayar. Rincian: {{4}}`
- **`addon_confirmed`**: `Halo {{1}}, {{2}} pada {{3}} sudah dikonfirmasi. {{4}} ditambahkan ke tagihan Anda. Rincian: {{5}}`
  - {{2}} nama add-on · {{3}} tanggal dan jam · {{4}} harga
- **`addon_declined`**: `Halo {{1}}, mohon maaf, {{2}} pada {{3}} tidak dapat kami siapkan. Tidak ada biaya untuk itu. Rincian: {{4}}`

Biaya yang nol tampil sebagai "Rp 0"; boleh ditulis di template misalnya "Biaya tambahan: {{3}}".

## 3. Tugas terjadwal (cron)

Endpoint `GET /api/cron/tick` menjalankan: melepas hold yang kedaluwarsa, menghapus nomor dokumen tamu yang masa simpannya habis, membuat pengingat, dan mengirim pesan yang menunggu. Endpoint ini **nonaktif sampai `CRON_SECRET` diisi**.

1. Buat nilai acak panjang sendiri, misalnya dengan perintah di bawah, lalu isi sebagai `CRON_SECRET` di hPanel (jangan dibagikan):

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. hPanel → Advanced → Cron Jobs → tambah cron tiap 5 menit (`*/5 * * * *`) dengan perintah:

   ```
   curl -fsS -H "Authorization: Bearer ISI_CRON_SECRET" https://be.attarahospitality.com/api/cron/tick
   ```

Responsnya JSON berisi jumlah hold yang dilepas, nomor dokumen yang dihapus, pengingat yang dibuat, pesan terkirim/gagal, dan saluran mana yang aktif.

## Ringkasan variabel lingkungan

| Variabel | Wajib untuk | Catatan |
|---|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | Email | `EMAIL_REPLY_TO` opsional |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | `WHATSAPP_API_VERSION` opsional |
| `CRON_SECRET` | Tugas terjadwal | Tanpa ini, pengingat tidak dibuat dan pesan hanya terkirim saat ada aktivitas |
| `APP_URL` | Tautan di pesan | Bila kosong memakai `BETTER_AUTH_URL` |
