# Plan Pengembangan: Booking Engine + PMS Vila "10x"

Dasar plan ini adalah analisis demo SAVARA di [01-ANALISIS-DEMO-SAVARA.md](01-ANALISIS-DEMO-SAVARA.md).
Status: **draf untuk diputuskan bersama**. Ada beberapa keputusan terbuka di bagian 9 yang mengubah lingkup.

**Keputusan 25 Nov 2026:** kita membangun untuk **satu brand dulu** (satu pengelola vila dengan beberapa cabang, seperti Savara), bukan SaaS multi-tenant.

---

## 1. Apa arti "10x lebih baik"

Demo SAVARA sudah bagus di **desain, guardrail aturan bisnis, dan RBAC**. Kelemahannya: semuanya **simulasi**, dan banyak fitur inti hotel nyata masih berlabel "milestone berikutnya".
Jadi "10x" bukan berarti tampilan yang lebih cantik. Artinya:

1. **Nyata dan andal**: database, login, pembayaran, notifikasi, dan jaminan tidak ada double-booking di level database.
2. **Menghasilkan uang**: mesin tarif, deposit, upsell, promo, dan distribusi ke OTA.
3. **Menghemat waktu staf**: papan "hari ini" yang selalu benar, housekeeping di HP, dan tugas otomatis dari setiap permintaan tamu.
4. **Tamu bisa melayani diri sendiri**: kelola booking, pre-check-in online, dan pesan pengalaman.
5. **Data untuk keputusan**: laporan dengan periode, YoY, pace/pickup, ekspor, dan laporan pemilik.

### Target terukur (demo → kita)

| Area | Demo SAVARA | Target kita |
|---|---|---|
| Data | Di browser, hilang saat ganti perangkat | PostgreSQL, multi-perangkat, backup harian |
| Double-booking | Dicek di UI saja | **Dicegah oleh constraint DB** (exclusion constraint) + hold 15 menit saat checkout |
| Pembayaran | Simulasi, bayar penuh saja | Gateway nyata (QRIS, VA, kartu, e-wallet), deposit/sisa, refund |
| Tarif | 1 harga datar per tipe | Musim, akhir pekan, min-stay, LOS discount, promo, paket tarif, pajak & service |
| Ubah tanggal | Belum ada | Ada, termasuk selisih harga otomatis |
| Distribusi | Situs sendiri saja | + iCal (Airbnb/Booking.com) → channel manager |
| Notifikasi | Tidak ada | Email + WhatsApp (konfirmasi, pengingat, pre-arrival) |
| Portal tamu | Lihat saja, di browser yang sama | Ubah/batal sesuai kebijakan, pre-check-in, add-on, folio |
| Housekeeping | Tombol di dasbor | PWA mobile: tugas, checklist, foto, ditugaskan ke petugas |
| Laporan | 5 bulan tetap, tanpa ekspor | Periode bebas, YoY, pace, ekspor CSV/XLSX, laporan terjadwal |
| Konsistensi papan hari ini | Bug B1–B2 | Satu sumber state di server + realtime, tanpa kilatan state usang |
| Performa publik | Belum diukur | LCP < 2,0 dtk di 4G, skor Lighthouse ≥ 95 |

---

## 2. Prinsip produk (yang kita pertahankan dari demo, lalu tingkatkan)

- **Tombol nonaktif selalu menjelaskan alasannya** (dari demo, dipertahankan).
- **Satu sumber kebenaran**: semua status diturunkan dari event di server, bukan dihitung ulang di tiap halaman (memperbaiki B2).
- **Setiap aksi tercatat** dengan siapa, apa, kapan (sampai detik), dan nilai sebelum/sesudah (memperbaiki B6).
- **Label jujur** untuk data ilustratif.
- **Bilingual penuh** (ID/EN), termasuk judul halaman dan pesan error (memperbaiki B7). Kunci terjemahan dicek di CI.
- **Mobile-first untuk staf lapangan, desktop-first untuk back office.**

---

## 3. Arsitektur yang diusulkan

> Rekomendasi. Bisa berubah sesuai keputusan di bagian 9.

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Framework | **Next.js (App Router) + TypeScript** | Sama dengan demo. SSR/SEO untuk situs publik, satu codebase untuk publik dan ops |
| UI | Tailwind + komponen sendiri (design tokens) + Storybook | Menggantikan `/internal/components` |
| Hosting | **Hostinger Cloud Professional** (diputuskan), app Node.js di `be.attarahospitality.com` selama development | Akun Hostinger sudah ada. SSL aktif |
| Database | **PostgreSQL di Supabase** (diputuskan), project `booking-engine-rk`, region Singapura | Postgres penuh, jadi `daterange` + `EXCLUDE USING gist` tetap bisa dipakai untuk mencegah dua reservasi di unit yang sama pada malam yang sama |
| ORM | Drizzle (atau Prisma) | Migrasi bertipe |
| Auth | **Supabase Auth** (sudah termasuk di Supabase) atau Better Auth. Keduanya dengan **2FA** untuk staf dan magic link untuk tamu | Demo tidak punya login. Pilihan final di Fase 0 |
| Job & jadwal | Antrean berbasis Postgres (`pg-boss`) atau `pg_cron` Supabase, dipicu cron Hostinger bila perlu | Tidak butuh Redis terpisah. Untuk hold kedaluwarsa, pengingat, sinkronisasi iCal, laporan terjadwal |
| Realtime | **Supabase Realtime** untuk papan hari ini dan housekeeping | Menghilangkan state usang (B1, B2) |
| Pembayaran | **Xendit** (diputuskan): QRIS, virtual account, e-wallet, dan kartu | Satu gateway untuk tamu domestik dan internasional. Rincian ada di bagian 3a |
| Notifikasi | Email (Resend/SES) + **WhatsApp Business Cloud API** | WhatsApp adalah kanal utama di Indonesia |
| File | Penyimpanan S3-compatible | Foto vila, foto housekeeping, dokumen ID tamu (terenkripsi) |
| Observability | Sentry + log terstruktur + uptime check | |
| Testing | Vitest (unit), **property-based test untuk ketersediaan & harga**, Playwright (E2E per peran) | Aturan bisnis adalah inti produk |

