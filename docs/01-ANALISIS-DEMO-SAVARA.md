# Analisis Demo: SAVARA Private Villas (kalsara.id)

Diuji: 25 Nov 2026 lewat Google Chrome, di `https://savara-villa.demo.kalsara.id`.
Tanggal operasional demo: **Sabtu, 14 Nov 2026**. Semua perubahan saya sudah dikembalikan lewat "Atur ulang data demo".

> Dokumen ini hanya berisi hal yang **saya lihat atau coba sendiri**. Kalau sesuatu tidak saya uji, saya tulis begitu (lihat bagian 7).

---

## 1. Gambaran umum

Produknya punya dua sisi yang berbagi data yang sama:

| Sisi | URL | Untuk siapa |
|---|---|---|
| **Situs publik + booking engine** | `/`, `/id` | Tamu: cari vila, pesan, cek reservasi |
| **Dasbor operasional (PMS ringan)** | `/ops/*` | Staf: Direktur, Manajer Cabang, Front Office |
| **Pustaka komponen** | `/internal/components` | Tim pengembang (label "Internal · M0.1") |

Skala data contoh: 5 cabang (Ubud, Seminyak, Uluwatu, Canggu, Nusa Dua), 14 tipe vila, 44 unit, 69 reservasi, 17 staf.

**Teknologi yang terlihat:** Next.js (App Router, chunk Turbopack). Semua data demo disimpan **di browser** ("data contoh di peramban ini"). Tidak ada backend nyata, login sungguhan, atau pembayaran. Saya tidak memastikan mekanisme penyimpanannya: `localStorage` kosong, dan cookie tidak bisa saya baca dengan alat yang ada.

---

## 2. Login & peran

- `/login`: pilih peran (Direktur / Manajer Cabang / Front Office) dan cabang. Tidak ada kata sandi.
- Pengguna yang sudah masuk lalu membuka `/login` akan diarahkan ke `/ops`.
- Di dalam dasbor, menu akun bisa **mengganti peran** dan keluar.
- Chip "Demo · 14 Nov 2026" membuka **Alat Demo**: hari sebelumnya/berikutnya, lompat ke tanggal, kembalikan tanggal dasar, dan atur ulang data. Direktur tidak bisa memakai alat ini (hanya lihat).
- Ada tombol bahasa EN/ID.

### Matriks akses (terverifikasi)

| Menu | Direktur | Manajer Cabang | Front Office |
|---|---|---|---|
| Ikhtisar | ✅ (seluruh grup) | ✅ (1 cabang) | ✅ (1 cabang, fokus hari ini) |
| Kedatangan & Keberangkatan | ❌ | ✅ | ✅ |
| Reservasi | ✅ hanya lihat | ✅ | ✅ |
| Kalender | ✅ hanya lihat, filter cabang | ✅ + buat reservasi | ✅ + buat reservasi |
| Status Vila | ❌ | ✅ | ✅ |
| Tamu | ✅ | ✅ (cabang sendiri) | ✅ |
| Cabang | ✅ | ❌ (layar terkunci) | ❌ |
| Kinerja | ✅ | ✅ | ❌ (layar terkunci) |
| Tim | ✅ | ✅ | ❌ |
| Pengaturan | ✅ | ✅ | ✅ |
| Batalkan reservasi | ❌ | ✅ | ❌ ("Manajer Cabang dapat membatalkan; peran Anda tidak") |

Cakupan cabang dipaksakan: Manajer Ubud yang membuka reservasi Uluwatu (`SVR-24133`) melihat "Reservasi tidak ditemukan". Layar ini tidak membocorkan apakah reservasinya ada. Daftar Tamu untuk Manajer Ubud hanya berisi 14 tamu Ubud.

---

## 3. Fitur dasbor operasional

### 3.1 Ikhtisar
- **Direktur:** okupansi grup (terpesan, malam ini, 30 hari ke depan), ADR, RevPAR, pendapatan (nilai reservasi vs. yang sudah diakui), grafik pendapatan Okt 2026 sampai Feb 2027, kartu "Hari ini di seluruh grup", tabel perbandingan cabang, dan peringatan operasional (vila yang belum siap, diurutkan dari yang paling mendesak).
- **Manajer:** KPI cabang, "Prioritas hari ini" (pergantian tamu, tamu belum tiba, vila sedang perawatan, permintaan tamu), bar kesiapan vila, kedatangan, dan staf yang bertugas. Skor "Penilaian tamu 4.8/5" ditandai sebagai *ilustratif*.
- **Front Office:** jumlah kedatangan, keberangkatan, tamu menginap, permintaan terbuka, plus daftar permintaan tamu (ditandai *contoh ilustratif*).

