/**
 * Multilateration Map SPA
 * - MapLibre GL with Dynamic Basemap Switcher (CARTO Dark/Light Vector, Google Roadmap/Satellite Raster)
 * - Permanent IndexedDB Tile Cache (No Expiry, Zero Re-requests for Cached Tiles)
 * - LocalStorage Persistence for Beacons & Selected Basemap
 * - Interactive Click-to-Drop Beacons directly on Map
 * - Draggable Beacon Markers with Real-time Circle Projection
 * - Inline Editable Geohash and Radius in Compact Sidepanel List
 * - Pure Vanilla Geohash Encoding, Decoding, and Spherical Geodesic Projection
 */

// 1. IndexedDB Tile Cache (Permanent Storage, No Expiry)
const DB_NAME = 'carto-tiles-cache';
const DB_VERSION = 1;
const STORE_NAME = 'tiles';

function openTileDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedTile(db, key) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function setCachedTile(db, key, buffer) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// 2. Basemap Style Definitions (No API Key Required)
const BASEMAP_STYLES = {
  'carto-dark': 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  'carto-light': 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  'google-roadmap': {
    version: 8,
    sources: {
      'google-roadmap-source': {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'
        ],
        tileSize: 256,
        attribution: '© Google Maps'
      }
    },
    layers: [
      {
        id: 'google-roadmap-layer',
        type: 'raster',
        source: 'google-roadmap-source',
        minzoom: 0,
        maxzoom: 22
      }
    ]
  },
  'google-satellite': {
    version: 8,
    sources: {
      'google-satellite-source': {
        type: 'raster',
        tiles: [
          'https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
          'https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
        ],
        tileSize: 256,
        attribution: '© Google Maps Satellite'
      }
    },
    layers: [
      {
        id: 'google-satellite-layer',
        type: 'raster',
        source: 'google-satellite-source',
        minzoom: 0,
        maxzoom: 22
      }
    ]
  }
};

// 3. Geohash Base32 Encoder & Decoder (Pure Vanilla JS)
const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat, lng, precision = 7) {
  let isLng = true;
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;

  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch |= (1 << (4 - bit));
        lngMin = mid;
      } else {
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch |= (1 << (4 - bit));
        latMin = mid;
      } else {
        latMax = mid;
      }
    }
    isLng = !isLng;
    bit++;

    if (bit === 5) {
      hash += B32[ch];
      bit = 0;
      ch = 0;
    }
  }

  return hash;
}

function decodeGeohash(geohash) {
  const hash = geohash.toLowerCase().trim();
  if (!hash) throw new Error('Geohash cannot be empty');

  let isLng = true;
  let latMin = -90, latMax = 90;
  let lngMin = -180, lngMax = 180;

  for (let i = 0; i < hash.length; i++) {
    const idx = B32.indexOf(hash[i]);
    if (idx === -1) throw new Error(`Invalid geohash character: "${hash[i]}"`);

    for (let bit = 4; bit >= 0; bit--) {
      const mask = 1 << bit;
      if (isLng) {
        const mid = (lngMin + lngMax) / 2;
        if ((idx & mask) !== 0) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if ((idx & mask) !== 0) latMin = mid;
        else latMax = mid;
      }
      isLng = !isLng;
    }
  }

  return {
    lat: (latMin + latMax) / 2,
    lng: (lngMin + lngMax) / 2,
    latMin, latMax, lngMin, lngMax
  };
}

// 4. Spherical Geodesic Circle Generator (WGS84 Model)
function createGeodesicCircle(centerLng, centerLat, radiusMeters, steps = 64) {
  const R = 6378137;
  const d = radiusMeters / R;
  const latRad = (centerLat * Math.PI) / 180;
  const lngRad = (centerLng * Math.PI) / 180;
  const coordinates = [];

  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const pLat = Math.asin(
      Math.sin(latRad) * Math.cos(d) +
      Math.cos(latRad) * Math.sin(d) * Math.cos(bearing)
    );
    const pLng = lngRad + Math.atan2(
      Math.sin(bearing) * Math.sin(d) * Math.cos(latRad),
      Math.cos(d) - Math.sin(latRad) * Math.sin(pLat)
    );
    coordinates.push([(pLng * 180) / Math.PI, (pLat * 180) / Math.PI]);
  }

  return coordinates;
}