### 3a. Pembayaran dengan Xendit

**Pendekatan MVP: halaman pembayaran yang di-host Xendit** (Invoice/Payment Link). Tamu diarahkan ke halaman Xendit lalu kembali ke situs kita.
- Alasan: paling cepat dibangun, semua metode tampil di satu halaman, dan data kartu tidak pernah menyentuh server kita, sehingga beban kepatuhan keamanan kartu jauh lebih ringan.
- Nanti (Fase 3+) bisa diganti ke pembayaran tertanam di halaman kita sendiri kalau ingin pengalaman yang lebih mulus.

**Alur:**
1. Tamu menyelesaikan langkah "Data diri". Server membuat reservasi berstatus **Hold** (unit dikunci 15 menit) dan membuat tagihan Xendit untuk deposit atau pembayaran penuh, dengan masa berlaku yang sama.
2. Tamu membayar di halaman Xendit.
3. **Webhook Xendit** masuk. Server memverifikasi token callback, mencatat pembayaran (idempoten, jadi webhook ganda tidak tercatat dua kali), dan mengubah Hold menjadi **Confirmed**.
4. Kalau tagihan kedaluwarsa atau gagal, Hold dilepas otomatis oleh job terjadwal dan unit kembali tersedia.
5. Halaman "kembali dari Xendit" hanya **membaca** status dari server. Status lunas tidak pernah ditentukan dari parameter URL.

**Hal yang harus dicek di dokumentasi Xendit saat implementasi** (belum saya verifikasi, jadi jangan dianggap pasti):
- Metode mana yang mendukung **refund lewat API**. Untuk metode yang tidak mendukung (misalnya kemungkinan VA), refund dilakukan lewat transfer keluar dan dicatat manual di folio.
- Dukungan kartu internasional dan biaya per metode, untuk menentukan apakah biaya dibebankan ke tamu atau ditanggung properti.
- Mata uang: rencana kita tetap **menagih dalam IDR**. Mata uang lain hanya untuk tampilan perkiraan.
- Lingkungan uji (test mode) dan kunci API terpisah untuk staging dan produksi.

**Status (25 Nov 2026):** dokumentasi resmi Xendit kini menyebut Invoice API sebagai *legacy* dan halaman referensinya tidak bisa dibuka lagi, jadi kode dipindah ke **Payment Sessions** (`POST /sessions`, `session_type: PAY`, `mode: PAYMENT_LINK`, IDR/ID). Webhook `payment_session.completed`/`expired` dicek dengan `x-callback-token`, lalu status dan jumlah dibaca ulang dari API Xendit sebelum booking dikonfirmasi. Tautan pembayaran ditutup di Xendit saat meja depan menerima uang atau booking dibatalkan. Sudah diuji dengan Xendit tiruan (tes otomatis), **belum** dengan Xendit sungguhan karena **belum ada akun Xendit**. Langkah berikutnya: daftar di dashboard.xendit.co/register (Test Mode tersedia setelah daftar menurut dokumentasi), buat secret key (Money-in: Write), set webhook ke `https://be.attarahospitality.com/api/webhooks/xendit`, isi `XENDIT_SECRET_KEY` dan `XENDIT_CALLBACK_TOKEN` di hPanel, lalu tes end-to-end. Catatan dari halaman biaya Xendit: ada biaya minimum bulanan USD 50 (kecuali bulan pertama), dan untuk Indonesia akun perorangan/Perseroan Perorangan hanya boleh sebagai sub-akun.

**Di sisi ops:** setiap pembayaran, refund, dan tagihan kedaluwarsa tercatat di folio dan log audit. Staf bisa membuat **link pembayaran** untuk reservasi manual (telepon/WA) dan untuk pelunasan sisa tagihan.

### Konsekuensi keputusan "satu brand dulu"

- **Tidak dibangun sekarang:** routing per tenant (subdomain/domain per klien), tagihan langganan, onboarding mandiri, dan isolasi data antar-tenant. Ini memangkas cukup banyak pekerjaan di Fase 0.
- **Tetap dijaga agar pindah ke SaaS nanti cukup migrasi, bukan tulis ulang:**
  - Konten dan identitas brand (nama, logo, warna, teks halaman, kebijakan, template pesan) disimpan di **konfigurasi atau database**, bukan di dalam kode.
  - Semua data operasional sudah tercakup per **Property/Cabang**. Kalau nanti jadi multi-tenant, cukup ditambah satu lapisan `Organization` di atasnya.
  - Otorisasi di server sudah lewat satu fungsi pengecek cakupan, sehingga cakupan tenant bisa ditambahkan di satu tempat.
- **Mode demo** memakai database dan lingkungan terpisah, bukan tenant.

### Model domain inti

```
Brand (1 baris konfigurasi) ─┬─ Property/Branch ─┬─ UnitType (Ayung Pavilion) ─┬─ Unit (UBD-AYG-01)
                             │                   │                             └─ RatePlan ─ RateCalendar (harga per malam)
                             │                   ├─ Policy (pembatalan, deposit, check-in/out, pajak, service)
                             │                   └─ Staff ─ Role ─ Shift
                             ├─ Guest (profil, tag, consent, merge)
                             └─ Reservation ─┬─ StayNight (unit × tanggal, dengan EXCLUDE constraint)
                                       ├─ Folio ─ Charge / Payment / Refund
                                       ├─ Request/Task (permintaan tamu → tugas dengan SLA)
                                       ├─ Message (email/WA, riwayat komunikasi)
                                       └─ AuditEvent
Unit ─ HousekeepingTask / MaintenanceTicket / Block (perawatan, owner use)
Channel (Website, Direct, OTA, Agent) ─ ChannelMapping ─ SyncLog
```