### 3.2 Reservasi (daftar)
- Tab status dengan jumlah: Semua 69, Dikonfirmasi, Menginap, Ditahan sementara, Sudah check-out, Dibatalkan.
- Pencarian berdasarkan tamu, vila, unit, atau referensi. Tampilan kosong punya tombol "Hapus filter".
- Kode referensi menautkan ke halaman detail.
- **Tidak ada:** pengurutan kolom, paginasi (69 baris dalam satu halaman), ekspor, tombol "reservasi baru" (reservasi baru dibuat dari kalender), dan status filter di URL.

### 3.3 Detail reservasi (`/ops/reservations/SVR-xxxxx`)
Berisi data masa inap, rincian harga, status pembayaran (simulasi), panel "Vila hari ini", **Tindakan**, permintaan tamu, dan **log aktivitas** (siapa, apa, tanggal).

Aturan bisnis yang terbukti berjalan:
- **Check-in** baru bisa dilakukan pada tanggal kedatangan. Check-in **diblokir bila tamu sebelumnya masih di vila**, dengan pesan yang jelas ("Lakukan check-out atau pindahkan reservasi ini terlebih dahulu").
- Konfirmasi check-in menyebut status housekeeping ("vila sudah dibersihkan dan diinspeksi").
- **Check-out** lewat dialog konfirmasi. Setelahnya vila otomatis tercatat "Perlu dibersihkan" dan entri housekeeping dibuat.
- **No-show** baru bisa dicatat mulai H+1 dari tanggal kedatangan. Setelah tanggal kedatangan lewat, **Batalkan** dinonaktifkan dan pengguna diarahkan ke no-show.
- **Pindahkan ke vila lain:** hanya ke unit bertipe sama yang kosong selama seluruh masa inap. Harga tidak berubah.
- **Batalkan:** alasan opsional dan peringatan "tidak dapat dibatalkan".
- **Ubah masa inap:** dinonaktifkan ("milestone berikutnya").
- Setiap tombol yang dinonaktifkan **menjelaskan alasannya**. Ini praktik yang sangat baik.

### 3.4 Reservasi baru (dari kalender)
- Klik malam yang kosong di kalender membuka `/ops/reservations/new?villa=…&unit=…&checkIn=…&checkOut=…`.
- Isian: tipe vila, tanggal, dewasa/anak, unit (atau otomatis), nama, email/telepon (salah satu wajib), ETA, permintaan khusus.
- Validasi kapasitas berjalan ("Vila ini menampung hingga 2 tamu."), begitu juga validasi kontak.
- Pilihan **Konfirmasi** atau **Simpan sebagai ditahan sementara** (menahan vila 2 hari atau sampai check-in).
- Reservasi manual dimulai dengan status "Belum dibayar". Tetap bisa dikonfirmasi tanpa deposit.

### 3.5 Kalender
- Tape chart per unit, dikelompokkan per tipe vila. Tampilan 7 atau 14 hari, navigasi sebelum/hari ini/berikutnya, filter tipe vila (Direktur juga punya filter cabang).
- Bar berwarna per status (menginap, dikonfirmasi, sudah check-out) dan blok **Perawatan** bergaris.
- Klik bar membuka detail reservasi. Klik "+" membuat reservasi baru (Manajer/FO).
- **Tidak ada:** drag-and-drop untuk memindah atau mengubah tanggal, dan tampilan harga atau ketersediaan per malam.

### 3.6 Status Vila (housekeeping)
- Bar kesiapan: Kemungkinan siap / Terisi / Perlu dibersihkan / Perlu inspeksi / Perawatan.
- Membedakan status yang **"Tercatat"** (dicatat staf) dan **"Diperkirakan"** (diturunkan dari jadwal).
- Alurnya terbukti: *Perlu dibersihkan → Catat pembersihan selesai → Perlu inspeksi → Catat inspeksi selesai → Siap*, dengan riwayat "Catatan housekeeping (n)".
- **Tidak ada:** tombol untuk menutup status Perawatan, penugasan ke petugas, checklist, atau foto.

### 3.7 Kedatangan & Keberangkatan
Daftar kedatangan (ETA, kesiapan vila), "Belum tiba" (calon no-show), keberangkatan, dan tamu yang tetap menginap. Tidak ada tombol check-in/out langsung di daftar, jadi staf harus membuka setiap reservasi.

### 3.8 Tamu
Tabel tamu: tag (VIP, Tamu kembali, Inap panjang, Keluarga, Bulan madu), negara, inap terakhir (menautkan ke reservasi), jumlah masa inap, nilai, dan status. **Tidak ada** halaman profil tamu atau pencarian.