// 5. Color Palette for Multilateration Circles
const PALETTE = [
  '#00f0ff', // Cyan
  '#ff007f', // Rose
  '#ffe600', // Yellow
  '#00ff66', // Lime
  '#a855f7', // Violet
  '#ff7800', // Amber
  '#38bdf8', // Sky
  '#ec4899'  // Fuchsia
];

// 6. Application State & Storage
const STORAGE_KEY_BEACONS = 'multilateration-beacons';
const STORAGE_KEY_BASEMAP = 'multilateration-basemap';

function loadBeaconsFromStorage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_BEACONS);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveBeaconsToStorage(items) {
  try {
    localStorage.setItem(STORAGE_KEY_BEACONS, JSON.stringify(items));
  } catch {}
}

const beacons = loadBeaconsFromStorage();
const markersMap = new Map(); // beacon.id -> maplibregl.Marker
let currentBasemap = localStorage.getItem(STORAGE_KEY_BASEMAP) || 'carto-dark';
let dbInstance = null;
let mapInstance = null;

// DOM Elements
const main = document.querySelector('main');
const form = document.querySelector('form');
const list = document.querySelector('ol');
const output = document.querySelector('output');
const basemapSelect = document.querySelector('select[name="basemap"]');
const itemTemplate = document.querySelector('template');

// Helper to format tile response according to MapLibre requested type (ArrayBuffer or ImageBitmap)
async function formatTileResponse(buffer, type) {
  if (type === 'image' && typeof createImageBitmap === 'function') {
    try {
      const blob = new Blob([buffer]);
      const bitmap = await createImageBitmap(blob);
      return { data: bitmap };
    } catch {
      return { data: buffer };
    }
  }
  return { data: buffer };
}

// 7. Initialize IndexedDB Protocol Handler (No Expiry, Zero Re-requests for Cached Tiles)
async function initCacheAndProtocol() {
  dbInstance = await openTileDB();

  maplibregl.addProtocol('cachetile', (params, abortController) => {
    const targetUrl = params.url.replace('cachetile://', 'https://');

    return new Promise((resolve, reject) => {
      // Step 1: Cache lookup
      getCachedTile(dbInstance, targetUrl).then(async (cached) => {
        if (cached) {
          // Serve directly from IndexedDB without any network re-request
          try {
            const res = await formatTileResponse(cached, params.type);
            resolve(res);
          } catch (err) {
            reject(err);
          }
        } else {
          // Step 2: Fetch once from network, permanently store in IndexedDB
          fetch(targetUrl, { signal: abortController.signal })
            .then(res => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.arrayBuffer();
            })
            .then(async (buffer) => {
              if (dbInstance) setCachedTile(dbInstance, targetUrl, buffer);
              const res = await formatTileResponse(buffer, params.type);
              resolve(res);
            })
            .catch(reject);
        }
      }).catch(reject);
    });
  });
}