### State machine reservasi

```
Draft/Hold(TTL) → Confirmed → InHouse → CheckedOut
       │              │           └→ (extend / move / early checkout)
       └→ Expired     ├→ Cancelled (+ biaya sesuai kebijakan)
                      └→ NoShow (+ biaya sesuai kebijakan)
```
Transisi hanya lewat service di server yang memvalidasi aturan (tanggal, housekeeping, peran, pembayaran) dan menulis `AuditEvent`.

---

## 4. Fitur per modul

### A. Booking engine publik
- Pencarian dengan **kalender ketersediaan & harga per malam** (tanggal yang tidak tersedia digelapkan, min-stay terlihat).
- Halaman vila: galeri, **peta**, ulasan (terverifikasi dari tamu yang benar-benar menginap), kebijakan pembatalan yang jelas sebelum bayar, fasilitas lengkap, dan "x unit tersisa" yang jujur.
- Hasil pencarian bisa diurutkan dan difilter (harga, kamar, fasilitas, destinasi), plus tampilan peta.
- Checkout ≤ 3 langkah: **hold unit 15 menit** dengan penghitung waktu, pilihan **deposit atau bayar penuh**, kode promo, **add-on pengalaman** (chef, spa, transfer bandara), pajak & service yang benar, mata uang tampilan (IDR/USD/AUD/EUR, tagihan tetap IDR).
- Konfirmasi: email + WhatsApp, PDF voucher, "tambahkan ke kalender".
- Enquiry yang benar-benar terkirim dan masuk ke inbox ops sebagai lead.
- SEO: JSON-LD `LodgingBusiness`/`Hotel`/`Offer`, Open Graph, sitemap, hreflang (demo sudah punya canonical & hreflang).

### B. Portal tamu (magic link, tanpa password)
- Lihat, **ubah tanggal**, atau **batalkan** sesuai kebijakan (biaya dihitung otomatis).
- **Pre-check-in online**: data tamu, unggah paspor/KTP (terenkripsi, retensi terbatas), ETA, detail penerbangan, permintaan transfer.
- Pesan add-on dan pengalaman sebelum atau selama menginap. Bayar sisa tagihan.
- Folio digital dan invoice. Minta ulasan setelah check-out.

### C. Front office (perbaikan langsung dari temuan)
- **Papan Hari Ini** realtime dengan tombol check-in/out langsung di baris (demo mengharuskan membuka setiap reservasi).
- **Late check-out / early check-in sebagai permintaan dengan persetujuan**, dengan deteksi konflik otomatis terhadap kedatangan berikutnya (memperbaiki B3) dan biaya opsional.
- **Ubah tanggal, pindah unit, dan upgrade tipe** dengan selisih harga dan persetujuan.
- Kartu registrasi digital dan tanda tangan di tablet.
- Folio: tambah biaya (minibar, spa, transfer), terima pembayaran, split bill, refund, dan **blokir check-out kalau masih ada saldo** (atau beri peringatan).
- Kalender: **drag-and-drop** untuk memindah dan mengubah tanggal, harga per malam di header, blok owner/perawatan.
- Daftar reservasi: sortir, paginasi, filter tersimpan di URL, ekspor, dan aksi massal.

### D. Housekeeping & maintenance (PWA mobile, bisa offline)
- Tugas dibuat otomatis dari check-out, pergantian tamu, dan permintaan. Bisa **ditugaskan ke petugas**, dengan prioritas berdasarkan jam kedatangan berikutnya.
- **Checklist inspeksi** per tipe vila, foto bukti, dan catatan barang tertinggal.
- **Tiket maintenance**: lapor (dengan foto) → tugaskan → selesai. Unit diblok otomatis dan dibuka kembali (demo tidak punya tombol menutup status Perawatan).
- Push notification ke HP petugas.

### E. Permintaan tamu → tugas (memperbaiki B4)
- Setiap permintaan khusus (dari booking, WA, atau staf) menjadi **tugas** dengan pemilik, tenggat/SLA, status, dan biaya opsional.
- Inbox terpadu email + WhatsApp per reservasi (riwayat komunikasi).

### F. Mesin tarif & revenue
- Rate plan (Flexible, Non-refundable, Breakfast incl.), musim, harga akhir pekan, min/max stay, closed-to-arrival, diskon lama menginap dan early-bird, kode promo.
- Pajak hotel dan service charge **dapat dikonfigurasi per cabang** (tarif persisnya diisi oleh klien atau akuntan, bukan kita yang menebak).
- Kebijakan pembatalan dan deposit per rate plan.
- Tahap lanjut: **saran harga dinamis** berbasis okupansi dan pace (keputusan tetap di manusia).

### G. Distribusi
- Tahap 1: **iCal impor/ekspor** per unit (Airbnb, Booking.com, VRBO) untuk mencegah overbooking.
- Tahap 2: integrasi **channel manager** (penyedia dipilih bersama) untuk sinkronisasi tarif dan ketersediaan dua arah.
- Atribusi sumber booking dan komisi per kanal.

### H. Laporan & insight
- Pemilih periode bebas, **perbandingan YoY**, okupansi/ADR/RevPAR per cabang, tipe, dan unit.
- **Pace & pickup**, lead time, lama menginap, campuran kanal, tingkat pembatalan dan no-show.
- Ekspor CSV/XLSX dan **laporan terjadwal** via email.
- **Laporan pemilik vila (owner statement)**: pendapatan, biaya, dan bagi hasil per unit. Ini umum di vila Bali yang dikelola atas nama pemilik.

### I. Tamu (CRM)
- Profil tamu: riwayat lintas cabang, preferensi, tanggal spesial, tag otomatis (VIP, tamu kembali).
- **Gabungkan duplikat**, kelola consent marketing, dan hapus/ekspor data atas permintaan (kepatuhan UU PDP).

