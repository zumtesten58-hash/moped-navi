(function() {
  "use strict";

  if (!window.Navi) return;

  // CSS Styles für Wetter-Modul
  const style = document.createElement('style');
  style.textContent = `
    .bn-weather-pill {
      cursor: pointer;
      user-select: none;
      transition: transform 0.15s ease, background-color 0.15s ease;
    }
    .bn-weather-pill:active {
      transform: scale(0.95);
    }
    .bn-weather-modal-card {
      position: fixed;
      top: calc(10px + var(--bn-safe-top));
      right: calc(10px + var(--bn-safe-right));
      left: calc(10px + var(--bn-safe-left));
      max-width: 440px;
      margin: 0 auto;
      background: var(--bn-glass-bg-strong);
      backdrop-filter: blur(var(--bn-glass-blur)) saturate(140%);
      -webkit-backdrop-filter: blur(var(--bn-glass-blur)) saturate(140%);
      border: 1px solid var(--bn-line-strong);
      border-radius: var(--bn-radius-l);
      box-shadow: var(--bn-shadow);
      z-index: 800;
      color: var(--bn-fg);
      display: none;
      flex-direction: column;
      max-height: calc(88vh - var(--bn-safe-top) - var(--bn-safe-bottom));
      overflow: hidden;
      touch-action: pan-y;
      transition: transform 0.25s cubic-bezier(0.32, 0.72, 0.35, 1), opacity 0.2s ease;
    }
    .bn-weather-modal-card.bn-show {
      display: flex;
    }
    .bn-weather-drag-handle {
      width: 40px;
      height: 4px;
      background: var(--bn-line-strong);
      border-radius: 2px;
      margin: 8px auto 4px;
      flex-shrink: 0;
    }
    .bn-weather-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      border-bottom: 1px solid var(--bn-line);
    }
    .bn-weather-head h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }
    .bn-weather-close-btn {
      background: transparent;
      border: 1px solid var(--bn-line);
      color: var(--bn-fg-dim);
      border-radius: var(--bn-radius-s);
      width: 28px;
      height: 28px;
      font-size: 14px;
      cursor: pointer;
    }
    .bn-weather-body {
      padding: 12px 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .bn-weather-today-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 12px;
      align-items: center;
      background: rgba(255,255,255,0.03);
      padding: 12px;
      border-radius: var(--bn-radius-m);
      border: 1px solid var(--bn-line);
    }
    .bn-weather-today-icon {
      font-size: 42px;
      line-height: 1;
      text-align: center;
    }
    .bn-weather-today-temp {
      font-size: 26px;
      font-weight: 800;
      font-family: var(--bn-font-mono);
      color: var(--bn-accent);
    }
    .bn-weather-details-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 6px 12px;
      font-size: 12px;
      color: var(--bn-fg-dim);
    }
    .bn-weather-details-grid strong {
      color: var(--bn-fg);
    }
    .bn-weather-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--bn-fg-faint);
      margin-bottom: 6px;
    }
    .bn-weather-hourly-scroll {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .bn-weather-hourly-scroll::-webkit-scrollbar {
      height: 4px;
    }
    .bn-weather-hourly-scroll::-webkit-scrollbar-thumb {
      background: var(--bn-line-strong);
      border-radius: 2px;
    }
    .bn-weather-hourly-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--bn-line);
      border-radius: var(--bn-radius-s);
      padding: 8px 10px;
      min-width: 65px;
      font-size: 11px;
      flex-shrink: 0;
      text-align: center;
    }
    .bn-weather-hourly-item .bn-time { font-weight: 700; color: var(--bn-fg-dim); }
    .bn-weather-hourly-item .bn-icon { font-size: 18px; margin: 4px 0; }
    .bn-weather-hourly-item .bn-temp { font-weight: 700; color: var(--bn-fg); }
    .bn-weather-hourly-item .bn-sub { font-size: 9.5px; color: var(--bn-fg-faint); margin-top: 2px; }
    .bn-weather-daily-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bn-weather-daily-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--bn-line);
      border-radius: var(--bn-radius-s);
      padding: 8px 10px;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
      transition: background-color 0.15s ease;
    }
    .bn-weather-daily-item:active {
      background: rgba(255,255,255,0.06);
    }
    .bn-weather-daily-main {
      display: grid;
      grid-template-columns: 65px 30px 1fr;
      align-items: center;
      gap: 8px;
    }
    .bn-weather-daily-item .bn-day { font-weight: 700; }
    .bn-weather-daily-item .bn-stats { font-family: var(--bn-font-mono); font-size: 11px; text-align: right; }
    .bn-weather-daily-extra {
      display: none;
      font-size: 11px;
      color: var(--bn-fg-dim);
      padding-top: 4px;
      border-top: 1px dashed var(--bn-line);
    }
    .bn-weather-daily-item.bn-expanded .bn-weather-daily-extra {
      display: block;
    }
  `;
  document.head.appendChild(style);

  // Open-Meteo WMO-Code Übersetzung
  const WMO_CODES = {
    0: { text: "Sonnig", icon: "☀️" },
    1: { text: "Überwiegend klar", icon: "🌤️" },
    2: { text: "Teilweise bewölkt", icon: "⛅" },
    3: { text: "Bedeckt", icon: "☁️" },
    45: { text: "Nebel", icon: "🌫️" },
    48: { text: "Rauhreifnebel", icon: "🌫️" },
    51: { text: "Leichter Sprühregen", icon: "🌦️" },
    53: { text: "Sprühregen", icon: "🌦️" },
    55: { text: "Starker Sprühregen", icon: "🌧️" },
    61: { text: "Leichter Regen", icon: "🌧️" },
    63: { text: "Mäßiger Regen", icon: "🌧️" },
    65: { text: "Starker Regen", icon: "🌧️" },
    71: { text: "Leichter Schneefall", icon: "🌨️" },
    73: { text: "Schneefall", icon: "❄️" },
    75: { text: "Starker Schneefall", icon: "❄️" },
    80: { text: "Leichter Regenschauer", icon: "🌦️" },
    81: { text: "Regenschauer", icon: "🌧️" },
    82: { text: "Starker Regenschauer", icon: "⛈️" },
    95: { text: "Gewitter", icon: "🌩️" },
    96: { text: "Gewitter mit Hagel", icon: "⛈️" },
    99: { text: "Schweres Gewitter", icon: "⛈️" }
  };

  function getWeatherMeta(code) {
    return WMO_CODES[code] || { text: "Unbekannt", icon: "🌡️" };
  }

  function getWindDirText(deg) {
    if (deg == null || isNaN(deg)) return "--";
    const dirs = ['Nord', 'Nordnordost', 'Nordost', 'Ostnordost', 'Ost', 'Ostsüdost', 'Südost', 'Südsüdost', 'Süd', 'Südsüdwest', 'Südwest', 'Westsüdwest', 'West', 'Westnordwest', 'Nordwest', 'Nordnordwest'];
    const idx = Math.round(deg / 22.5) % 16;
    return dirs[idx];
  }

  function formatSpeedValue(kmhVal, unit) {
    if (kmhVal == null || isNaN(kmhVal)) return "--";
    if (unit === 'kn') return (kmhVal / 1.852).toFixed(1) + ' kn';
    if (unit === 'mph') return (kmhVal / 1.60934).toFixed(1) + ' mph';
    return kmhVal.toFixed(1) + ' km/h';
  }

  let weatherDataCache = null;
  let lastFetchedPos = null;
  let isFetching = false;

  // Detail-Modal Container
  const modalCard = document.createElement('div');
  modalCard.className = 'bn-weather-modal-card';
  modalCard.innerHTML = `
    <div class="bn-weather-drag-handle"></div>
    <div class="bn-weather-head">
      <h3>Wetterbericht</h3>
      <button class="bn-weather-close-btn" aria-label="Schließen">✕</button>
    </div>
    <div class="bn-weather-body" id="bn-weather-body-content">
      <div style="text-align:center; padding:20px; color:var(--bn-fg-dim);">Lade Wetterdaten…</div>
    </div>
  `;
  document.body.appendChild(modalCard);

  const closeBtn = modalCard.querySelector('.bn-weather-close-btn');
  closeBtn.addEventListener('click', closeWeatherModal);

  function openWeatherModal() {
    modalCard.classList.add('bn-show');
    renderDetailedModalContent();
  }

  function closeWeatherModal() {
    modalCard.classList.remove('bn-show');
    modalCard.style.transform = '';
  }

  // Touch Swipe-Down Wegwischen
  let startY = 0;
  let currentY = 0;

  modalCard.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  modalCard.addEventListener('touchmove', (e) => {
    currentY = e.touches[0].clientY;
    const diff = currentY - startY;
    if (diff > 0) {
      modalCard.style.transform = `translateY(${diff}px)`;
    }
  }, { passive: true });

  modalCard.addEventListener('touchend', () => {
    if (currentY - startY > 80) {
      closeWeatherModal();
    } else {
      modalCard.style.transform = '';
    }
    startY = 0;
    currentY = 0;
  });

  // Pill Widget oben rechts
  const pillElem = document.createElement('div');
  pillElem.className = 'bn-weather-pill';
  pillElem.title = 'Wetterbericht öffnen';
  pillElem.innerHTML = `<span>🌤️ --.- °C</span>`;
  pillElem.addEventListener('click', openWeatherModal);

  Navi.addOverlayWidget('weather-pill', pillElem);

  function updatePillDisplay() {
    const unit = Navi.getState().speedUnit;
    if (!weatherDataCache || !weatherDataCache.current) {
      pillElem.innerHTML = `<span>🌤️ --.- °C</span>`;
      return;
    }
    const cur = weatherDataCache.current;
    const meta = getWeatherMeta(cur.weather_code);
    const speedStr = formatSpeedValue(cur.wind_speed_10m, unit);
    pillElem.innerHTML = `<span>${meta.icon} ${cur.temperature_2m.toFixed(1)}°C · ${speedStr}</span>`;
  }

  function renderDetailedModalContent() {
    const body = document.getElementById('bn-weather-body-content');
    if (!body) return;

    if (!weatherDataCache) {
      body.innerHTML = `<div style="text-align:center; padding:20px; color:var(--bn-fg-dim);">Keine Wetterdaten verfügbar. GPS aktivieren.</div>`;
      return;
    }

    const unit = Navi.getState().speedUnit;
    const cur = weatherDataCache.current;
    const meta = getWeatherMeta(cur.weather_code);
    const hourly = weatherDataCache.hourly;
    const daily = weatherDataCache.daily;

    // 1. Heute / Aktuell
    const windSpeedStr = formatSpeedValue(cur.wind_speed_10m, unit);
    const windGustStr = formatSpeedValue(cur.wind_gusts_10m, unit);
    const windDirStr = getWindDirText(cur.wind_direction_10m);

    let html = `
      <div>
        <div class="bn-weather-section-title">Aktuelles Wetter</div>
        <div class="bn-weather-today-grid">
          <div class="bn-weather-today-icon">${meta.icon}</div>
          <div>
            <div class="bn-weather-today-temp">${cur.temperature_2m.toFixed(1)} °C</div>
            <div style="font-weight:600; color:var(--bn-fg); font-size:13px;">${meta.text}</div>
          </div>
        </div>
      </div>

      <div class="bn-weather-details-grid">
        <div>Gefühlt: <strong>${cur.apparent_temperature.toFixed(1)} °C</strong></div>
        <div>Bewölkung: <strong>${cur.cloud_cover}%</strong></div>
        <div>Feuchte: <strong>${cur.relative_humidity_2m}%</strong></div>
        <div>Wind: <strong>${windSpeedStr}</strong></div>
        <div>Windrichtung: <strong>${windDirStr} (${cur.wind_direction_10m}°)</strong></div>
        <div>Böen: <strong>${windGustStr}</strong></div>
      </div>
    `;

    // 2. 24-Stunden Vorhersage
    if (hourly && hourly.time) {
      html += `
        <div>
          <div class="bn-weather-section-title">24-Stunden Vorhersage</div>
          <div class="bn-weather-hourly-scroll">
      `;

      const nowIndex = new Date().getHours();
      for (let i = nowIndex; i < Math.min(nowIndex + 24, hourly.time.length); i++) {
        const timeStr = new Date(hourly.time[i]).getHours().toString().padStart(2, '0') + ':00';
        const hMeta = getWeatherMeta(hourly.weather_code[i]);
        const hSpeed = formatSpeedValue(hourly.wind_speed_10m[i], unit);
        const hRainProb = hourly.precipitation_probability[i];

        html += `
          <div class="bn-weather-hourly-item">
            <span class="bn-time">${timeStr}</span>
            <span class="bn-icon" title="${hMeta.text}">${hMeta.icon}</span>
            <span class="bn-temp">${hourly.temperature_2m[i].toFixed(1)}°</span>
            <span class="bn-sub">💧 ${hRainProb}%</span>
            <span class="bn-sub">💨 ${hSpeed}</span>
          </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    }

    // 3. 7-Tage Vorhersage
    if (daily && daily.time) {
      html += `
        <div>
          <div class="bn-weather-section-title">7-Tage Vorhersage</div>
          <div class="bn-weather-daily-list">
      `;

      const daysOfWeek = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

      for (let i = 0; i < Math.min(7, daily.time.length); i++) {
        const dDate = new Date(daily.time[i]);
        const dayName = i === 0 ? 'Heute' : daysOfWeek[dDate.getDay()];
        const dMeta = getWeatherMeta(daily.weather_code[i]);
        const dMax = daily.temperature_2m_max[i].toFixed(1);
        const dMin = daily.temperature_2m_min[i].toFixed(1);
        const dRain = daily.precipitation_sum[i].toFixed(1);
        const dWind = formatSpeedValue(daily.wind_speed_10m_max[i], unit);
        const dGust = formatSpeedValue(daily.wind_gusts_10m_max[i], unit);

        html += `
          <div class="bn-weather-daily-item" onclick="this.classList.toggle('bn-expanded')">
            <div class="bn-weather-daily-main">
              <span class="bn-day">${dayName}</span>
              <span style="font-size:16px;">${dMeta.icon}</span>
              <div class="bn-stats">
                <div><strong>${dMax}°</strong> / ${dMin}°</div>
                <div style="color:var(--bn-fg-faint); font-size:9.5px;">💧${dRain}mm · 💨${dWind} (Böen ${dGust})</div>
              </div>
            </div>
            <div class="bn-weather-daily-extra">
              <strong>Wetterlage:</strong> ${dMeta.text}
            </div>
          </div>
        `;
      }

      html += `
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async function fetchWeatherData(lat, lon) {
    if (isFetching) return;
    isFetching = true;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,cloud_cover,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Wetter-API Fehler');
      const data = await res.json();
      weatherDataCache = data;
      lastFetchedPos = { lat, lon, time: Date.now() };
      updatePillDisplay();
      if (modalCard.classList.contains('bn-show')) {
        renderDetailedModalContent();
      }
    } catch (e) {
      console.warn('Wetter konnte nicht geladen werden:', e);
    } finally {
      isFetching = false;
    }
  }

  function checkAndFetchWeather(pos) {
    if (!pos) return;
    if (!lastFetchedPos) {
      fetchWeatherData(pos.lat, pos.lon);
      return;
    }
    const distMeters = haversineDist(lastFetchedPos.lat, lastFetchedPos.lon, pos.lat, pos.lon);
    const expired = (Date.now() - lastFetchedPos.time) > 15 * 60 * 1000;
    if (distMeters > 2000 || expired) {
      fetchWeatherData(pos.lat, pos.lon);
    }
  }

  function haversineDist(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // GPS & Einheiten-Eventlistener
  Navi.onPositionUpdate((pos) => {
    checkAndFetchWeather(pos);
  });

  // Überwachung der Geschwindigkeits-Einheiten
  let currentUnit = Navi.getState().speedUnit;
  setInterval(() => {
    const newUnit = Navi.getState().speedUnit;
    if (newUnit !== currentUnit) {
      currentUnit = newUnit;
      updatePillDisplay();
      if (modalCard.classList.contains('bn-show')) {
        renderDetailedModalContent();
      }
    }
  }, 300);

  // Registrierung im Core
  Navi.registerModule({
    id: 'weather-service',
    name: 'Wetterdienst',
    description: 'Wetter, 24-Stunden- & 7-Tage-Vorhersage',
    icon: '🌤️',
    onOpen: () => {
      openWeatherModal();
      Navi.closeSidebar();
    }
  });

  // Initiale Daten laden falls Position vorhanden
  const lastPos = Navi.getLastPosition();
  if (lastPos) {
    checkAndFetchWeather(lastPos);
  }

})();