// 8. Draggable MapLibre Marker Management
function createMarkerForBeacon(beacon) {
  if (!mapInstance) return;

  // Remove existing if any
  if (markersMap.has(beacon.id)) {
    markersMap.get(beacon.id).remove();
  }

  const marker = new maplibregl.Marker({
    draggable: true,
    color: beacon.color
  })
    .setLngLat([beacon.lng, beacon.lat])
    .addTo(mapInstance);

  // Real-time drag updates circle polygon and live geohash
  marker.on('drag', () => {
    const lngLat = marker.getLngLat();
    beacon.lng = lngLat.lng;
    beacon.lat = lngLat.lat;
    beacon.geohash = encodeGeohash(lngLat.lat, lngLat.lng, 7);
    syncMapLayers();

    // Live update geohash input in sidepanel list item
    const input = list.querySelector(`li[data-id="${beacon.id}"] input[name="geohash"]`);
    if (input) {
      input.value = beacon.geohash;
      input.removeAttribute('aria-invalid');
    }
  });

  // Finalize drag: re-encode geohash, update list input and localStorage
  marker.on('dragend', () => {
    const lngLat = marker.getLngLat();
    beacon.lng = lngLat.lng;
    beacon.lat = lngLat.lat;
    beacon.geohash = encodeGeohash(lngLat.lat, lngLat.lng, 7);
    saveBeaconsToStorage(beacons);
    syncMapLayers();

    // Update input in list without remounting
    const input = list.querySelector(`li[data-id="${beacon.id}"] input[name="geohash"]`);
    if (input) {
      input.value = beacon.geohash;
      input.removeAttribute('aria-invalid');
    }
  });

  markersMap.set(beacon.id, marker);
}

function removeMarkerForBeacon(id) {
  const marker = markersMap.get(id);
  if (marker) {
    marker.remove();
    markersMap.delete(id);
  }
}

// 9. Map Layers Setup
function ensureMapLayers() {
  if (!mapInstance) return;

  if (!mapInstance.getSource('beacons')) {
    mapInstance.addSource('beacons', {
      type: 'geojson',
      data: getBeaconsGeoJSON()
    });
  }

  // Layer 1: Translucent circle fill
  if (!mapInstance.getLayer('beacons-fill')) {
    mapInstance.addLayer({
      id: 'beacons-fill',
      type: 'fill',
      source: 'beacons',
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.22
      }
    });
  }

  // Layer 2: Circle boundary stroke
  if (!mapInstance.getLayer('beacons-stroke')) {
    mapInstance.addLayer({
      id: 'beacons-stroke',
      type: 'line',
      source: 'beacons',
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2.5,
        'line-opacity': 0.95
      }
    });
  }

  // Preview source for live form input
  if (!mapInstance.getSource('preview')) {
    mapInstance.addSource('preview', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }

  // Preview layer: Translucent fill
  if (!mapInstance.getLayer('preview-fill')) {
    mapInstance.addLayer({
      id: 'preview-fill',
      type: 'fill',
      source: 'preview',
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color': '#38bdf8',
        'fill-opacity': 0.16
      }
    });
  }

  // Preview layer: Dashed boundary stroke
  if (!mapInstance.getLayer('preview-stroke')) {
    mapInstance.addLayer({
      id: 'preview-stroke',
      type: 'line',
      source: 'preview',
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'line-color': '#38bdf8',
        'line-width': 2.5,
        'line-dasharray': [3, 2]
      }
    });
  }

  // Preview layer: Center point dot
  if (!mapInstance.getLayer('preview-center')) {
    mapInstance.addLayer({
      id: 'preview-center',
      type: 'circle',
      source: 'preview',
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-color': '#38bdf8',
        'circle-radius': 4.5,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff'
      }
    });
  }
}