### J. Tim, akses & pengaturan
- Login nyata, 2FA, SSO opsional.
- **RBAC granular** (izin per aksi, bukan per halaman) dan cakupan per cabang. Peran dapat dikustomisasi.
- Jadwal sif dan tukar sif.
- Konfigurasi per cabang: jam check-in/out, kebijakan, pajak, template pesan.
- Log audit yang bisa dicari dan diekspor.

### K. Mode demo (tetap ada, tapi lebih baik)
- Lingkungan demo terpisah (database sendiri) dengan **data seed yang bisa direset** dan **lompat waktu** (fitur bagus dari demo), tetapi berjalan di server yang sama dengan produk nyata. Dengan begitu demo selalu identik dengan produk.

---

## 5. Kualitas non-fungsional

- **Keamanan**: semua otorisasi di server (bukan hanya menyembunyikan menu), rate limit di lookup reservasi publik, enkripsi dokumen identitas, header keamanan, audit dependensi di CI.
- **Integritas data**: transaksi DB untuk setiap transisi status, idempotency key untuk webhook pembayaran, uji properti "tidak pernah ada dua reservasi aktif pada unit-malam yang sama".
- **Performa**: gambar responsif (AVIF/WebP), ISR untuk halaman vila dan destinasi, LCP < 2,0 dtk.
- **Aksesibilitas**: WCAG 2.2 AA. Pertahankan tabel alternatif untuk grafik seperti di demo.
- **i18n**: tidak boleh ada string hard-coded. CI gagal kalau ada kunci terjemahan yang hilang.
- **Testing**: E2E Playwright untuk alur kunci setiap peran (booking publik, check-in/out, pergantian tamu, no-show, batal, ubah tanggal).

---

## 6. Roadmap bertahap

Durasi sengaja tidak saya tulis karena bergantung pada ukuran tim dan keputusan di bagian 9. Setiap fase punya **kriteria selesai** yang bisa diuji.

### Fase 0: Fondasi
Repo, CI/CD, lingkungan staging, design system dan token, skema DB inti + migrasi, auth staf, RBAC dasar, seed data, i18n.
**Selesai bila:** staf bisa login dengan 2FA, peran dan cakupan cabang dipaksakan di server, dan CI menjalankan test + lint + cek i18n.

**Status (25 Nov 2026):** semua kriteria terpenuhi di kode dan sudah diuji end-to-end secara lokal terhadap Supabase (3 akun uji: Front Office, Housekeeping, Direktur; akun uji sudah dihapus). Di `be.attarahospitality.com` kode sudah ter-deploy, tetapi login baru berfungsi setelah `DATABASE_URL`, `BETTER_AUTH_URL`, dan `BETTER_AUTH_SECRET` diisi di environment variables Hostinger. Catatan: dari PC pengembang, setiap query ke Supabase butuh sekitar 300 ms, sehingga halaman staf terasa lambat secara lokal. Kecepatan di Hostinger belum diukur.

### Fase 1: MVP Booking Engine (bisa menerima uang sungguhan)
Inventaris (cabang, tipe, unit), tarif dasar + musim + min-stay, pencarian dan kalender ketersediaan, halaman vila, checkout dengan hold 15 menit, pembayaran Xendit (deposit/penuh, webhook, hold kedaluwarsa otomatis), email + WA konfirmasi, portal tamu (lihat/batal), situs publik ID/EN, SEO dasar.
**Selesai bila:** tamu bisa memesan dan membayar di staging dengan uang uji, uji konkurensi membuktikan tidak ada double-booking, dan pembatalan menghitung refund sesuai kebijakan.

**Status (25 Nov 2026), bagian pertama Fase 1 selesai:**
- Sudah dibangun dan diuji: tarif musiman + minimal menginap, pajak/service (0% sampai tarif resmi diisi), deposit 30% atau bayar penuh, hold 15 menit dengan percobaan ulang ke unit berikutnya, pencatatan pembayaran yang aman terhadap notifikasi ganda, pembatalan + perhitungan refund, pencarian, halaman vila dengan kalender ketersediaan, checkout, pembayaran simulasi, dan portal tamu (cari pesanan, lihat, batalkan). 68 tes otomatis lulus, dan alur tamu sudah diuji end-to-end di browser terhadap Supabase.
- Belum: Xendit sungguhan (kode sudah ada tetapi belum diuji karena belum ada kunci uji), email/WhatsApp konfirmasi (pesan sudah diantrekan di `notification_outbox` tetapi belum dikirim), pembayaran refund otomatis (refund baru dicatat), job pembersih hold kedaluwarsa (tidak wajib untuk kebenaran data), SEO JSON-LD/sitemap, dan foto vila asli.
- Temuan penting: koneksi transaction pooler Supabase (port 6543) membuat sebagian query macet di Next.js. Aplikasi harus memakai session pooler (port 5432).

### Fase 2: PMS Operasional (menyamai lalu melampaui demo)
Dasbor per peran, papan Hari Ini realtime, reservasi manual, **ubah tanggal/pindah/upgrade**, check-in/out dengan folio, kalender drag-and-drop, Status Vila, PWA housekeeping, tiket maintenance, permintaan → tugas, log audit.
**Selesai bila:** skenario demo (Kenji check-out → bersih → inspeksi → Sofia check-in) berjalan tanpa bug B1–B6, dan konflik late check-out terdeteksi otomatis.

**Status (25 Nov 2026), bagian pertama Fase 2 selesai:** beranda staf dengan angka hari ini, daftar reservasi (filter di URL, cari, paginasi, filter refund terutang), detail reservasi (harga per malam, transaksi, log aktivitas per detik), aksi check-in/check-out/no-show/batal/catat refund dengan alasan tertulis bila tidak tersedia, dan kalender tape chart per properti. Semua diuji di browser terhadap Supabase dengan akun manajer uji (sudah dihapus). Belum: ubah tanggal/pindah unit, drag-and-drop kalender, reservasi manual oleh staf, dan folio tambahan (minibar, dll.).

