'use strict';

const R = 6371000; // Earth radius metres

function toRad(deg) { return deg * Math.PI / 180; }

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Minimum distance from point P to line segment AB (metres)
function distPointToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
  const ax = toRad(aLng) * Math.cos(toRad((aLat + pLat) / 2));
  const ay = toRad(aLat);
  const bx = toRad(bLng) * Math.cos(toRad((bLat + pLat) / 2));
  const by = toRad(bLat);
  const px = toRad(pLng) * Math.cos(toRad((pLat + pLat) / 2));
  const py = toRad(pLat);

  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return haversine(pLat, pLng, aLat, aLng);

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const closeLat = aLat + t * (bLat - aLat);
  const closeLng = aLng + t * (bLng - aLng);
  return haversine(pLat, pLng, closeLat, closeLng);
}

// Minimum distance from point to a polyline array [{lat,lng}]
function distToRoute(lat, lng, routePoints) {
  let min = Infinity;
  for (let i = 0; i < routePoints.length - 1; i++) {
    const d = distPointToSegment(
      lat, lng,
      routePoints[i].lat,   routePoints[i].lng,
      routePoints[i+1].lat, routePoints[i+1].lng
    );
    if (d < min) min = d;
  }
  return min;
}

// Fractional progress (0–1) along route for nearest point on route
function progressAlongRoute(lat, lng, routePoints, cumulativeDist) {
  let minDist = Infinity;
  let bestIdx = 0;
  let bestT = 0;

  for (let i = 0; i < routePoints.length - 1; i++) {
    const aLat = routePoints[i].lat,   aLng = routePoints[i].lng;
    const bLat = routePoints[i+1].lat, bLng = routePoints[i+1].lng;
    const ax = toRad(aLng) * Math.cos(toRad((aLat + lat) / 2));
    const ay = toRad(aLat);
    const bx = toRad(bLng) * Math.cos(toRad((bLat + lat) / 2));
    const by = toRad(bLat);
    const px = toRad(lng)  * Math.cos(toRad((lat  + lat) / 2));
    const py = toRad(lat);
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
    const cLat = aLat + t * (bLat - aLat);
    const cLng = aLng + t * (bLng - aLng);
    const d = haversine(lat, lng, cLat, cLng);
    if (d < minDist) { minDist = d; bestIdx = i; bestT = t; }
  }

  const total = cumulativeDist[cumulativeDist.length - 1];
  if (total === 0) return 0;
  const along = cumulativeDist[bestIdx] + bestT * (cumulativeDist[bestIdx+1] - cumulativeDist[bestIdx]);
  return along / total;
}

// Build cumulative distance array from routePoints [{lat,lng}]
function buildCumulativeDist(routePoints) {
  const d = [0];
  for (let i = 1; i < routePoints.length; i++) {
    d.push(d[i-1] + haversine(
      routePoints[i-1].lat, routePoints[i-1].lng,
      routePoints[i].lat,   routePoints[i].lng
    ));
  }
  return d;
}

module.exports = { haversine, distToRoute, progressAlongRoute, buildCumulativeDist };