// 10. Initialize Map
async function initMap() {
  await initCacheAndProtocol();

  if (basemapSelect) {
    basemapSelect.value = currentBasemap;
    basemapSelect.addEventListener('change', (e) => {
      switchBasemap(e.target.value);
    });
  }

  mapInstance = new maplibregl.Map({
    container: main,
    style: BASEMAP_STYLES[currentBasemap] || BASEMAP_STYLES['carto-dark'],
    center: [0, 20],
    zoom: 2,
    attributionControl: false,
    transformRequest: (url, resourceType) => {
      if (resourceType === 'Tile' && url.startsWith('https://')) {
        return {
          url: url.replace(/^https:\/\//, 'cachetile://')
        };
      }
      return { url };
    }
  });

  mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  // Handle style loads and data updates (including when switching basemaps)
  mapInstance.on('styledata', () => {
    if (mapInstance.isStyleLoaded()) {
      ensureMapLayers();
      syncMapLayers();
      // Re-verify all beacon markers are attached
      beacons.forEach(b => {
        if (!markersMap.has(b.id)) {
          createMarkerForBeacon(b);
        }
      });
    }
  });

  // Interactively drop beacon point via map click
  mapInstance.on('click', (e) => {
    // If the click landed on an existing marker, ignore map click
    if (e.originalEvent?.target?.closest('.maplibregl-marker')) {
      return;
    }
    // If event was default-prevented (e.g. clicking controls), ignore
    if (e.originalEvent?.defaultPrevented) return;

    const lat = e.lngLat.lat;
    const lng = e.lngLat.lng;
    const geohash = encodeGeohash(lat, lng, 7);
    const radiusInput = form.elements['radius'];
    const radius = Number(radiusInput.value) > 0 ? Number(radiusInput.value) : 5000;

    addBeacon(geohash, radius, { lat, lng });
  });

  // Setup markers for restored beacons
  mapInstance.on('load', () => {
    beacons.forEach(b => createMarkerForBeacon(b));
    if (beacons.length > 0) {
      fitBoundsToBeacons();
    }
  });

  // Initial view: geolocation if no beacons exist
  if (beacons.length === 0 && 'geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        if (beacons.length === 0) {
          mapInstance.flyTo({
            center: [pos.coords.longitude, pos.coords.latitude],
            zoom: 12,
            duration: 1500
          });
        }
      },
      () => {/* User denied or unavailable */}
    );
  }
}

// 11. Switch Basemap Dynamically
function switchBasemap(styleKey) {
  if (!BASEMAP_STYLES[styleKey]) return;
  currentBasemap = styleKey;
  try {
    localStorage.setItem(STORAGE_KEY_BASEMAP, styleKey);
  } catch {}

  mapInstance.setStyle(BASEMAP_STYLES[styleKey]);
}

// 12. GeoJSON Generation & Layer Sync
function getBeaconsGeoJSON() {
  const features = [];

  for (const b of beacons) {
    const coords = createGeodesicCircle(b.lng, b.lat, b.radius);
    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [coords]
      },
      properties: {
        id: b.id,
        color: b.color,
        geohash: b.geohash,
        radius: b.radius,
        lat: b.lat,
        lng: b.lng
      }
    });
  }

  return {
    type: 'FeatureCollection',
    features
  };
}

function syncMapLayers() {
  if (!mapInstance) return;
  const source = mapInstance.getSource('beacons');
  if (source) {
    source.setData(getBeaconsGeoJSON());
  }
}

function fitBoundsToBeacons() {
  if (!mapInstance || beacons.length === 0) return;

  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const b of beacons) {
    const coords = createGeodesicCircle(b.lng, b.lat, b.radius);
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  if (isFinite(minLng) && isFinite(maxLng)) {
    mapInstance.fitBounds(
      [[minLng, minLat], [maxLng, maxLat]],
      { padding: 80, maxZoom: 15, duration: 1000 }
    );
  }
}

