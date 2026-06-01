const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const plain = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

const MONTHS_DE = {
    januar: '01', februar: '02', märz: '03', maerz: '03', april: '04', mai: '05', juni: '06',
    juli: '07', august: '08', september: '09', oktober: '10', november: '11', dezember: '12'
};

const BERLIN_CENTER = [52.52, 13.405];
const RENDER_API_BASE = 'https://bagatelle-api.onrender.com';

function getApiBase() {
    const configured = window.BAGATELLE_ZVG_API_BASE;
    if (typeof configured === 'string') return configured.replace(/\/$/, '');

    const { hostname, origin, protocol } = window.location;
    const localHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
    if (protocol === 'file:') return 'http://localhost:8000';
    if (localHosts.has(hostname)) return origin;
    if (hostname.endsWith('.onrender.com')) return origin;
    return RENDER_API_BASE;
}

const API_BASE = getApiBase();

function apiUrl(path) {
    return `${API_BASE}${path}`;
}

function parseLocaleNumber(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return 0;
    return parseFloat(raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
}

function formatPlainMoney(value) {
    const parsed = parseLocaleNumber(value);
    return parsed ? plain.format(parsed) : '';
}

let zvgOptions = { lands: [], courts: {}, objectTypes: [] };
let currentItems = [];
let mapResizeFrame = null;
let zvgMap = null;
let zvgMarkerGroup = null;
let zvgMarkers = new Map();
let mapResizeObserver = null;

function syncMapHeight() {
    if (mapResizeFrame) cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => {
        const layout = document.querySelector('.zvg-results-layout');
        if (!layout) return;
        const top = layout.getBoundingClientRect().top;
        const bottomGutter = window.innerWidth <= 1180 ? 24 : 18;
        const available = Math.max(420, window.innerHeight - top - bottomGutter);
        document.documentElement.style.setProperty('--zvg-map-height', `${Math.round(available)}px`);
        if (zvgMap) zvgMap.invalidateSize({ pan: false });
    });
}

function option(label, value) {
    const el = document.createElement('option');
    el.value = value;
    el.textContent = label;
    return el;
}

function setStatus(text, tone = 'muted') {
    const el = $('zvgStatus');
    el.textContent = text;
    el.className = tone === 'error' ? 'text-xs text-red-600 font-semibold' : 'text-xs text-gray-500';
}

function explainFetchError(err) {
    if (err instanceof TypeError && window.location.protocol === 'file:') {
        return '无法连接本地 API。请先运行 python server.py，然后打开 http://localhost:8000/pages/zwangsversteigerung.html。';
    }
    if (err instanceof TypeError) {
        return `无法连接 ZVG API（${API_BASE}）。如果 Render Free 正在冷启动，请稍等一分钟后重试。`;
    }
    return err.message;
}

async function loadOptions() {
    setStatus('正在加载 ZVG 筛选项…');
    const res = await fetch(apiUrl('/api/zvg/options'));
    if (!res.ok) throw new Error('筛选项加载失败');
    zvgOptions = await res.json();

    const land = $('zvgLand');
    land.innerHTML = '';
    zvgOptions.lands.forEach(item => land.appendChild(option(item.label, item.value)));
    land.value = 'be';

    const object = $('zvgObject');
    object.innerHTML = '';
    object.appendChild(option('Alle Objektarten', ''));
    zvgOptions.objectTypes.forEach(item => object.appendChild(option(item.label, item.value)));

    populateCourts();
    setStatus('筛选项已加载。默认显示 Berlin 全部 Amtsgerichte。');
}

function populateCourts() {
    const court = $('zvgCourt');
    const selectedLand = $('zvgLand').value;
    court.innerHTML = '';
    (zvgOptions.courts[selectedLand] || [{ value: '0', label: 'Alle Amtsgerichte' }]).forEach(item => {
        if (item.value || item.label) court.appendChild(option(item.label, item.value));
    });
    if ([...court.options].some(opt => opt.value === '0')) court.value = '0';
}