**Status (25 Nov 2026), bagian kedua Fase 2 selesai:** halaman Status Vila yang diurutkan menurut urgensi (kedatangan hari ini ke vila yang belum siap paling atas, lalu pergantian tamu di hari yang sama), alur kebersihan perlu dibersihkan → perlu inspeksi → siap dengan catatan siapa dan kapan, serta blokir perawatan per unit. Blokir ditolak bila bertabrakan dengan booking (kode booking disebutkan), tidak boleh tumpang tindih (dijaga constraint database), menyembunyikan unit dari pencarian dan hold, tampil di kalender, dan saat diselesaikan vila kembali ke "perlu inspeksi". Check-in ditolak bila vila diblokir atau belum siap; check-out otomatis menandai vila perlu dibersihkan. Peran Housekeeping hanya melihat Beranda dan Status Vila. 87 tes otomatis lulus; alur pergantian tamu diuji di browser terhadap Supabase dengan akun uji (sudah dihapus). Label "pergantian tamu hari ini" hanya dicakup tes otomatis, belum dilihat di browser. Belum: foto/checklist housekeeping, penugasan ke petugas, PWA offline, dan pembaruan realtime.

**Status (25 Nov 2026), bagian ketiga Fase 2 selesai: ubah tanggal & pindah vila.** Di halaman detail reservasi, staf melihat pratinjau dulu (tanggal dan vila baru, total lama/baru, selisih, sisa tagihan atau refund, harga per malam), lalu mengonfirmasi. Konfirmasi diperiksa ulang di server dan ditolak bila harga berubah sejak pratinjau. Aturan berikut sudah disetujui pemilik (25 Nov 2026):
- Malam yang sudah dipesan tetap memakai harga lama; malam tambahan memakai tarif saat ini.
- Reservasi terkonfirmasi: tanggal mulai hari ini, aturan minimal/maksimal menginap tetap berlaku, bisa pindah ke vila lain bertipe sama.
- Tamu in-house: hanya tanggal check-out yang bisa diubah (perpanjang atau perpendek, paling cepat besok), di vila yang sama. Pindah vila untuk tamu in-house belum didukung.
- Memperpendek masa inap yang sudah dibayar menghasilkan refund terutang sebesar kelebihan bayar, **tanpa biaya pembatalan otomatis**.
- Bentrok menyebutkan kode booking yang menghalangi dan menawarkan vila lain yang kosong; blokir perawatan dihormati.
- Pemberitahuan ke tamu masuk antrean email (pengiriman email belum aktif).
98 tes otomatis lulus; diuji di browser terhadap Supabase (pindah + perpanjang, perpanjang tamu in-house beserta bentrok dengan tamu berikutnya, perpendek → refund, Direktur tidak melihat formulir). Data uji sudah dihapus. Catatan kecepatan: dari PC pengembang, menyimpan perubahan butuh sekitar 10 detik karena latensi ke Supabase (~300 ms per query); di Hostinger belum diukur.

**Status (25 Nov 2026), bagian keempat Fase 2 selesai: reservasi manual oleh staf.** Halaman "Reservasi baru" (Front Office dan Manajer Cabang) untuk booking lewat telepon, WhatsApp, walk-in, atau agen: cek ketersediaan dan harga per tipe vila, data tamu (cukup email atau nomor telepon), pilih vila tertentu atau otomatis. Harga, minimal menginap, dan kebijakan deposit sama dengan situs web. Dua cara bayar:
- **Pembayaran sudah diterima** (tunai, transfer, EDC): minimal sebesar deposit, booking langsung terkonfirmasi.
- **Tautan pembayaran**: vila ditahan 1, 24, atau 48 jam; tautan tampil di halaman reservasi dengan tombol salin.
Di halaman reservasi kini ada "Catat pembayaran diterima" untuk hold (langsung terkonfirmasi, tautan yang masih terbuka ditutup) dan untuk sisa tagihan. Bila tautan yang sudah ditutup tetap dibayar, uangnya tercatat dan kelebihannya menjadi refund terutang. 106 tes otomatis lulus; diuji di browser terhadap Supabase (walk-in tunai tanpa email, tautan pembayaran lalu dibayar lewat simulator, deposit dicatat di meja depan). Data uji sudah dihapus. Belum: harga khusus/diskon oleh staf, konfirmasi tanpa deposit (garansi), dan pengiriman tautan otomatis lewat email/WhatsApp. Catatan: dari PC pengembang, membuat reservasi butuh sekitar 20–30 detik karena latensi ke Supabase.

**Status (25 Nov 2026), bagian kelima Fase 2 selesai: late check-out dengan deteksi konflik (memperbaiki B3).** Late check-out kini berupa permintaan dengan keputusan (catat, setujui dengan biaya opsional, tolak, batalkan), tercatat di log aktivitas. Batas paling lambat = jam tiba tamu berikutnya di vila yang sama (ETA tamu, atau jam check-in standar) dikurangi waktu siapkan vila. Persetujuan yang melewati batas ditolak oleh server, dan kartu menunjuk ke booking tamu berikutnya untuk dipindah ke vila lain. Status Vila menampilkan late check-out hari ini beserta konfliknya. Booking baru menghindari vila yang tamunya late check-out di hari kedatangan. Mengubah tanggal check-out membatalkan late check-out beserta biayanya; biaya yang sudah dibayar menjadi refund terutang. **Aturan yang sudah disetujui pemilik (25 Nov 2026):** waktu siapkan vila 120 menit (contoh, bisa diatur per properti); biaya late check-out diisi manual per permintaan dan dicatat sebagai biaya tambahan tanpa pajak/service terpisah. 114 tes otomatis lulus; diuji di browser terhadap Supabase (konflik terdeteksi dan persetujuan ditolak server, tamu berikutnya dipindah, lalu disetujui dengan biaya Rp 500.000). Data uji sudah dihapus. Belum: permintaan dari portal tamu dan tarif late check-out otomatis.