// 13. UI Rendering - Compact Editable Single-Line Beacon Listing (Using HTML Template)
function renderBeaconList() {
  list.replaceChildren();

  beacons.forEach((beacon) => {
    const clone = itemTemplate.content.cloneNode(true);
    const item = clone.querySelector('li');
    item.dataset.id = beacon.id;
    item.style.setProperty('--beacon-color', beacon.color);

    // Editable geohash input
    const hashInput = item.querySelector('input[name="geohash"]');
    hashInput.value = beacon.geohash;

    hashInput.addEventListener('change', () => {
      const val = hashInput.value.toLowerCase().trim();
      try {
        const decoded = decodeGeohash(val);
        beacon.geohash = val;
        beacon.lat = decoded.lat;
        beacon.lng = decoded.lng;
        hashInput.removeAttribute('aria-invalid');

        // Move draggable marker
        const marker = markersMap.get(beacon.id);
        if (marker) marker.setLngLat([decoded.lng, decoded.lat]);

        syncMapLayers();
        saveBeaconsToStorage(beacons);
      } catch {
        hashInput.setAttribute('aria-invalid', 'true');
      }
    });

    // Editable radius input (fits up to 6 digits)
    const radiusInput = item.querySelector('input[name="radius"]');
    radiusInput.value = beacon.radius;

    radiusInput.addEventListener('input', () => {
      const val = Number(radiusInput.value);
      if (val > 0) {
        beacon.radius = val;
        syncMapLayers();
        saveBeaconsToStorage(beacons);
      }
    });

    // Remove button
    const removeBtn = item.querySelector('button');
    removeBtn.setAttribute('aria-label', `Remove beacon ${beacon.geohash}`);
    removeBtn.addEventListener('click', () => removeBeacon(beacon.id));

    list.append(clone);
  });

  const count = beacons.length;
  output.textContent = `${count} ${count === 1 ? 'beacon' : 'beacons'}`;
}

function addBeacon(geohash, radius, customCoords = null) {
  let lat, lng;

  if (customCoords) {
    lat = customCoords.lat;
    lng = customCoords.lng;
  } else {
    const decoded = decodeGeohash(geohash);
    lat = decoded.lat;
    lng = decoded.lng;
  }

  const color = PALETTE[beacons.length % PALETTE.length];
  const beacon = {
    id: `beacon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    geohash: geohash.toLowerCase().trim(),
    radius: Number(radius),
    lat,
    lng,
    color
  };

  beacons.push(beacon);
  saveBeaconsToStorage(beacons);
  createMarkerForBeacon(beacon);
  renderBeaconList();
  syncMapLayers();
}

function removeBeacon(id) {
  const idx = beacons.findIndex(b => b.id === id);
  if (idx !== -1) {
    beacons.splice(idx, 1);
    saveBeaconsToStorage(beacons);
    removeMarkerForBeacon(id);
    renderBeaconList();
    syncMapLayers();
  }
}

// 14. Live Preview During "Add Beacon" Input
function updateAddPreview() {
  const hash = form.elements['geohash'].value.toLowerCase().trim();
  const radius = Number(form.elements['radius'].value);

  if (!hash || isNaN(radius) || radius <= 0) {
    clearAddPreview();
    return;
  }

  try {
    const decoded = decodeGeohash(hash);
    const coords = createGeodesicCircle(decoded.lng, decoded.lat, radius);

    const source = mapInstance?.getSource('preview');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [coords]
            }
          },
          {
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [decoded.lng, decoded.lat]
            }
          }
        ]
      });
    }
  } catch {
    clearAddPreview();
  }
}

function clearAddPreview() {
  const source = mapInstance?.getSource('preview');
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: []
    });
  }
}

// Live preview event listeners on Add Beacon inputs
form.elements['geohash'].addEventListener('input', updateAddPreview);
form.elements['radius'].addEventListener('input', updateAddPreview);
form.elements['geohash'].addEventListener('change', updateAddPreview);
form.elements['radius'].addEventListener('change', updateAddPreview);

// 15. Form Submission Handler
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const formData = new FormData(form);
  const geohash = formData.get('geohash');
  const radius = formData.get('radius');

  try {
    addBeacon(geohash, radius);
    clearAddPreview();
    form.reset();
    form.elements['geohash'].focus();
    fitBoundsToBeacons();
  } catch (err) {
    alert(err.message);
  }
});

// Boot Application
renderBeaconList();
initMap().catch(err => {
  console.error('Failed to initialize map:', err);
});
