/**
 * Open camera directories — compact indexes for the CAMERAS tab.
 *
 * Only official, intentionally public cameras (road-traffic / road-weather
 * agencies publishing open data). Never unsecured private cameras.
 *
 * Most sources are fetched by the browser directly (they send CORS headers).
 * Two need the Worker:
 *   /cams/caltrans?d=1..12  Caltrans publishes ~12 MB of uncompressed JSON per
 *                           state; we shrink one district (≤2.5 MB) to ~150 KB.
 *   /cams/nz                NZTA's JSON only allows CORS for localhost.
 * Both are edge-cached for an hour (camera lists change rarely; the images
 * themselves are loaded straight from the agencies).
 *
 * Compact row: [id, name, lat, lon, imageUrl, liveVideoUrl|'' , direction|'']
 */

const UA = 'wrld-news/1.0 (+open camera index)';

export async function caltransDistrict(d) {
  const dd = String(d).padStart(2, '0');
  const r = await fetch(`https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${dd}.json`, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('caltrans ' + r.status);
  const j = await r.json();
  const out = [];
  for (const e of j.data || []) {
    const c = e.cctv;
    if (!c || c.inService !== 'true') continue;
    const l = c.location || {};
    const img = c.imageData?.static?.currentImageURL;
    const lat = +l.latitude, lon = +l.longitude;
    if (!img || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push([`ca${d}-${c.index}`, l.locationName || l.nearbyPlace || 'Caltrans camera', +lat.toFixed(5), +lon.toFixed(5),
      img, c.imageData?.streamingVideoURL || '', l.direction || '']);
  }
  return out;
}

export async function nzCameras() {
  const r = await fetch('https://www.journeys.nzta.govt.nz/assets/map-data-cache/cameras.json', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('nzta ' + r.status);
  const j = await r.json();
  const out = [];
  for (const f of j.features || []) {
    const p = f.properties || {};
    if (p.Offline || p.UnderMaintenance || !p.ImageUrl) continue;
    const lat = +p.Latitude, lon = +p.Longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push([`nz-${p.ExternalId ?? p.id}`, p.Name || 'NZTA camera', +lat.toFixed(5), +lon.toFixed(5), p.ImageUrl, '', p.Direction || '']);
  }
  return out;
}
