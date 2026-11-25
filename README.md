# Booking Engine RK

Booking engine dan PMS ringan untuk vila (satu brand, multi-cabang).

- Analisis demo acuan: [docs/01-ANALISIS-DEMO-SAVARA.md](docs/01-ANALISIS-DEMO-SAVARA.md)
- Plan pengembangan: [docs/02-PLAN-PENGEMBANGAN.md](docs/02-PLAN-PENGEMBANGAN.md)

## Infrastruktur

| Komponen | Pilihan |
|---|---|
| Hosting (development) | Hostinger Cloud: `https://be.attarahospitality.com` |
| Database | Supabase (PostgreSQL) |
| Pembayaran | Xendit |
| Repo | `github.com/rk909090/booking-engine-RK` |

Rahasia (kunci API, password database) **tidak** disimpan di repo. Simpan di environment variables Hostinger dan `.env.local` lokal.

## Database

Status Supabase (25 Nov 2026): kedua migrasi dan data contoh (2 properti, 4 tipe vila, 9 unit) sudah dijalankan lewat SQL Editor. Constraint anti double-booking sudah diuji langsung di Supabase.

Menyiapkan koneksi lokal:

1. Salin `.env.example` ke `.env.local`, lalu ganti `PASSWORD_DB_ANDA` di dua tempat.
2. `npm run db:check`: cek koneksi tanpa mengubah apa pun.
3. `npm run db:migrate`: jalankan migrasi baru (yang sudah ada otomatis dilewati).

Tanpa koneksi langsung, `npm run db:bootstrap-sql > bootstrap.sql` membuat satu file SQL (migrasi + catatan migrasi Drizzle + data contoh) untuk ditempel di SQL Editor database **kosong**.