function escapeHtml(str = '') {
    return String(str).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function infoValue(value) {
    return value ? escapeHtml(value) : '—';
}

function badgeClass(type = '') {
    const text = String(type).toLowerCase();
    if (text.includes('eigentumswohnung')) return 'zvg-badge-apartment';
    if (text.includes('haus') || text.includes('haushälfte')) return 'zvg-badge-house';
    if (text.includes('grundstück')) return 'zvg-badge-land';
    if (text.includes('gewerbe') || text.includes('geschäft') || text.includes('teileigentum') || text.includes('stellplatz')) return 'zvg-badge-commercial';
    return 'zvg-badge-other';
}

function formatTerminDate(termin = '') {
    const match = String(termin).match(/(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+)\s+(\d{4})/);
    if (!match) return termin ? escapeHtml(termin) : '—';
    const day = match[1].padStart(2, '0');
    const month = MONTHS_DE[match[2].toLowerCase()] || '??';
    return `${match[3]}.${month}.${day}`;
}

function setActiveItem(id) {
    document.querySelectorAll('.zvg-card').forEach(card => card.classList.toggle('is-active', card.dataset.zvgId === id));
    zvgMarkers.forEach((marker, markerId) => {
        const el = marker.getElement();
        if (el) el.classList.toggle('is-active', markerId === id);
        marker.setZIndexOffset(markerId === id ? 1000 : 0);
    });
}

function initMap() {
    if (zvgMap || !window.L || !$('zvgMap')) return Boolean(zvgMap);
    zvgMap = L.map('zvgMap', {
        center: BERLIN_CENTER,
        zoom: 11,
        scrollWheelZoom: true,
        zoomControl: true,
        tap: true
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(zvgMap);
    zvgMarkerGroup = L.featureGroup().addTo(zvgMap);
    mapResizeObserver = new ResizeObserver(() => zvgMap.invalidateSize({ pan: false }));
    mapResizeObserver.observe($('zvgMap'));
    zvgMap.whenReady(() => {
        zvgMap.invalidateSize({ pan: false });
        setTimeout(() => zvgMap.invalidateSize({ pan: false }), 160);
    });
    return true;
}

function popupHtml(item, index) {
    const price = item.price ? euro.format(item.price) : escapeHtml(item.priceText || '—');
    const links = [
        item.detailUrl ? `<a class="text-[#234e9c] font-bold hover:underline" href="${apiUrl(item.detailUrl)}" target="_blank" rel="noreferrer">Detail</a>` : '',
        item.exposePdfUrl ? `<a class="text-[#234e9c] font-bold hover:underline" href="${apiUrl(item.exposePdfUrl)}" target="_blank">Exposee</a>` : ''
    ].filter(Boolean).join(' · ');
    return `
        <div class="zvg-map-infobox">
            <div class="zvg-map-popup-index">${index + 1}</div>
            <div class="zvg-badge ${badgeClass(item.objectType)} mb-2">${escapeHtml(item.objectType || 'Objekt')}</div>
            <div class="zvg-map-popup-title">${escapeHtml(item.address || 'Adresse nicht angegeben')}</div>
            <div class="zvg-map-popup-price">${price}</div>
            <dl class="contents">
                <div class="zvg-map-popup-row"><dt>Gericht</dt><dd>${escapeHtml(item.court || '—')}</dd></div>
                <div class="zvg-map-popup-row"><dt>Az.</dt><dd>${escapeHtml(item.caseNo || '—')}</dd></div>
                <div class="zvg-map-popup-row"><dt>Termin</dt><dd>${formatTerminDate(item.termin)}</dd></div>
                <div class="zvg-map-popup-row"><dt>Fläche</dt><dd>${infoValue(item.area)}</dd></div>
                <div class="zvg-map-popup-row"><dt>Baujahr</dt><dd>${infoValue(item.baujahr)}</dd></div>
            </dl>
            <div class="zvg-map-popup-links text-xs">${links || '—'}</div>
        </div>`;
}

function openMapInfo(item, index, marker) {
    if (!zvgMap || !marker) return;
    setActiveItem(item.zvgId);
    marker.openPopup();
    const card = document.querySelector(`.zvg-card[data-zvg-id="${CSS.escape(item.zvgId)}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderMap(items) {
    syncMapHeight();
    const ok = initMap();
    if (!ok || !zvgMap || !zvgMarkerGroup) return;
    zvgMarkerGroup.clearLayers();
    zvgMarkers.clear();
    const bounds = [];
    items.forEach((item, index) => {
        if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
        const icon = L.divIcon({
            className: '',
            html: `<div class="zvg-marker" data-zvg-id="${escapeHtml(item.zvgId)}" title="${escapeHtml(item.address || item.caseNo)}">${index + 1}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
            popupAnchor: [0, -18]
        });
        const marker = L.marker([item.lat, item.lon], { icon })
            .bindPopup(popupHtml(item, index), { className: 'zvg-map-popup', maxWidth: 290 })
            .on('click', () => openMapInfo(item, index, marker))
            .on('mouseover', () => setActiveItem(item.zvgId));
        zvgMarkerGroup.addLayer(marker);
        zvgMarkers.set(item.zvgId, marker);
        bounds.push([item.lat, item.lon]);
    });
    if (bounds.length) {
        zvgMap.fitBounds(bounds, { padding: [34, 34], maxZoom: 14 });
    } else {
        zvgMap.setView(BERLIN_CENTER, 11);
    }
    requestAnimationFrame(() => {
        zvgMap.invalidateSize({ pan: false });
        if (bounds.length) zvgMap.fitBounds(bounds, { padding: [34, 34], maxZoom: 14 });
    });
}