**Status (25 Nov 2026), bagian keenam Fase 2 selesai: early check-in.** Cerminan late check-out: catat, setujui dengan biaya opsional, tolak, atau batalkan. Paling cepat check-in = tamu sebelumnya di vila yang sama pulang (jam check-out standar, atau late check-out yang disetujui) ditambah waktu siapkan vila; persetujuan lebih awal dari itu ditolak server. Kedua aturan kini saling terhubung: batas late check-out memakai waktu tamu berikutnya butuh vila, yaitu early check-in yang disetujui, atau yang lebih lambat antara ETA tamu dan jam check-in standar. **Perubahan perilaku (disetujui pemilik, 25 Nov 2026):** ETA yang lebih pagi dari jam check-in (tanpa early check-in yang disetujui) tidak lagi mempersempit late check-out tamu sebelumnya, karena tamu itu baru berhak masuk pada jam check-in. Mengubah tanggal check-in membatalkan early check-in beserta biayanya. Status Vila menampilkan early check-in hari ini. 129 tes otomatis lulus; diuji di browser terhadap Supabase (konflik 10:00 ditolak server, 13:00 disetujui dengan biaya Rp 250.000, kartu late check-out tamu sebelumnya ikut menyesuaikan batasnya). Data uji sudah dihapus.

**Status (25 Nov 2026), bagian ketujuh Fase 2 selesai: diskon oleh staf.** Diskon atas harga malam, dalam persen atau nominal rupiah, selalu dengan alasan; service dan pajak dihitung dari harga setelah diskon. Batas per peran (disetujui pemilik): **Front Office maks. 10%, Manajer Cabang maks. 50%**, keduanya pengaturan per properti. Bisa diberikan saat membuat reservasi staf (deposit dan jumlah bayar ikut harga setelah diskon, dicek sebelum vila ditahan) dan pada reservasi terkonfirmasi/sedang menginap (beri, ubah, hapus; kelebihan bayar menjadi refund terutang). Diskon persen ikut menyesuaikan saat tanggal berubah; diskon nominal tetap. Tampil di halaman reservasi, halaman booking tamu, dan log aktivitas. 135 tes otomatis lulus; diuji di browser terhadap Supabase (15% ditolak untuk Front Office, 10% diterima dengan jumlah bayar otomatis Rp 11.700.000, lalu diubah menjadi Rp 500.000 dengan sisa tagihan Rp 800.000). Data uji sudah dihapus.
**Status (25 Nov 2026), bagian kedelapan Fase 2 selesai: konfirmasi tanpa deposit (garansi).** Front Office dan Manajer Cabang (disetujui pemilik) bisa mengonfirmasi booking sebelum deposit dibayar, selalu dengan alasan dan tenggat bayar (antara hari ini dan tanggal check-out, default hari check-in). Tersedia sebagai opsi bayar ketiga di formulir reservasi staf dan sebagai tombol "Konfirmasi tanpa deposit" pada reservasi yang masih ditahan (tautan pembayaran yang sudah dikirim tetap bisa dipakai tamu). **Aturan tenggat (disetujui pemilik):** lewat tenggat, booking ditandai, tidak batal otomatis. Halaman reservasi menampilkan banner (merah bila lewat tenggat) dan formulir "Ubah tenggat"; daftar reservasi memberi label "Deposit belum dibayar"/"Deposit lewat tenggat"; beranda staf menghitung deposit lewat tenggat; halaman booking tamu menampilkan jumlah dan tenggatnya. Penanda hilang begitu jumlah yang biasanya dibayar saat booking sudah diterima. 141 tes otomatis lulus; diuji di browser terhadap Supabase (booking lewat tenggat tampil di beranda dan daftar, tenggat diubah, hold dikonfirmasi tanpa deposit, reservasi staf baru dengan garansi, lalu pembayaran di meja depan menghapus penanda). Data uji sudah dihapus. Belum: pengingat otomatis ke tamu menjelang tenggat (menunggu pengiriman email/WhatsApp).
**Status (25 Nov 2026), bagian kesembilan Fase 2 selesai: kalender drag-and-drop.** Di Kalender, Front Office dan Manajer Cabang bisa menyeret pesanan terkonfirmasi ke tanggal lain atau vila lain yang bertipe sama, atau menarik ujung kanan bar untuk mengubah check-out (satu-satunya tarikan untuk tamu yang sedang menginap). Bayangan bar menunjukkan posisi baru (merah bila bertabrakan dengan pesanan lain atau perawatan). Tidak ada yang tersimpan saat dilepas: server membuat pratinjau dengan aturan yang sama seperti halaman reservasi (harga, selisih, sisa tagihan, refund, kode pesanan yang bentrok, dan vila kosong bertipe sama yang bisa dipilih), lalu staf mengonfirmasi. Pindah ke tipe vila lain ditolak dengan pesan. Klik biasa tetap membuka detail pesanan. Bekerja dengan mouse dan sentuhan. 147 tes otomatis lulus; diuji di browser terhadap Supabase (pindah vila, bentrok + vila alternatif, perpanjang tamu in-house +2 malam, tolak beda tipe). Data uji sudah dihapus. Belum: geser otomatis saat menyeret ke luar rentang tanggal yang tampil (untuk itu pakai formulir di halaman reservasi), dan pembaruan langsung bila staf lain mengubah kalender.
**Status (25 Nov 2026), bagian kesepuluh Fase 2 selesai: late check-out dari portal tamu.** **Keputusan pemilik (25 Nov 2026):** dari halaman booking, tamu hanya bisa meminta late check-out (early check-in dan ubah ETA/permintaan belum), dan pilihan jamnya dibatasi ke jam yang saat ini masih mungkin. Pilihan: setiap 30 menit setelah jam check-out standar, sampai batas tamu berikutnya (dikurangi waktu siapkan vila), paling lambat 18:00; pada hari kepulangan hanya jam yang belum lewat. Tidak ada info tentang tamu lain yang ditampilkan. Server memeriksa ulang jamnya saat dikirim. Staf tetap menyetujui (dengan biaya opsional) atau menolak; tamu melihat statusnya dan biayanya, bisa membatalkan permintaan yang masih menunggu, dan bisa meminta jam lain setelah ditolak. Di sisi staf: label "Diminta tamu lewat halaman booking", aktor "Tamu" di log, kotak "Permintaan menunggu keputusan" di beranda, serta filter dan label di daftar reservasi. Halaman tamu kini juga menampilkan sisa tagihan yang tidak punya tanggal jatuh tempo (misalnya biaya late check-out). 152 tes otomatis lulus; diuji di browser terhadap Supabase (tamu hanya ditawari 11:30 dan 12:00 karena ada tamu berikutnya, minta 12:00, staf menyetujui dengan biaya Rp 250.000, tamu melihat persetujuan dan sisa tagihan Rp 250.000). Data uji sudah dihapus. Belum: pemberitahuan email/WhatsApp ke tamu saat diputuskan dan ke staf saat ada permintaan baru (menunggu pengiriman pesan aktif); batas 18:00 masih tetap di kode, belum pengaturan per properti.
Temuan: session pooler Supabase di paket ini membatasi 15 koneksi total. Aplikasi kini memakai maksimal 3 koneksi per proses dan melepas koneksi yang menganggur setelah 20 detik.