### 3.9 Cabang (Direktur)
Kartu per cabang: lokasi, jumlah vila, tahun buka, okupansi, ADR, RevPAR, pendapatan, dan tautan ke halaman publik. Tidak ada drill-down per cabang.

### 3.10 Kinerja
Grafik okupansi bulanan per cabang dengan tabel aksesibel di bawahnya, ADR, campuran sumber pemesanan (Tamu kembali / Langsung / Situs web / Agen perjalanan), dan "riwayat musiman ilustratif" Mei–Okt yang diberi label jelas sebagai angka rekaan. Tidak ada pemilih periode, perbandingan YoY, atau ekspor.

### 3.11 Tim & Pengaturan
- **Tim:** kartu staf (nama, jabatan, cabang, sif Pagi/Siang/Malam/Libur tugas). Hanya untuk dilihat.
- **Pengaturan:** profil persona dan daftar menu yang bisa dibuka peran tersebut.

### 3.12 Daftar "Direncanakan untuk milestone berikutnya" (roadmap mereka sendiri)
- Reservasi: ubah tanggal, paket tarif dan deposit, detail dengan riwayat komunikasi tamu
- Tamu: profil, preferensi dan acara khusus, kontak dengan persetujuan/privasi, gabungkan duplikat antarcabang
- Kinerja: pilih periode dan YoY, laporan lead time dan lama menginap, ekspor ke spreadsheet
- Tim: daftar jaga dan tukar sif, peran dan akses per cabang
- Pengaturan: login sungguhan, preferensi notifikasi, konfigurasi per cabang
- Kedatangan: kartu registrasi, detail penerbangan dan penugasan transfer
- Status Vila: pembaruan dari tim teknik, penugasan tugas, checklist inspeksi

---

## 4. Fitur situs publik (booking engine)

| Halaman | Isi | Catatan |
|---|---|---|
| Beranda | Hero, widget pencarian (destinasi, tanggal, dewasa 1–12, anak 0–12), kisah brand, 5 destinasi, vila unggulan, pengalaman | Bahasa EN (default) dan ID (`/id`) |
| `/destinations/[slug]` | Narasi lokasi, alasan memilih, jarak ke bandara, daftar tipe vila | Tidak ada peta (yang saya cek: Ubud) |
| `/villas` | 14 tipe vila, filter destinasi dan jumlah kamar | Tidak ada filter harga atau fasilitas, dan tidak bisa diurutkan |
| `/villas/[slug]` | Breadcrumb, galeri ("foto representatif"), kamar/tamu/luas/jumlah unit, deskripsi, highlight, fasilitas termasuk, widget harga dengan rincian per malam, Enquire, vila lain di destinasi yang sama | **Tidak ada** kalender ketersediaan, ulasan, peta, atau kebijakan pembatalan |
| `/availability` | Hasil per tipe vila: total harga, harga per malam, "x of y villas open" | Tarif **datar** setiap malam (tanpa musim atau akhir pekan) |
| `/checkout` (3 langkah) | 1) Data diri (nama, email, telepon, negara, tamu, ETA, permintaan, centang persetujuan demo) → 2) Pembayaran simulasi (setujui/tolak) → 3) Konfirmasi dengan ref `SVR-xxxxx` | Hanya bayar penuh. Tidak ada deposit, kode promo, add-on, atau pajak/service ("tidak dikonfigurasi") |
| `/reservation` | Cari dengan referensi + email. Email yang salah ditolak | Hanya baca: tidak bisa ubah, batal, atau menambah permintaan |
| `/enquire` | Formulir permintaan penawaran | **Belum tersambung** ("Sending opens in a later release") |
| `/experiences` | 6+ pengalaman (chef pribadi, melukat, surfing, spa, dll.) | Hanya informasi, tidak bisa dipesan atau ditambahkan ke booking |
| `/about` | Kisah brand | Tidak saya baca rinci |

**Integrasi publik ↔ ops (terverifikasi):** booking dari situs (SVR-24171) langsung muncul di dasbor dengan sumber "Situs web", **unit dipilih otomatis** (Ayung 01), pembayaran "Lunas (simulasi)", dan log "Tamu situs web".

**SEO (beranda):** ada meta description, canonical, dan 3 hreflang. `noindex` (wajar untuk demo). **Tidak ada** tag Open Graph dan **tidak ada** structured data JSON-LD (mis. `LodgingBusiness`/`Hotel`).

---

## 5. Kekuatan yang patut ditiru (standar minimum kita)