function renderCard(item, index) {
    const price = item.price ? euro.format(item.price) : escapeHtml(item.priceText || '—');
    const image = item.thumbnailUrl
        ? `<img loading="lazy" src="${apiUrl(item.thumbnailUrl)}" alt="Expose/Fotos ${escapeHtml(item.caseNo)}" onerror="this.parentElement.innerHTML='<span>NO PREVIEW</span>'">`
        : '<span>NO EXPOSÉ</span>';
    const links = [
        item.detailUrl ? `<a class="text-[#234e9c] font-bold hover:underline" href="${apiUrl(item.detailUrl)}" target="_blank" rel="noreferrer">Detail</a>` : '',
        item.exposePdfUrl ? `<a class="text-[#234e9c] font-bold hover:underline" href="${apiUrl(item.exposePdfUrl)}" target="_blank">Exposee</a>` : ''
    ].filter(Boolean).join(' · ');

    return `
        <article class="zvg-card" data-zvg-id="${escapeHtml(item.zvgId)}">
            <div class="zvg-thumb">${image}</div>
            <div class="zvg-card-body p-4 space-y-2.5">
                <div class="zvg-card-index">${index + 1}</div>
                <div class="flex items-start justify-between gap-2 min-h-[30px]">
                    <span class="zvg-badge ${badgeClass(item.objectType)} max-w-[calc(100%-38px)]">${escapeHtml(item.objectType || 'Objekt')}</span>
                    <span class="zvg-meta font-bold whitespace-nowrap">${formatTerminDate(item.termin)}</span>
                </div>
                <div class="min-h-[70px]">
                    <h3 class="font-black text-[#18212f] leading-snug text-sm line-clamp-3">${escapeHtml(item.address || 'Adresse nicht angegeben')}</h3>
                    <p class="zvg-meta mt-1 truncate">${escapeHtml(item.court || '')} · Az. ${escapeHtml(item.caseNo || '')}</p>
                </div>
                <div class="zvg-price">${price}</div>
                <dl class="grid grid-cols-2 gap-2 text-[11px]">
                    <div class="rounded-xl bg-white/70 p-2"><dt class="text-gray-400 font-bold">Baujahr</dt><dd class="font-black text-[#18212f] truncate">${infoValue(item.baujahr)}</dd></div>
                    <div class="rounded-xl bg-white/70 p-2"><dt class="text-gray-400 font-bold">Fläche</dt><dd class="font-black text-[#18212f] truncate">${infoValue(item.area)}</dd></div>
                    <div class="rounded-xl bg-white/70 p-2"><dt class="text-gray-400 font-bold">Zimmer</dt><dd class="font-black text-[#18212f] truncate">${infoValue(item.rooms)}</dd></div>
                    <div class="rounded-xl bg-white/70 p-2"><dt class="text-gray-400 font-bold">Etage</dt><dd class="font-black text-[#18212f] truncate">${infoValue(item.floor)}</dd></div>
                </dl>
                <div class="zvg-card-links text-xs pt-1">${links}</div>
            </div>
        </article>`;
}