### Fase 3: Revenue & distribusi
Rate plan lengkap, promo, add-on/pengalaman, iCal sync, laporan (periode, YoY, pace, ekspor), CRM tamu, pre-check-in online.
**Selesai bila:** satu unit tersinkron dua arah dengan Airbnb lewat iCal tanpa overbooking selama periode uji, dan laporan bisa diekspor.

**Status (25 Nov 2026), bagian pertama Fase 3 selesai: laporan dengan perbandingan tahun lalu dan ekspor CSV.** Menu "Laporan" untuk Direktur dan Manajer Cabang, periode bebas (maks. 1 tahun, dengan pilihan cepat bulan ini, bulan lalu, 30 hari ke depan, tahun ini), per properti. **Aturan yang disetujui pemilik (25 Nov 2026):** pendapatan kamar = harga malam setelah diskon, tanpa pajak dan service, diakui pada malam tamu menginap (diskon dibagi ke tiap malam sesuai tarifnya); biaya tambahan (late check-out/early check-in) dicatat terpisah dan tidak masuk ADR. Malam tersedia = vila aktif × malam, dikurangi malam perawatan. Isi: (1) kinerja kamar — okupansi, ADR, RevPAR, pendapatan kamar, malam terjual, biaya tambahan; per properti, tipe vila, dan vila; grafik per hari (≤ 62 hari) atau per bulan dengan tampilan tabel; (2) pemesanan masuk — jumlah, malam, nilai kamar, rata-rata jarak pesan ke tiba, lama menginap, diskon, porsi per sumber (hold yang tidak dibayar tidak dihitung); (3) pembatalan booking terkonfirmasi dan no-show — jumlah, tingkat, nilai kamar, dan uang yang tetap diterima setelah refund. Semua angka dibandingkan dengan tanggal yang sama tahun lalu. Setiap tabel bisa diunduh sebagai CSV (kode booking, tanpa nama tamu). 159 tes otomatis lulus; diuji di browser terhadap Supabase dengan data November 2026 vs 2025 (okupansi 3,3% vs 1,3%, ADR Rp 8.900.000, pembatalan 25%, no-show 33,3%, keempat CSV benar, CSV tanpa login dialihkan ke halaman masuk). Data uji sudah dihapus. Belum: pace/pickup ke depan (on-the-books per tanggal menginap), ekspor XLSX, laporan terjadwal via email, laporan pemilik vila, dan riwayat vila nonaktif (malam tersedia memakai status vila saat ini).
**Status (25 Nov 2026), bagian kedua Fase 3 selesai: pace / on the books.** Tab "Pace (on the books)" di Laporan, rentang 3, 6, atau 12 bulan ke depan, per bulan menginap: malam, okupansi, pendapatan kamar, dan ADR yang sudah dipesan hari ini; pickup 7 hari terakhir (booking baru dikurangi pembatalan); posisi pada titik yang sama tahun lalu (per tanggal yang sama setahun sebelumnya, untuk tanggal menginap setahun sebelumnya); dan hasil akhir tahun lalu untuk bulan-bulan itu. Booking dihitung on the books sejak tanggal dibuat sampai tanggal dibatalkan; hold yang tidak dibayar tidak pernah dihitung. Definisi ini standar industri dan tidak memerlukan keputusan baru dari pemilik. Ekspor CSV. 161 tes otomatis lulus; diuji di browser terhadap Supabase (Desember 2026: 4 malam Rp 26.000.000 vs 2 malam tahun lalu pada titik yang sama, pickup +2 malam Desember dan −2 malam Januari karena pembatalan, hasil akhir tahun lalu 4 malam; CSV benar). Data uji sudah dihapus. Keterbatasan: booking yang tanggalnya diubah dihitung pada tanggal dan harga saat ini (riwayat perubahan tanggal belum dipakai).
**Status (25 Nov 2026), bagian ketiga Fase 3 selesai: pre-check-in online.** **Keputusan pemilik (25 Nov 2026):** dari halaman booking, sampai hari kedatangan, tamu mengisi detail kedatangan (jam tiba, penerbangan, permintaan antar-jemput bandara), data setiap tamu dewasa (nama, kewarganegaraan, tanggal lahir, jenis dan nomor paspor/KTP), permintaan/preferensi, dan persetujuan aturan vila. Untuk dokumen identitas: **nomor saja, tanpa foto**. Nomor dienkripsi (AES-256-GCM), tidak pernah dikirim balik ke browser, tampil tersamar di meja depan kecuali dibuka (setiap kali dibuka tercatat di log), dan dihapus otomatis 30 hari setelah check-out, atau segera bila booking dibatalkan/kedaluwarsa/no-show. Penghapusan berjalan saat ada aktivitas staf (membuka halaman reservasi atau nomor dokumen), belum terjadwal. Tabel baru dengan RLS aktif dan tanpa akses publik. Aturan vila memakai teks umum sampai pemilik mengisi aturan per properti. Di sisi staf: kartu Pre-check-in di halaman reservasi dan label "Pre-check-in ✓" di daftar. 166 tes otomatis lulus; diuji di browser terhadap Supabase (validasi nomor dokumen, simpan, nomor terenkripsi di database, kartu staf, buka nomor tercatat di log, ubah tanpa mengetik ulang nomor). Data uji sudah dihapus. Belum: kunci enkripsi khusus GUEST_DATA_KEY (saat ini diturunkan dari BETTER_AUTH_SECRET), pengingat email untuk mengisi pre-check-in, ekspor data WNA untuk pelaporan APOA, dan unggah foto dokumen (sengaja tidak).
**Status (26 Nov 2026): notifikasi tamu lewat email (Resend) dan WhatsApp (Cloud API) siap, menunggu kunci.** **Keputusan pemilik (26 Nov 2026):** kirim lewat keduanya bila datanya ada; jenis pesan: konfirmasi/perubahan/pembatalan booking, keputusan late check-out/early check-in, pengingat pre-check-in (3 hari sebelum tiba) dan pengingat pembayaran (sehari sebelum jatuh tempo). Pesan diantrekan dalam transaksi yang sama, dikirim segera setelah respons dan oleh tugas terjadwal `/api/cron/tick` (juga melepas hold kedaluwarsa, menghapus nomor dokumen yang habis masa simpannya, dan membuat pengingat). Percobaan ulang otomatis sampai 5 kali; pesan yang belum terkirim dalam 48 jam dilewati. Staf melihat status setiap pesan di kartu "Pesan ke tamu". Langkah penyiapan akun, daftar template WhatsApp, dan cron ada di `docs/03-NOTIFIKASI.md`. 175 tes otomatis lulus; diuji di browser terhadap Supabase (booking dengan email + HP menghasilkan dua pesan menunggu; endpoint cron menolak tanpa CRON_SECRET). Data uji sudah dihapus. Menunggu pemilik: akun Resend + domain terverifikasi, akun WhatsApp Business + template disetujui, CRON_SECRET dan cron Hostinger.

