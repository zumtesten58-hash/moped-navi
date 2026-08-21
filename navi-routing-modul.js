/* ============================================================================
   NAVI ROUTING-MODUL (UPDATED)
   ========================================================================= */

(function () {
  "use strict";

  function boot() {
    if (!window.Navi || typeof window.Navi.registerModule !== "function") {
      setTimeout(boot, 150);
      return;
    }
    initRoutingModule(window.Navi);
  }

  function initRoutingModule(Navi) {
    /* ======================================================================
       KONSTANTEN & EINSTELLUNGEN
       ====================================================================== */

    const STORAGE_KEY = "bn-route-settings-v1";
    const OVERPASS_ENDPOINTS = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];
    const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

    const MOTORWAY_MIN_SPEED_DEFAULT = 60;
    const CORRIDOR_MARGIN_KM = 3;
    const MAX_BBOX_DIAGONAL_KM = 120;

    const DEFAULT_SPEED_BY_HIGHWAY = {
      motorway: 130, motorway_link: 60,
      trunk: 100, trunk_link: 50,
      primary: 90, primary_link: 50,
      secondary: 80, secondary_link: 50,
      tertiary: 70, tertiary_link: 40,
      unclassified: 60,
      residential: 50,
      living_street: 20,
      service: 20,
      track: 30,
      road: 50
    };

    const ROUTABLE_HIGHWAYS = new Set([
      "motorway", "motorway_link", "trunk", "trunk_link",
      "primary", "primary_link", "secondary", "secondary_link",
      "tertiary", "tertiary_link", "unclassified", "residential",
      "living_street", "service", "track", "road"
    ]);

    const BASE_ENV_WEIGHT = {
      motorway: 1.0, motorway_link: 0.9,
      trunk: 0.95, trunk_link: 0.85,
      primary: 0.8, primary_link: 0.7,
      secondary: 0.6, secondary_link: 0.5,
      tertiary: 0.22, tertiary_link: 0.2,
      unclassified: 0.15, residential: 0.12,
      living_street: 0.05, service: 0.1, track: 0.08, road: 0.3
    };
    const URBAN_ENV_BONUS = 0.9;

    const defaultSettings = {
      maxSpeedEnabled: false,
      maxSpeedKmh: 45,
      avoidMotorway: true,
      avoidToll: false,
      quietPercent: 30,
      showTurnHints: true
    };

    let settings = loadSettings();

    function loadSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return Object.assign({}, defaultSettings);
        const parsed = JSON.parse(raw);
        return Object.assign({}, defaultSettings, parsed);
      } catch (e) {
        return Object.assign({}, defaultSettings);
      }
    }
    function saveSettings() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
    }

    /* ======================================================================
       ROUTING-ZUSTAND
       ====================================================================== */

    const map = Navi.getMap();

    const routeState = {
      startMode: "gps",
      startPoint: null,
      endPoint: null,
      pickingFor: null,
      lastRoute: null,
      graphCache: null,
      calculating: false
    };

    /* ======================================================================
       KLEINE GEO-HELFER
       ====================================================================== */

    function toRad(d) { return (d * Math.PI) / 180; }
    function toDeg(r) { return (r * 180) / Math.PI; }

    function haversineM(lat1, lon1, lat2, lon2) {
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function bearingDeg(lat1, lon1, lat2, lon2) {
      const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
      const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
      return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function pointInPolygon(lon, lat, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect =
          (yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function bboxFromPoints(points, marginKm) {
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      points.forEach(p => {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      });
      const dLat = marginKm / 111;
      const midLat = (minLat + maxLat) / 2;
      const dLon = marginKm / (111 * Math.max(0.15, Math.cos(toRad(midLat))));
      return {
        south: minLat - dLat, north: maxLat + dLat,
        west: minLon - dLon, east: maxLon + dLon
      };
    }

    /* ======================================================================
       OVERPASS: STRASSEN + LANDNUTZUNG LADEN
       ====================================================================== */

    async function fetchOverpass(query) {
      let lastErr = null;
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: query
          });
          if (!res.ok) throw new Error("Overpass HTTP " + res.status);
          return await res.json();
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("Overpass nicht erreichbar");
    }

    function buildOverpassQuery(bbox) {
      const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
      return `
[out:json][timeout:30];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|track|road)$"](${bboxStr});
  way["landuse"~"^(residential|commercial|retail|industrial)$"](${bboxStr});
  relation["landuse"~"^(residential|commercial|retail|industrial)$"](${bboxStr});
);
out body;
>;
out skel qt;
`.trim();
    }

    async function loadGraphForRoute(startPoint, endPoint) {
      const bbox = bboxFromPoints([startPoint, endPoint], CORRIDOR_MARGIN_KM);
      const diag = haversineM(bbox.south, bbox.west, bbox.north, bbox.east) / 1000;
      if (diag > MAX_BBOX_DIAGONAL_KM) {
        throw new Error(
          "Strecke ist für die Live-Kartenabfrage zu lang (" + Math.round(diag) +
          " km, Limit " + MAX_BBOX_DIAGONAL_KM + " km)."
        );
      }

      const cache = routeState.graphCache;
      if (cache && bboxContains(cache.bbox, bbox)) {
        return cache;
      }

      const data = await fetchOverpass(buildOverpassQuery(bbox));
      const graph = await parseOverpassToGraph(data);
      graph.bbox = bbox;
      routeState.graphCache = graph;
      return graph;
    }

    function bboxContains(outer, inner) {
      return outer && outer.south <= inner.south && outer.north >= inner.north &&
        outer.west <= inner.west && outer.east >= inner.east;
    }

    async function parseOverpassToGraph(data) {
      const nodes = new Map();
      const adjacency = new Map();
      const landusePolys = [];

      const wayList = [];
      (data.elements || []).forEach(el => {
        if (el.type === "node") {
          nodes.set(el.id, { lat: el.lat, lon: el.lon });
        } else if (el.type === "way") {
          wayList.push(el);
        }
      });

      wayList.forEach(way => {
        const tags = way.tags || {};
        if (tags.landuse && way.nodes && way.nodes.length > 2) {
          const ring = way.nodes
            .map(nid => nodes.get(nid))
            .filter(Boolean)
            .map(p => [p.lon, p.lat]);
          if (ring.length > 2) landusePolys.push({ ring, type: tags.landuse });
          return;
        }
        if (!tags.highway || !ROUTABLE_HIGHWAYS.has(tags.highway)) return;
        if (!way.nodes || way.nodes.length < 2) return;

        const oneway = normalizeOneway(tags);
        for (let i = 0; i < way.nodes.length - 1; i++) {
          const aId = way.nodes[i], bId = way.nodes[i + 1];
          const a = nodes.get(aId), b = nodes.get(bId);
          if (!a || !b) continue;
          const distM = haversineM(a.lat, a.lon, b.lat, b.lon);
          if (distM <= 0) continue;

          addEdge(adjacency, aId, bId, distM, tags, way.id);
          if (oneway !== "forward") addEdge(adjacency, bId, aId, distM, tags, way.id);
        }
      });

      // Asynchrone Abarbeitung der Landnutzungs-Prüfung zur Vermeidung von UI-Freezes
      let edgeCounter = 0;
      for (const edges of adjacency.values()) {
        for (const edge of edges) {
          if (edge.envResolved) continue;
          const from = nodes.get(edge.fromId), to = nodes.get(edge.to);
          if (from && to) {
            const midLon = (from.lon + to.lon) / 2, midLat = (from.lat + to.lat) / 2;
            edge.isUrban = isInsideAnyPolygon(midLon, midLat, landusePolys);
          } else {
            edge.isUrban = false;
          }
          edge.envResolved = true;

          edgeCounter++;
          if (edgeCounter % 1500 === 0) {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }

      return { nodes, adjacency, landusePolys };
    }

    function isInsideAnyPolygon(lon, lat, polys) {
      for (let i = 0; i < polys.length; i++) {
        const ring = polys[i].ring;
        let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
        for (let j = 0; j < ring.length; j++) {
          minLon = Math.min(minLon, ring[j][0]); maxLon = Math.max(maxLon, ring[j][0]);
          minLat = Math.min(minLat, ring[j][1]); maxLat = Math.max(maxLat, ring[j][1]);
        }
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        if (pointInPolygon(lon, lat, ring)) return true;
      }
      return false;
    }

    function normalizeOneway(tags) {
      if (tags.junction === "roundabout" || tags.junction === "circular") return "forward";
      const v = (tags.oneway || "").toLowerCase();
      if (v === "yes" || v === "1" || v === "true") return "forward";
      if (v === "-1" || v === "reverse") return "backward";
      return "no";
    }

    function addEdge(adjacency, fromId, toId, distM, tags, wayId) {
      if (!adjacency.has(fromId)) adjacency.set(fromId, []);
      adjacency.get(fromId).push({
        to: toId, fromId, distM, tags, wayId, envResolved: false, isUrban: false
      });
    }

    function parseSpeedTag(raw) {
      if (!raw) return null;
      const s = String(raw).trim().toLowerCase();
      if (s === "none" || s === "signals" || s === "walk") return null;
      const num = parseFloat(s.replace(",", "."));
      if (isNaN(num)) return null;
      if (s.indexOf("mph") !== -1) return num * 1.60934;
      return num;
    }

    function roadSpeedKmh(tags) {
      const parsed = parseSpeedTag(tags.maxspeed);
      if (parsed) return parsed;
      return DEFAULT_SPEED_BY_HIGHWAY[tags.highway] || 50;
    }

    function requiredMinSpeedKmh(tags) {
      const explicit = parseSpeedTag(tags.minspeed);
      if (explicit) return explicit;
      if (tags.highway === "motorway" || tags.highway === "motorway_link") {
        return MOTORWAY_MIN_SPEED_DEFAULT;
      }
      return 0;
    }

    function edgeCost(edge, cfg) {
      const tags = edge.tags;

      if (cfg.avoidMotorway && (tags.highway === "motorway" || tags.highway === "motorway_link" ||
        tags.highway === "trunk" || tags.highway === "trunk_link")) {
        return null;
      }
      if (cfg.avoidToll && (tags.toll === "yes")) {
        return null;
      }

      const vRoad = roadSpeedKmh(tags);
      const vVehicle = cfg.maxSpeedEnabled ? cfg.maxSpeedKmh : Infinity;

      const minRequired = requiredMinSpeedKmh(tags);
      if (cfg.maxSpeedEnabled && minRequired > 0 && vVehicle < minRequired) {
        return null;
      }

      const vEff = Math.min(vRoad, vVehicle);
      if (vEff <= 0) return null;

      const timeH = (edge.distM / 1000) / vEff;

      const factorRuhe = (cfg.quietPercent || 0) / 100;
      let envWeight = BASE_ENV_WEIGHT[tags.highway] != null ? BASE_ENV_WEIGHT[tags.highway] : 0.3;
      if (edge.isUrban) envWeight = Math.min(1.2, envWeight + URBAN_ENV_BONUS);

      const cost = timeH * (1 + factorRuhe * envWeight);
      return { cost, timeH, vEff };
    }

    /* ======================================================================
       A*-SUCHE MIT BINÄRER MIN-HEAP (ASYNC/NON-BLOCKING)
       ====================================================================== */

    function MinHeap() {
      this.items = [];
    }
    MinHeap.prototype.push = function (item) {
      const items = this.items;
      items.push(item);
      let i = items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (items[parent].f <= items[i].f) break;
        [items[parent], items[i]] = [items[i], items[parent]];
        i = parent;
      }
    };
    MinHeap.prototype.pop = function () {
      const items = this.items;
      if (items.length === 0) return null;
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let i = 0;
        while (true) {
          const l = i * 2 + 1, r = i * 2 + 2;
          let smallest = i;
          if (l < items.length && items[l].f < items[smallest].f) smallest = l;
          if (r < items.length && items[r].f < items[smallest].f) smallest = r;
          if (smallest === i) break;
          [items[smallest], items[i]] = [items[i], items[smallest]];
          i = smallest;
        }
      }
      return top;
    };
    MinHeap.prototype.isEmpty = function () { return this.items.length === 0; };

    function findNearestNode(graph, lon, lat) {
      let best = null, bestDist = Infinity;
      graph.nodes.forEach((p, id) => {
        if (!graph.adjacency.has(id) && !hasIncoming(graph, id)) return;
        const d = haversineM(lat, lon, p.lat, p.lon);
        if (d < bestDist) { bestDist = d; best = id; }
      });
      return best;
    }

    let incomingCache = null;
    function hasIncoming(graph, id) {
      if (!incomingCache || incomingCache.graph !== graph) {
        const set = new Set();
        graph.adjacency.forEach(edges => edges.forEach(e => set.add(e.to)));
        incomingCache = { graph, set };
      }
      return incomingCache.set.has(id);
    }

    const FASTEST_POSSIBLE_KMH = 130;

    async function aStarRoute(graph, startId, endId, cfg) {
      const endPos = graph.nodes.get(endId);
      const heap = new MinHeap();
      const gScore = new Map();
      const cameFrom = new Map();

      gScore.set(startId, 0);
      heap.push({ id: startId, f: 0 });

      const visited = new Set();
      let iterations = 0;
      const ITER_LIMIT = 400000;

      while (!heap.isEmpty()) {
        if (++iterations > ITER_LIMIT) throw new Error("Routenberechnung abgebrochen (zu komplex).");

        // Alle 2500 Durchläufe kurz den Hauptthread freigeben, um Freezes zu verhindern
        if (iterations % 2500 === 0) {
          await new Promise(r => setTimeout(r, 0));
        }

        const current = heap.pop();
        if (visited.has(current.id)) continue;
        visited.add(current.id);
        if (current.id === endId) break;

        const edges = graph.adjacency.get(current.id) || [];
        for (const edge of edges) {
          const result = edgeCost(edge, cfg);
          if (!result) continue;
          const tentativeG = gScore.get(current.id) + result.cost;
          if (tentativeG < (gScore.get(edge.to) != null ? gScore.get(edge.to) : Infinity)) {
            gScore.set(edge.to, tentativeG);
            cameFrom.set(edge.to, { from: current.id, edge, timeH: result.timeH });
            const pos = graph.nodes.get(edge.to);
            const h = pos ? (haversineM(pos.lat, pos.lon, endPos.lat, endPos.lon) / 1000) / FASTEST_POSSIBLE_KMH : 0;
            heap.push({ id: edge.to, f: tentativeG + h });
          }
        }
      }

      if (!gScore.has(endId)) return null;

      const pathIds = [endId];
      const pathEdges = [];
      let cursor = endId;
      while (cursor !== startId) {
        const step = cameFrom.get(cursor);
        if (!step) return null;
        pathEdges.unshift(step);
        pathIds.unshift(step.from);
        cursor = step.from;
      }

      let distanceM = 0, timeH = 0;
      pathEdges.forEach(s => { distanceM += s.edge.distM; timeH += s.timeH; });

      return { nodeIds: pathIds, edges: pathEdges.map(s => s.edge), distanceM, timeS: timeH * 3600 };
    }

    /* ======================================================================
       ABBIEGEHINWEISE
       ====================================================================== */

    function buildTurnSteps(graph, routeResult) {
      const ids = routeResult.nodeIds;
      const steps = [];
      let cumDist = 0;
      const segDistances = routeResult.edges.map(e => e.distM);

      for (let i = 1; i < ids.length - 1; i++) {
        const pPrev = graph.nodes.get(ids[i - 1]);
        const pCur = graph.nodes.get(ids[i]);
        const pNext = graph.nodes.get(ids[i + 1]);
        cumDist += segDistances[i - 1];
        if (!pPrev || !pCur || !pNext) continue;

        const bIn = bearingDeg(pPrev.lat, pPrev.lon, pCur.lat, pCur.lon);
        const bOut = bearingDeg(pCur.lat, pCur.lon, pNext.lat, pNext.lon);
        let diff = bOut - bIn;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;

        if (Math.abs(diff) < 28) continue;

        const dir = diff > 0 ? "rechts" : "links";
        const strength = Math.abs(diff) > 100 ? "scharf " : Math.abs(diff) > 55 ? "" : "leicht ";
        const streetName = (routeResult.edges[i] && routeResult.edges[i].tags && routeResult.edges[i].tags.name) || "";
        steps.push({
          atDistanceM: cumDist,
          text: `${strength}${dir} abbiegen`.trim(),
          street: streetName,
          lon: pCur.lon, lat: pCur.lat
        });
      }
      steps.push({
        atDistanceM: routeResult.distanceM,
        text: "Ziel erreicht",
        street: "",
        lon: graph.nodes.get(ids[ids.length - 1]).lon,
        lat: graph.nodes.get(ids[ids.length - 1]).lat
      });
      return steps;
    }

    /* ======================================================================
       KARTEN-DARSTELLUNG DER ROUTE
       ====================================================================== */

    const ROUTE_SOURCE_ID = "bn-route-line";
    const ROUTE_LAYER_CASING = "bn-route-line-casing";
    const ROUTE_LAYER_MAIN = "bn-route-line-main";
    const MARKER_SOURCE_ID = "bn-route-markers";
    const MARKER_LAYER_ID = "bn-route-markers-layer";

    function ensureRouteLayers() {
      if (!map.getSource(ROUTE_SOURCE_ID)) {
        map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: ROUTE_LAYER_CASING, type: "line", source: ROUTE_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#000000", "line-opacity": 0.35, "line-width": 8 }
        });
        map.addLayer({
          id: ROUTE_LAYER_MAIN, type: "line", source: ROUTE_SOURCE_ID,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": getCssVar("--bn-accent", "#20c9a8"), "line-width": 5 }
        });
      }
      if (!map.getSource(MARKER_SOURCE_ID)) {
        map.addSource(MARKER_SOURCE_ID, { type: "geojson", data: emptyFC() });
        map.addLayer({
          id: MARKER_LAYER_ID, type: "circle", source: MARKER_SOURCE_ID,
          paint: {
            "circle-radius": 7,
            "circle-color": [
              "match", ["get", "kind"],
              "start", getCssVar("--bn-info", "#4fb3ff"),
              "end", getCssVar("--bn-danger", "#ff5d5d"),
              getCssVar("--bn-accent", "#20c9a8")
            ],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2
          }
        });
      }
    }

    function getCssVar(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    }

    function emptyFC() { return { type: "FeatureCollection", features: [] }; }

    function drawRouteOnMap(coords, startPoint, endPoint) {
      ensureRouteLayers();
      map.getSource(ROUTE_SOURCE_ID).setData({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} }]
      });
      map.getSource(MARKER_SOURCE_ID).setData({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [startPoint.lon, startPoint.lat] }, properties: { kind: "start" } },
          { type: "Feature", geometry: { type: "Point", coordinates: [endPoint.lon, endPoint.lat] }, properties: { kind: "end" } }
        ]
      });
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 64, duration: 500, maxZoom: 16 });
    }

    function clearRouteFromMap() {
      if (map.getSource(ROUTE_SOURCE_ID)) map.getSource(ROUTE_SOURCE_ID).setData(emptyFC());
      if (map.getSource(MARKER_SOURCE_ID)) map.getSource(MARKER_SOURCE_ID).setData(emptyFC());
    }

    const themeObserver = new MutationObserver(() => {
      if (map.getLayer(ROUTE_LAYER_MAIN)) {
        map.setPaintProperty(ROUTE_LAYER_MAIN, "line-color", getCssVar("--bn-accent", "#20c9a8"));
      }
      if (map.getLayer(MARKER_LAYER_ID)) {
        map.setPaintProperty(MARKER_LAYER_ID, "circle-color", [
          "match", ["get", "kind"],
          "start", getCssVar("--bn-info", "#4fb3ff"),
          "end", getCssVar("--bn-danger", "#ff5d5d"),
          getCssVar("--bn-accent", "#20c9a8")
        ]);
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    map.on("style.load", () => { routeState._layersNeedReAdd = true; });
    map.on("idle", () => {
      if (routeState._layersNeedReAdd) {
        routeState._layersNeedReAdd = false;
        ensureRouteLayers();
        if (routeState.lastRoute) {
          drawRouteOnMap(routeState.lastRoute.coords, routeState.startPoint, routeState.endPoint);
        }
      }
    });

    /* ======================================================================
       KARTENKLICK ZUM SETZEN VON START/ZIEL (KORRIGIERT)
       ====================================================================== */

    map.on("click", (e) => {
      if (!routeState.pickingFor) return;
      const point = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      if (routeState.pickingFor === "start") {
        routeState.startMode = "custom";
        routeState.startPoint = point;
        Navi.showToast("Startpunkt gesetzt", "success");
      } else if (routeState.pickingFor === "end") {
        routeState.endPoint = point;
        Navi.showToast("Ziel gesetzt", "success");
      }
      routeState.pickingFor = null;
      map.getCanvas().style.cursor = "";
      refreshPanel();

      // Modal nach der Kartenauswahl automatisch wieder öffnen
      if (typeof Navi.openModal === "function") {
        Navi.openModal("Routing", panelEl);
      }
    });

    function startPicking(which) {
      routeState.pickingFor = which;
      map.getCanvas().style.cursor = "crosshair";

      // Modal schließen, damit Klicks auf die Karte ungehindert ankommen
      if (typeof Navi.closeModal === "function") {
        Navi.closeModal();
      }

      Navi.showToast(
        which === "start" ? "Tippe auf die Karte, um den Start zu setzen" : "Tippe auf die Karte, um das Ziel zu setzen",
        "warn"
      );
    }

    /* ======================================================================
       ADRESSSUCHE (NOMINATIM) FÜRS ZIEL
       ====================================================================== */

    async function geocode(query) {
      const url = NOMINATIM_ENDPOINT + "?format=json&limit=5&q=" + encodeURIComponent(query);
      const res = await fetch(url, { headers: { "Accept-Language": "de" } });
      if (!res.ok) throw new Error("Adresssuche fehlgeschlagen");
      return res.json();
    }

    /* ======================================================================
       ROUTE BERECHNEN (ORCHESTRIERUNG - ASYNC)
       ====================================================================== */

    async function computeRoute() {
      if (routeState.calculating) return;

      const start = routeState.startMode === "gps"
        ? (Navi.getLastPosition() ? { lon: Navi.getLastPosition().lon, lat: Navi.getLastPosition().lat } : null)
        : routeState.startPoint;

      if (!start) { Navi.showToast("Kein Startpunkt: GPS wartet noch oder Startpunkt setzen", "warn"); return; }
      if (!routeState.endPoint) { Navi.showToast("Bitte zuerst ein Ziel setzen", "warn"); return; }

      routeState.startPoint = start;
      routeState.calculating = true;
      setPanelBusy(true);

      try {
        const graph = await loadGraphForRoute(start, routeState.endPoint);
        const startId = findNearestNode(graph, start.lon, start.lat);
        const endId = findNearestNode(graph, routeState.endPoint.lon, routeState.endPoint.lat);

        if (startId == null || endId == null) {
          throw new Error("In der Nähe von Start oder Ziel wurden keine passenden Straßen gefunden.");
        }

        const cfg = {
          maxSpeedEnabled: settings.maxSpeedEnabled,
          maxSpeedKmh: settings.maxSpeedKmh,
          avoidMotorway: settings.avoidMotorway,
          avoidToll: settings.avoidToll,
          quietPercent: settings.quietPercent
        };

        const result = await aStarRoute(graph, startId, endId, cfg);
        if (!result) {
          throw new Error("Keine gültige Route gefunden (evtl. wegen Sperren/Höchstgeschwindigkeit zu restriktiv).");
        }

        const coords = result.nodeIds.map(id => {
          const p = graph.nodes.get(id);
          return [p.lon, p.lat];
        });
        const steps = buildTurnSteps(graph, result);

        routeState.lastRoute = {
          coords, distanceM: result.distanceM, timeS: result.timeS, steps
        };

        drawRouteOnMap(coords, start, routeState.endPoint);
        updateHudWidget();
        updateTurnBox(0);
        Navi.showToast("Route berechnet", "success");
      } catch (err) {
        Navi.showToast(err && err.message ? err.message : "Route konnte nicht berechnet werden", "error");
      } finally {
        routeState.calculating = false;
        setPanelBusy(false);
        refreshPanel();
      }
    }

    function clearRoute() {
      routeState.lastRoute = null;
      routeState.startPoint = null;
      routeState.endPoint = null;
      routeState.startMode = "gps";
      clearRouteFromMap();
      updateHudWidget();
      hideTurnBox();
      refreshPanel();
    }

    /* ======================================================================
       LIVE-NAVIGATION
       ====================================================================== */

    Navi.onPositionUpdate((pos) => {
      if (!routeState.lastRoute || !settings.showTurnHints) return;
      const steps = routeState.lastRoute.steps;
      if (!steps || !steps.length) return;

      let bestIdx = 0, bestDist = Infinity;
      steps.forEach((s, i) => {
        const d = haversineM(pos.lat, pos.lon, s.lat, s.lon);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      updateTurnBox(bestIdx, bestDist);
    });

    /* ======================================================================
       UI: HUD-WIDGET
       ====================================================================== */

    function fmtDistance(m) {
      if (m >= 1000) return (m / 1000).toFixed(1) + " km";
      return Math.round(m) + " m";
    }
    function fmtDuration(s) {
      const totalMin = Math.round(s / 60);
      const h = Math.floor(totalMin / 60), m = totalMin % 60;
      return h > 0 ? `${h} h ${m} min` : `${m} min`;
    }

    function updateHudWidget() {
      if (!routeState.lastRoute) {
        Navi.removeHudWidget("route-eta");
        return;
      }
      const r = routeState.lastRoute;
      const node = document.createElement("div");
      node.innerHTML = `
        <span class="bn-hud-label">Route</span>
        <span class="bn-hud-value" style="font-size:14px;">${fmtDistance(r.distanceM)} · ${fmtDuration(r.timeS)}</span>
      `;
      node.style.cursor = "pointer";
      node.addEventListener("click", () => Navi.openModal("Routing", panelEl));
      Navi.addHudWidget("route-eta", node);
    }

    /* ======================================================================
       UI: ABBIEGE-ANZEIGE
       ====================================================================== */

    let turnBoxNode = null;
    function ensureTurnBox() {
      if (turnBoxNode) return turnBoxNode;
      turnBoxNode = document.createElement("div");
      turnBoxNode.style.cssText = `
        display:flex; align-items:center; gap:10px; padding:8px 14px;
        font-family:var(--bn-font-display, sans-serif); font-size:13px;
        white-space:nowrap;
      `;
      Navi.addOverlayWidget("route-turn-hint", turnBoxNode);
      return turnBoxNode;
    }

    function updateTurnBox(stepIdx, distToStepM) {
      if (!settings.showTurnHints || !routeState.lastRoute) { hideTurnBox(); return; }
      const steps = routeState.lastRoute.steps;
      const step = steps[stepIdx];
      if (!step) { hideTurnBox(); return; }
      const box = ensureTurnBox();
      const distText = distToStepM != null ? fmtDistance(distToStepM) : fmtDistance(step.atDistanceM);
      box.innerHTML = `
        <span style="font-size:18px;">↪️</span>
        <span><strong>${escapeHtml(step.text)}</strong>${step.street ? " auf " + escapeHtml(step.street) : ""}<br>
        <span style="opacity:.7;">in ${distText}</span></span>
      `;
      box.style.display = "flex";
    }
    function hideTurnBox() {
      if (turnBoxNode) turnBoxNode.style.display = "none";
    }
    function escapeHtml(s) {
      const d = document.createElement("div");
      d.textContent = s == null ? "" : String(s);
      return d.innerHTML;
    }

    /* ======================================================================
       UI: EINSTELLUNGS-PANEL
       ====================================================================== */

    const panelEl = document.createElement("div");
    panelEl.className = "bn-route-panel";
    panelEl.innerHTML = `
      <style>
        .bn-route-panel{display:flex; flex-direction:column; gap:16px; font-family:var(--bn-font-display, sans-serif);}
        .bn-route-panel h4{margin:0 0 6px 0; font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:var(--bn-fg-dim); font-weight:600;}
        .bn-route-row{display:flex; align-items:center; justify-content:space-between; gap:10px;}
        .bn-route-btn{
          flex:1; padding:10px 12px; border-radius:var(--bn-radius-m,10px); border:1px solid var(--bn-line-strong);
          background:var(--bn-deep-700); color:var(--bn-fg); font-size:13px; cursor:pointer; text-align:center;
        }
        .bn-route-btn.bn-primary{background:var(--bn-accent); color:#04231d; border-color:transparent; font-weight:600;}
        .bn-route-btn.bn-active{outline:2px solid var(--bn-accent);}
        .bn-route-switch{
          position:relative; width:44px; height:24px; border-radius:12px; background:var(--bn-deep-600);
          border:1px solid var(--bn-line-strong); cursor:pointer; flex-shrink:0;
        }
        .bn-route-switch .knob{
          position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%;
          background:var(--bn-fg-dim); transition:left .15s ease, background .15s ease;
        }
        .bn-route-switch.bn-on{background:var(--bn-accent);}
        .bn-route-switch.bn-on .knob{left:22px; background:#04231d;}
        .bn-route-field{
          width:84px; padding:7px 8px; border-radius:8px; border:1px solid var(--bn-line-strong);
          background:var(--bn-deep-800); color:var(--bn-fg); font-size:13px; text-align:right;
        }
        .bn-route-panel input[type="range"]{width:100%;}
        .bn-route-status{font-size:12px; color:var(--bn-fg-dim); min-height:16px;}
        .bn-route-search{display:flex; gap:6px;}
        .bn-route-search input{flex:1; padding:8px 10px; border-radius:8px; border:1px solid var(--bn-line-strong); background:var(--bn-deep-800); color:var(--bn-fg); font-size:13px;}
        .bn-route-results{display:flex; flex-direction:column; gap:4px; max-height:140px; overflow-y:auto;}
        .bn-route-result{padding:7px 9px; border-radius:8px; background:var(--bn-deep-700); cursor:pointer; font-size:12.5px;}
        .bn-route-result:hover{background:var(--bn-deep-600);}
      </style>

      <div>
        <h4>Start &amp; Ziel</h4>
        <div class="bn-route-row" style="margin-bottom:8px;">
          <button class="bn-route-btn" data-act="start-gps">📍 Meine Position</button>
          <button class="bn-route-btn" data-act="start-pick">🖊️ Start wählen</button>
        </div>
        <div class="bn-route-row" style="margin-bottom:8px;">
          <button class="bn-route-btn" data-act="end-pick" style="flex:1;">🏁 Ziel auf Karte wählen</button>
        </div>
        <div class="bn-route-search">
          <input type="text" placeholder="Adresse suchen…" data-role="search-input">
          <button class="bn-route-btn" data-act="search" style="flex:0 0 auto; padding:8px 14px;">🔎</button>
        </div>
        <div class="bn-route-results" data-role="search-results"></div>
      </div>

      <div>
        <h4>Fahrzeugprofil</h4>
        <div class="bn-route-row" style="margin-bottom:8px;">
          <span>Höchstgeschwindigkeit begrenzen</span>
          <div class="bn-route-switch" data-role="sw-maxspeed"><div class="knob"></div></div>
        </div>
        <div class="bn-route-row" style="margin-bottom:4px;">
          <input type="range" min="10" max="130" step="1" data-role="range-maxspeed">
          <input type="number" min="1" max="300" class="bn-route-field" data-role="num-maxspeed">
        </div>
        <div class="bn-route-row" style="margin-bottom:8px;">
          <span>Autobahn &amp; Schnellstraßen meiden</span>
          <div class="bn-route-switch" data-role="sw-motorway"><div class="knob"></div></div>
        </div>
        <div class="bn-route-row">
          <span>Mautstrecken meiden</span>
          <div class="bn-route-switch" data-role="sw-toll"><div class="knob"></div></div>
        </div>
      </div>

      <div>
        <h4>Ruhige Route</h4>
        <div class="bn-route-row" style="margin-bottom:4px;">
          <input type="range" min="0" max="100" step="5" data-role="range-quiet" style="flex:1;">
          <span data-role="label-quiet" style="width:44px; text-align:right; font-size:13px;">30%</span>
        </div>
      </div>

      <div>
        <h4>Abbiegehinweise</h4>
        <div class="bn-route-row">
          <span>Kleine Hinweisanzeige beim Fahren</span>
          <div class="bn-route-switch" data-role="sw-turnhints"><div class="knob"></div></div>
        </div>
      </div>

      <div class="bn-route-row" style="margin-top:4px;">
        <button class="bn-route-btn bn-primary" data-act="calc">Route berechnen</button>
        <button class="bn-route-btn" data-act="clear">Löschen</button>
      </div>
      <div class="bn-route-status" data-role="status"></div>
    `;

    const p = {
      swMaxspeed: panelEl.querySelector('[data-role="sw-maxspeed"]'),
      rangeMaxspeed: panelEl.querySelector('[data-role="range-maxspeed"]'),
      numMaxspeed: panelEl.querySelector('[data-role="num-maxspeed"]'),
      swMotorway: panelEl.querySelector('[data-role="sw-motorway"]'),
      swToll: panelEl.querySelector('[data-role="sw-toll"]'),
      rangeQuiet: panelEl.querySelector('[data-role="range-quiet"]'),
      labelQuiet: panelEl.querySelector('[data-role="label-quiet"]'),
      swTurnhints: panelEl.querySelector('[data-role="sw-turnhints"]'),
      status: panelEl.querySelector('[data-role="status"]'),
      searchInput: panelEl.querySelector('[data-role="search-input"]'),
      searchResults: panelEl.querySelector('[data-role="search-results"]'),
      btnStartGps: panelEl.querySelector('[data-act="start-gps"]'),
      btnStartPick: panelEl.querySelector('[data-act="start-pick"]'),
      btnEndPick: panelEl.querySelector('[data-act="end-pick"]'),
      btnCalc: panelEl.querySelector('[data-act="calc"]'),
      btnClear: panelEl.querySelector('[data-act="clear"]')
    };

    function setSwitch(node, on) { node.classList.toggle("bn-on", !!on); }

    function refreshPanel() {
      setSwitch(p.swMaxspeed, settings.maxSpeedEnabled);
      p.rangeMaxspeed.value = settings.maxSpeedKmh;
      p.numMaxspeed.value = settings.maxSpeedKmh;
      p.rangeMaxspeed.disabled = !settings.maxSpeedEnabled;
      p.numMaxspeed.disabled = !settings.maxSpeedEnabled;

      setSwitch(p.swMotorway, settings.avoidMotorway);
      setSwitch(p.swToll, settings.avoidToll);

      p.rangeQuiet.value = settings.quietPercent;
      p.labelQuiet.textContent = settings.quietPercent + "%";

      setSwitch(p.swTurnhints, settings.showTurnHints);

      p.btnStartPick.classList.toggle("bn-active", routeState.pickingFor === "start");
      p.btnEndPick.classList.toggle("bn-active", routeState.pickingFor === "end");
      p.btnStartGps.classList.toggle("bn-active", routeState.startMode === "gps");

      let statusText = "";
      if (!routeState.endPoint) statusText = "Noch kein Ziel gewählt.";
      else if (routeState.startMode === "gps" && !Navi.getLastPosition()) statusText = "Warte auf GPS-Position…";
      else if (routeState.lastRoute) {
        statusText = `${fmtDistance(routeState.lastRoute.distanceM)} · ${fmtDuration(routeState.lastRoute.timeS)}`;
      } else {
        statusText = "Bereit zur Berechnung.";
      }
      p.status.textContent = statusText;
    }

    function setPanelBusy(busy) {
      p.btnCalc.textContent = busy ? "Berechne…" : "Route berechnen";
      p.btnCalc.disabled = busy;
    }

    p.swMaxspeed.addEventListener("click", () => {
      settings.maxSpeedEnabled = !settings.maxSpeedEnabled;
      saveSettings(); refreshPanel();
    });
    p.rangeMaxspeed.addEventListener("input", () => {
      settings.maxSpeedKmh = parseFloat(p.rangeMaxspeed.value) || 45;
      p.numMaxspeed.value = settings.maxSpeedKmh;
      saveSettings();
    });
    p.numMaxspeed.addEventListener("change", () => {
      const v = parseFloat(p.numMaxspeed.value);
      settings.maxSpeedKmh = isNaN(v) || v <= 0 ? 45 : v;
      p.rangeMaxspeed.value = Math.min(130, Math.max(10, settings.maxSpeedKmh));
      saveSettings();
    });
    p.swMotorway.addEventListener("click", () => {
      settings.avoidMotorway = !settings.avoidMotorway; saveSettings(); refreshPanel();
    });
    p.swToll.addEventListener("click", () => {
      settings.avoidToll = !settings.avoidToll; saveSettings(); refreshPanel();
    });
    p.rangeQuiet.addEventListener("input", () => {
      settings.quietPercent = parseInt(p.rangeQuiet.value, 10);
      p.labelQuiet.textContent = settings.quietPercent + "%";
      saveSettings();
    });
    p.swTurnhints.addEventListener("click", () => {
      settings.showTurnHints = !settings.showTurnHints;
      saveSettings(); refreshPanel();
      if (!settings.showTurnHints) hideTurnBox();
      else if (routeState.lastRoute) updateTurnBox(0);
    });

    p.btnStartGps.addEventListener("click", () => {
      routeState.startMode = "gps";
      routeState.startPoint = null;
      refreshPanel();
    });
    p.btnStartPick.addEventListener("click", () => startPicking("start"));
    p.btnEndPick.addEventListener("click", () => startPicking("end"));
    p.btnCalc.addEventListener("click", computeRoute);
    p.btnClear.addEventListener("click", clearRoute);

    let searchDebounce = null;
    p.searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
    panelEl.querySelector('[data-act="search"]').addEventListener("click", runSearch);

    function runSearch() {
      const q = p.searchInput.value.trim();
      if (!q) return;
      p.searchResults.innerHTML = '<div class="bn-route-result">Suche…</div>';
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(async () => {
        try {
          const results = await geocode(q);
          if (!results.length) {
            p.searchResults.innerHTML = '<div class="bn-route-result">Keine Treffer</div>';
            return;
          }
          p.searchResults.innerHTML = "";
          results.forEach(r => {
            const row = document.createElement("div");
            row.className = "bn-route-result";
            row.textContent = r.display_name;
            row.addEventListener("click", () => {
              routeState.endPoint = { lon: parseFloat(r.lon), lat: parseFloat(r.lat) };
              p.searchResults.innerHTML = "";
              p.searchInput.value = r.display_name;
              Navi.showToast("Ziel gesetzt: " + r.display_name, "success");
              refreshPanel();
            });
            p.searchResults.appendChild(row);
          });
        } catch (err) {
          p.searchResults.innerHTML = '<div class="bn-route-result">Suche fehlgeschlagen</div>';
        }
      }, 400);
    }

    /* ======================================================================
       MODUL REGISTRIEREN
       ====================================================================== */

    Navi.registerModule({
      id: "route-planner",
      name: "Routing",
      icon: "🧭",
      description: "Route mit Fahrzeugprofil, Sperrzonen & Ruhe-Gewichtung",
      onOpen() { refreshPanel(); Navi.openModal("Routing", panelEl); }
    });

    refreshPanel();
  }

  boot();
})();