function bindCardMapLinks() {
    document.querySelectorAll('.zvg-card').forEach(card => {
        const id = card.dataset.zvgId;
        card.addEventListener('mouseenter', () => setActiveItem(id));
        card.addEventListener('focusin', () => setActiveItem(id));
        card.addEventListener('click', event => {
            if (event.target.closest('a')) return;
            setActiveItem(id);
            const marker = zvgMarkers.get(id);
            if (marker && zvgMap) {
                zvgMap.panTo(marker.getLatLng());
                const item = currentItems.find(entry => entry.zvgId === id);
                if (item) openMapInfo(item, currentItems.indexOf(item), marker);
            }
        });
    });
}

async function searchZvg() {
    const grid = $('zvgGrid');
    const empty = $('zvgEmpty');
    grid.innerHTML = '';
    empty.classList.add('hidden');
    const searchLabel = document.querySelector('#zvgSearch .zvg-search-label');
    $('zvgSearch').disabled = true;
    if (searchLabel) searchLabel.textContent = '抓取中…';
    setStatus('正在从 zvg-portal.de 抓取结果与地图坐标…');
    try {
        const params = new URLSearchParams({
            land_abk: $('zvgLand').value,
            ger_id: $('zvgCourt').value,
            obj_liste: $('zvgObject').value,
            max_price: parseLocaleNumber($('zvgMaxPrice').value) || ''
        });
        const res = await fetch(apiUrl(`/api/zvg/search?${params}`));
        const payload = await res.json();
        if (!res.ok || payload.error) throw new Error(payload.error || '搜索失败');
        currentItems = payload.items || [];
        grid.innerHTML = currentItems.map(renderCard).join('');
        bindCardMapLinks();
        renderMap(currentItems);
        empty.classList.toggle('hidden', currentItems.length > 0);
        const mapped = currentItems.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon)).length;
        const missing = currentItems.length - mapped;
        setStatus(`已加载 ${currentItems.length} 个项目，地图标注 ${mapped} 个${missing ? `，${missing} 个缺少可靠坐标` : ''}。`);
    } catch (err) {
        console.error(err);
        setStatus(`抓取失败：${explainFetchError(err)}`, 'error');
    } finally {
        $('zvgSearch').disabled = false;
        if (searchLabel) searchLabel.textContent = '搜索 Termine';
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    syncMapHeight();
    initMap();
    window.addEventListener('resize', syncMapHeight, { passive: true });
    window.addEventListener('orientationchange', syncMapHeight, { passive: true });
    $('zvgLand').addEventListener('change', () => { populateCourts(); searchZvg(); });
    $('zvgCourt').addEventListener('change', searchZvg);
    $('zvgObject').addEventListener('change', searchZvg);
    $('zvgMaxPrice').addEventListener('change', searchZvg);
    $('zvgMaxPrice').addEventListener('input', () => { $('zvgMaxPrice').value = formatPlainMoney($('zvgMaxPrice').value); });
    $('zvgSearch').addEventListener('click', searchZvg);
    try {
        await loadOptions();
        await searchZvg();
    } catch (err) {
        setStatus(`初始化失败：${explainFetchError(err)}`, 'error');
    }
});