### Fase 4: Skala & pembeda
Channel manager, owner portal dan statement, harga dinamis (saran), jadwal sif, evaluasi apakah layak menjadi SaaS multi-tenant, aplikasi tamu/upsell otomatis, asisten AI untuk balasan WA tamu (draf saja, staf yang mengirim).

---

## 7. Urutan kerja minggu pertama setelah plan disetujui

1. Putuskan poin-poin di bagian 9.
2. Scaffold proyek Next.js + TypeScript + PostgreSQL + Drizzle, dengan CI.
3. Tulis skema inti (`Property`, `UnitType`, `Unit`, `Reservation`, `StayNight` dengan exclusion constraint, `AuditEvent`) dan uji properti double-booking **sebelum** membangun UI.
4. Porting design tokens (warna, tipografi) agar setara kualitas demo.
5. Seed data contoh (boleh meniru skala demo: 5 cabang, 14 tipe, 44 unit) untuk mode demo.

---

## 8. Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Lingkup membengkak (PMS penuh itu besar) | Fase ketat dan MVP fokus menerima booking + pembayaran dulu |
| Integrasi OTA/channel manager lama dan berbiaya | Mulai dengan iCal. Channel manager di Fase 4 setelah ada klien nyata |
| Aturan pajak/kebijakan salah | Dibuat dapat dikonfigurasi, dengan nilai diisi dan disetujui klien |
| Data pribadi tamu (paspor) | Enkripsi, retensi terbatas, akses berbasis peran, log akses (UU PDP) |
| Kualitas desain turun dibanding demo | Design system sejak Fase 0, dengan review visual di setiap PR |

---

## 9. Keputusan terbuka (perlu jawaban Anda)

1. ~~**Model bisnis:** satu brand atau SaaS multi-tenant?~~ **Diputuskan: satu brand dulu** (lihat bagian 3).
2. ~~**Gateway pembayaran:** Xendit, Midtrans, atau Stripe?~~ **Diputuskan: Xendit**, dimulai dengan halaman pembayaran yang di-host Xendit (lihat bagian 3a).
3. ~~**Hosting & database:** di mana?~~ **Diputuskan:** Hostinger Cloud (`be.attarahospitality.com` untuk development) + Supabase (Singapura). Repo di `github.com/rk909090/booking-engine-RK`.
   - Perlu dicek saat deploy pertama: cara Hostinger menjalankan app Node.js (build, start command, versi Node) dan apakah koneksi dari Hostinger ke Supabase sebaiknya lewat connection pooler.
4. **Lingkup MVP:** apakah Fase 1 (booking + bayar) cukup untuk peluncuran pertama, atau PMS (Fase 2) harus ikut?
5. **Bahasa & mata uang:** cukup ID/EN dan IDR, atau perlu bahasa/mata uang tambahan sejak awal?
6. **Klien pertama / data nyata:** apakah sudah ada properti nyata untuk uji coba, atau kita mulai dengan data contoh?