1. **Desain dan copywriting premium**: tenang, konsisten, bilingual, dengan design system terdokumentasi.
2. **Guardrail aturan bisnis**: tidak ada double check-in, pembatalan dan no-show berbasis tanggal, kapasitas, dan setiap tombol nonaktif menjelaskan alasannya.
3. **Satu sumber kebenaran**: booking web langsung masuk ke ops, check-out memicu housekeeping, dan semuanya tercatat di log aktivitas.
4. **RBAC + cakupan cabang** yang jelas dan tidak membocorkan data lintas cabang.
5. **Kejujuran data**: angka ilustratif selalu diberi label.
6. **Aksesibilitas**: "Lewati ke konten", tabel alternatif untuk setiap grafik, label form yang benar.
7. **Alat Demo** (lompat waktu dan reset), sangat bagus untuk penjualan dan QA.

---

## 6. Bug & kekurangan yang saya temukan (dengan bukti)

| # | Temuan | Cara reproduksi | Dampak |
|---|---|---|---|
| B1 | **Kilatan state usang saat hidrasi.** Detail reservasi sempat menampilkan data awal ("Kenji masih check-in", tombol Check-in nonaktif) sekitar 1–2 detik sebelum state browser dimuat | Check-out SVR-24102 → buka SVR-24103 | Staf bisa salah membaca status |
| B2 | **Daftar kedatangan tidak sinkron setelah check-in.** Sofia (sudah check-in) muncul sekaligus di "Kedatangan" dan "Tetap menginap". KPI tetap "2 kedatangan · 1 dari 2 siap". Kenji yang sudah check-out tetap tampil di "Keberangkatan" tanpa penanda | Check-out Kenji → check-in Sofia → buka Ikhtisar FO atau `/ops/arrivals` | Papan hari ini tidak bisa dipercaya |
| B3 | **"Late check-out requested" hanya teks bebas.** Tidak ada peringatan konflik meski tamu berikutnya tiba 15:00 di vila yang sama | SVR-24102 vs SVR-24103 | Risiko operasional nyata |
| B4 | **Permintaan khusus tidak menjadi tugas.** "Anniversary: flowers and cake" tampil, tetapi "0 permintaan" | SVR-24103 | Permintaan tamu bisa terlewat |
| B5 | **Pesan validasi menyesatkan.** Saat tamu melebihi kapasitas, field tanggal ikut merah dan ringkasan menulis "Pilih tanggal untuk melihat harga" | Reservasi baru, isi 6 dewasa di Ayung | Membingungkan |
| B6 | Log booking baru berbunyi "Ditahan sementara menjadi Dikonfirmasi", padahal staf langsung memilih Konfirmasi. Detail internal bocor, dan stempel waktu di log hanya berisi tanggal tanpa jam | SVR-24170/24171 | Audit kurang presisi |
| B7 | **Bahasa campur:** "Branches tidak tersedia untuk Branch Manager", "Performance tidak tersedia untuk Front Office". Judul tab "Reservation" atau "Overview · SAVARA Private Villas" muncul saat UI berbahasa ID | Buka halaman terkunci, ganti peran | Kurang rapi |
| B8 | "1 bedrooms" di dropdown Enquire | `/enquire` | Typo |
| B9 | Jumlah di tab status tidak ikut berubah saat mencari | Cari "Okafor" | Minor |

**Kekurangan fungsional (bukan bug, tetapi belum ada):** login, database, dan pembayaran sungguhan; email/WhatsApp; manajemen tarif (musim, minimum menginap, promo, paket tarif, pajak/service); deposit, sisa tagihan, folio, refund, dan kebijakan pembatalan; channel manager/OTA/iCal; portal tamu (ubah/batal, pre-check-in, add-on); ubah tanggal reservasi; tugas housekeeping dan maintenance; laporan periode dan ekspor; profil tamu (CRM); jadwal sif; **tidak ada hold inventaris selama checkout** ("nothing was reserved" saat pembayaran gagal), sehingga di sistem nyata dua tamu bisa membayar untuk unit terakhir yang sama.

---

## 7. Batas pengujian (jujur)

- Diuji di desktop (lebar ±1536 px). **Tampilan mobile tidak saya uji**, walau ada tombol "Buka menu dasbor" yang mengindikasikan menu mobile.
- Peran Manajer dan FO hanya saya uji di **cabang Ubud**.
- UI ops dalam bahasa EN tidak saya telusuri penuh. Situs publik saya uji dalam EN, dan beranda ID saya lihat sekilas.
- Tampilan kalender 14 hari, halaman `/about`, dan destinasi selain Ubud tidak saya buka rinci.
- Saya tidak menguji performa (Lighthouse/Core Web Vitals) maupun keamanan di luar uji akses peran lewat URL langsung.
