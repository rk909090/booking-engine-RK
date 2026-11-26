/*
 * A map of one point, from OpenStreetMap (no key needed), plus
 * a link that opens Google Maps for directions. Used on the villa pages and
 * in the settings preview.
 */

export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

export function MapEmbed({ lat, lng, title, className = "" }: { lat: number; lng: number; title: string; className?: string }) {
  const d = 0.008;
  const bbox = [lng - d, lat - d * 0.6, lng + d, lat + d * 0.6].map((n) => n.toFixed(5)).join(",");
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
  // OpenStreetMap's tile policy needs a referrer; only the site's origin is sent.
  return <iframe title={title} src={src} loading="lazy" referrerPolicy="strict-origin-when-cross-origin" className={className} />;
}
