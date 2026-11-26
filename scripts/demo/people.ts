/*
 * Fictional guests for the demo. Emails use example.com (never delivered);
 * phone numbers only come from ranges reserved for fiction (UK Ofcom 07700
 * 900xxx, Australia ACMA 0491 570 1xx, US 555-01xx), so a WhatsApp key set
 * later cannot reach a real person.
 */

/** Deterministic random numbers (mulberry32), so every run builds the same demo. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const weighted = <T>(entries: ReadonlyArray<readonly [T, number]>): T => {
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let x = next() * total;
    for (const [v, w] of entries) if ((x -= w) < 0) return v;
    return entries[entries.length - 1][0];
  };
  return { next, int, pick, weighted, chance: (p: number) => next() < p };
}
export type Rng = ReturnType<typeof rng>;

const NAMES: Record<string, { first: string[]; last: string[]; weight: number }> = {
  AU: { weight: 20, first: ["Olivia", "Jack", "Charlotte", "Liam", "Mia", "Noah", "Isla", "Cooper", "Ruby", "Lachlan", "Grace", "Harry"], last: ["Smith", "Jones", "Williams", "Brown", "Wilson", "Taylor", "Mitchell", "Kelly", "Walsh", "Harris"] },
  ID: { weight: 15, first: ["Andi", "Budi", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hendra", "Indah", "Joko", "Kartika", "Lestari"], last: ["Wijaya", "Santoso", "Pratama", "Kusuma", "Halim", "Saputra", "Nugroho", "Hidayat", "Setiawan", "Gunawan"] },
  US: { weight: 10, first: ["Emma", "James", "Ava", "Michael", "Sophia", "Ethan", "Madison", "Daniel", "Abigail", "Ryan"], last: ["Johnson", "Miller", "Davis", "Garcia", "Anderson", "Thomas", "Moore", "Clark", "Lewis", "Young"] },
  GB: { weight: 10, first: ["Amelia", "Oliver", "Poppy", "George", "Freya", "Alfie", "Evie", "Archie", "Florence", "Henry"], last: ["Evans", "Roberts", "Wright", "Thompson", "Hughes", "Edwards", "Green", "Hall", "Wood", "Turner"] },
  DE: { weight: 8, first: ["Lena", "Lukas", "Hannah", "Felix", "Leonie", "Jonas", "Clara", "Maximilian", "Marie", "Paul"], last: ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Becker", "Hoffmann", "Wagner"] },
  FR: { weight: 7, first: ["Camille", "Louis", "Chloé", "Hugo", "Léa", "Jules", "Manon", "Arthur", "Inès", "Gabriel"], last: ["Martin", "Bernard", "Dubois", "Moreau", "Laurent", "Lefèvre", "Girard", "Roux"] },
  NL: { weight: 6, first: ["Sanne", "Daan", "Fleur", "Sem", "Lotte", "Thijs", "Eva", "Bram"], last: ["de Jong", "Jansen", "de Vries", "Bakker", "Visser", "Smit", "Meijer", "Mulder"] },
  SG: { weight: 7, first: ["Wei Ling", "Jun Jie", "Hui Min", "Wei Jie", "Shu Fen", "Kai Wen", "Priya", "Arjun"], last: ["Tan", "Lim", "Lee", "Ng", "Ong", "Wong", "Goh", "Chua"] },
  JP: { weight: 5, first: ["Yui", "Haruto", "Aoi", "Sota", "Hina", "Ren", "Sakura", "Riku"], last: ["Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto", "Nakamura"] },
  CN: { weight: 5, first: ["Li Na", "Wang Wei", "Zhang Min", "Liu Yang", "Chen Jing", "Yang Fan"], last: ["Wang", "Li", "Zhang", "Liu", "Chen", "Yang", "Huang", "Zhao"] },
  KR: { weight: 4, first: ["Ji-woo", "Min-jun", "Seo-yeon", "Ha-joon", "Ji-ho", "Yu-na"], last: ["Kim", "Lee", "Park", "Choi", "Jung", "Kang"] },
  IN: { weight: 3, first: ["Aarav", "Ananya", "Vihaan", "Diya", "Ishaan", "Saanvi"], last: ["Sharma", "Patel", "Singh", "Gupta", "Reddy", "Iyer"] },
};

export type DemoGuest = { fullName: string; email: string; phone: string | null; countryCode: string; locale: "id" | "en" };

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function guestFactory(r: Rng) {
  let n = 0;
  const countries = Object.entries(NAMES).map(([c, v]) => [c, v.weight] as const);
  return (country?: string): DemoGuest => {
    n++;
    const c = country ?? r.weighted(countries);
    const first = r.pick(NAMES[c].first);
    const last = r.pick(NAMES[c].last);
    const phone = c === "GB" ? `+447700900${String(r.int(0, 999)).padStart(3, "0")}` : c === "AU" ? `+61491570${r.int(110, 159)}` : c === "US" ? `+1202555${String(r.int(100, 199))}` : null;
    return { fullName: `${first} ${last}`, email: `demo-${slug(first)}.${slug(last)}.${n}@example.com`, phone, countryCode: c, locale: c === "ID" ? "id" : "en" };
  };
}

export const REQUESTS = [
  "Honeymoon — mohon dekorasi bunga di kamar",
  "Baby cot for our 1-year-old, please",
  "Arriving late, around 22:00",
  "Vegetarian breakfast for two",
  "Anniversary: a small cake on the first night would be lovely",
  "Mohon disiapkan extra bed",
  "Allergic to nuts",
  "Please arrange a quiet villa, we are working remotely",
];

export const GUEST_NOTES = [
  "Suka teh jahe saat tiba; minta kamar ekstra dingin.",
  "Selalu pesan pijat di hari kedua. Sangat ramah, sering memberi ulasan.",
  "Datang bersama dua anak kecil; siapkan baby cot dan pagar kolam.",
  "Perjalanan bisnis: perlu Wi-Fi stabil dan meja kerja.",
  "Bulan madu tahun lalu, kembali untuk ulang tahun pernikahan.",
];
