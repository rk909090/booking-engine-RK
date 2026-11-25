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
