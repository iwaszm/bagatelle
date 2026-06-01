#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from bs4 import BeautifulSoup

BASE = Path(__file__).resolve().parent
CACHE = BASE / '.cache' / 'zvg'
GEOCODE_CACHE = CACHE / 'geocode'
CACHE.mkdir(parents=True, exist_ok=True)
GEOCODE_CACHE.mkdir(parents=True, exist_ok=True)
ZVG = 'https://www.zvg-portal.de/index.php'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Bagatelle-ZVG/1.0'
TTL = 60 * 15

session = requests.Session()
session.verify = False
session.headers.update({'User-Agent': UA})
requests.packages.urllib3.disable_warnings()  # local personal tool; zvg cert chain may fail on this host

LAND_NAMES = {
    'bw': 'Baden-Württemberg', 'by': 'Bayern', 'be': 'Berlin', 'br': 'Brandenburg',
    'hb': 'Bremen', 'hh': 'Hamburg', 'he': 'Hessen', 'mv': 'Mecklenburg-Vorpommern',
    'ni': 'Niedersachsen', 'nw': 'Nordrhein-Westfalen', 'rp': 'Rheinland-Pfalz',
    'sl': 'Saarland', 'sn': 'Sachsen', 'st': 'Sachsen-Anhalt', 'sh': 'Schleswig-Holstein',
    'th': 'Thüringen'
}


def clean(text):
    return re.sub(r'\s+', ' ', BeautifulSoup(str(text or ''), 'html.parser').get_text(' ', strip=True)).strip()


def folded(text):
    return (text or '').lower().replace('é', 'e').replace('è', 'e').replace('ê', 'e')


def normalize_object_label(label):
    text = clean(label)
    text = re.sub(r'\s*\([^)]*\)\s*', ' ', text).strip()
    if folded(text).startswith('eigentumswohnung'):
        return 'Eigentumswohnung'
    return text


def normalize_object_types(object_types):
    grouped = []
    eig_values = []
    for item in object_types:
        label = normalize_object_label(item.get('label', ''))
        value = item.get('value', '')
        if label == 'Eigentumswohnung':
            if value:
                eig_values.append(value)
            continue
        grouped.append({'value': value, 'label': label})
    if eig_values:
        grouped.insert(0, {'value': ','.join(eig_values), 'label': 'Eigentumswohnung'})
    return grouped


def geocode_candidates(address):
    text = clean(address)
    if not text:
        return []
    candidates = [text]
    postal = re.search(r'\b(\d{5})\s+Berlin\b', text, re.I)
    city = f'{postal.group(1)} Berlin' if postal else 'Berlin'
    first_part = text.split(',')[0].strip()
    if '/' in first_part:
        candidates.append(first_part.split('/')[0].strip() + ', ' + city)
    if first_part:
        candidates.append(first_part + ', ' + city)
    street_house = re.match(r'^(.+?\s+\d+\s*[A-Za-z]?)\b', text)
    if street_house:
        candidates.append(street_house.group(1).strip() + ', ' + city)
    # Preserve order, remove duplicates/noise.
    result = []
    seen = set()
    for candidate in candidates:
        candidate = re.sub(r'\s+', ' ', candidate).strip(' ,')
        key = folded(candidate)
        if candidate and key not in seen:
            result.append(candidate)
            seen.add(key)
    return result


def json_response(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def text_response(handler, text, status=200):
    body = text.encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'text/plain; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def fetch_html(params=None, method='get', data=None):
    if method == 'post':
        r = session.post(ZVG, params=params, data=data, timeout=30, headers={'Referer': ZVG})
    else:
        r = session.get(ZVG, params=params, timeout=30, headers={'Referer': ZVG})
    # The portal still declares old XHTML/ISO in places, but current payload bytes are UTF-8.
    r.encoding = 'utf-8'
    r.raise_for_status()
    return r.text


def get_options():
    cache_file = CACHE / 'options.json'
    if cache_file.exists() and time.time() - cache_file.stat().st_mtime < 86400:
        try:
            cached = json.loads(cache_file.read_text(encoding='utf-8'))
            cached['objectTypes'] = normalize_object_types(cached.get('objectTypes', []))
            return cached
        except (OSError, json.JSONDecodeError):
            cache_file.unlink(missing_ok=True)

    html = fetch_html({'button': 'Termine suchen'})
    soup = BeautifulSoup(html, 'html.parser')

    lands = []
    land_select = soup.find('select', {'name': 'land_abk'})
    if land_select:
        for opt in land_select.find_all('option'):
            value = opt.get('value') or ''
            if value and value != '0':
                lands.append({'value': value, 'label': LAND_NAMES.get(value, clean(opt))})

    object_types = []
    obj_select = soup.find('select', {'name': 'obj_liste'})
    if obj_select:
        for opt in obj_select.find_all('option'):
            value = opt.get('value') or ''
            if value:
                object_types.append({'value': value, 'label': clean(opt)})

    courts = {}
    text = html
    names = re.findall(r"BundeslandArray\['([^']+)'\]=new Array\((.*?)\);", text, flags=re.S)
    ids = dict(re.findall(r"BundeslandArrayId\['([^']+)'\]=new Array\((.*?)\);", text, flags=re.S))
    for land, raw_names in names:
        if land == '0':
            continue
        labels = re.findall(r"'([^']*)'", raw_names)
        raw_ids = ids.get(land, '')
        values = re.findall(r"'([^']*)'", raw_ids)
        courts[land] = [{'value': '0', 'label': 'Alle Amtsgerichte'}]
        for label, value in zip(labels, values):
            courts[land].append({'value': value, 'label': label.strip()})

    result = {'lands': lands, 'courts': courts, 'objectTypes': normalize_object_types(object_types)}
    cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    return result


def parse_price(text):
    m = re.search(r'(\d{1,3}(?:\.\d{3})*,\d{2}|\d{4,}(?:,\d{2})?)', text or '')
    if not m:
        return None
    return float(m.group(1).replace('.', '').replace(',', '.'))


def parse_results(html, limit=None, enrich=True):
    soup = BeautifulSoup(html, 'html.parser')
    items = []
    for a in soup.find_all('a', href=re.compile(r'button=showZvg')):
        href = a.get('href') or ''
        q = parse_qs(urlparse(href.replace('index.php', '')).query)
        zvg_id = (q.get('zvg_id') or [''])[0]
        land = (q.get('land_abk') or [''])[0]
        if not zvg_id:
            continue
        row = a.find_parent('tr')
        if not row:
            continue
        rows = []
        cur = row
        while cur:
            rows.append(cur)
            if cur.find('hr') and cur is not row:
                break
            cur = cur.find_next_sibling('tr')
        update = ''
        tds = row.find_all('td')
        if len(tds) >= 3:
            update = clean(tds[-1]).replace('(letzte Aktualisierung ', '').replace(')', '')
        item = {
            'zvgId': zvg_id,
            'land': land,
            'caseNo': clean(a).replace('(Detailansicht)', '').strip(),
            'updated': update,
            'detailUrl': '/api/zvg/detail?' + urlencode({'land_abk': land, 'zvg_id': zvg_id}),
            'officialPdfUrl': '',
            'exposePdfUrl': '',
            'thumbnailUrl': ''
        }
        for r in rows[1:]:
            cells = r.find_all('td')
            if len(cells) < 2:
                continue
            label = clean(cells[0])
            value_cell = cells[1]
            value = clean(value_cell)
            if 'Amtsgericht' in label:
                item['court'] = value
            elif 'Objekt/Lage' in label:
                bold = value_cell.find('b')
                raw_object_type = clean(bold).replace(':', '').strip() if bold else ''
                item['objectType'] = normalize_object_label(raw_object_type)
                address = clean(value_cell)
                if raw_object_type:
                    address = address.replace(raw_object_type, '', 1)
                address = re.sub(r'^\s*[:：]\s*', '', address).strip()
                item['address'] = address
            elif 'Verkehrswert' in label:
                item['priceText'] = value
                item['price'] = parse_price(value)
            elif 'Termin' in label:
                item['termin'] = value
            link = r.find('a', href=re.compile('showAnhang'))
            if link and 'Amtliche' in clean(link):
                item['officialPdfUrl'] = '/api/zvg/pdf?' + urlencode({'land_abk': land, 'zvg_id': zvg_id, **{k: parse_qs(urlparse(link.get('href')).query).get(k, [''])[0] for k in ['file_id']}})
        if enrich:
            try:
                enrich_detail(item)
            except Exception as exc:
                item['detailError'] = str(exc)
        items.append(item)
        if limit and len(items) >= limit:
            break
    return items


def geocode_address(address):
    if not address:
        return None
    key = re.sub(r'[^a-zA-Z0-9]+', '_', address.lower()).strip('_')[:120]
    cache_file = GEOCODE_CACHE / f'{key}.json'
    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding='utf-8'))
        if data:
            return data
    for candidate in geocode_candidates(address):
        candidate_key = re.sub(r'[^a-zA-Z0-9]+', '_', candidate.lower()).strip('_')[:120]
        candidate_cache = GEOCODE_CACHE / f'{candidate_key}.json'
        if candidate_cache.exists():
            data = json.loads(candidate_cache.read_text(encoding='utf-8'))
            if data:
                cache_file.write_text(json.dumps(data), encoding='utf-8')
                return data
            continue
        try:
            r = session.get(
                'https://nominatim.openstreetmap.org/search',
                params={'format': 'jsonv2', 'limit': 1, 'q': candidate},
                timeout=12,
                headers={'User-Agent': UA, 'Referer': 'http://localhost:8000/pages/zwangsversteigerung.html'}
            )
            r.raise_for_status()
            results = r.json()
            if results:
                data = {'lat': float(results[0]['lat']), 'lon': float(results[0]['lon']), 'geocodeQuery': candidate}
                candidate_cache.write_text(json.dumps(data), encoding='utf-8')
                cache_file.write_text(json.dumps(data), encoding='utf-8')
                time.sleep(1.05)  # Nominatim public usage policy: keep requests modest.
                return data
            candidate_cache.write_text('{}', encoding='utf-8')
            time.sleep(1.05)  # Nominatim public usage policy: keep requests modest.
        except Exception:
            candidate_cache.write_text('{}', encoding='utf-8')
    cache_file.write_text('{}', encoding='utf-8')
    return None


def extract_property_facts(text):
    compact = clean(text)
    facts = {}
    baujahr = re.search(r'\b(?:Baujahr|Bj\.?|erbaut(?:\s+im\s+Jahr)?|errichtet(?:\s+ca\.)?)\s*[:\s]*(?:ca\.?\s*)?(\d{4})\b', compact, re.I)
    if baujahr:
        facts['baujahr'] = baujahr.group(1)
    area = re.search(r'(\d{1,4}(?:[,.]\d{1,2})?)\s*(?:m²|qm|m2)\s*(?:Wohnfläche|Wohnfl\.|Wfl\.|Nutzfläche|Grundstücksfläche|groß|Wohn-/Nutzfläche)?', compact, re.I)
    if not area:
        area = re.search(r'(?:Wohnfläche|Wohnfl\.|Wfl\.|Nutzfläche|Wohn-/Nutzfläche)\s*(?:von|ca\.|:)?\s*(\d{1,4}(?:[,.]\d{1,2})?)\s*(?:m²|qm|m2)', compact, re.I)
    if area:
        facts['area'] = area.group(1).replace('.', ',') + ' m²'
    rooms = re.search(r'(\d+(?:[,.]\d+)?)\s*[- ]?Zimmer', compact, re.I)
    if rooms:
        facts['rooms'] = rooms.group(1).replace('.', ',')
    floor = re.search(r'((?:\d+\.\s*)?(?:Obergeschoss|Dachgeschoss|Erdgeschoss|Untergeschoss|Souterrain|Etage|Stockwerk))', compact, re.I)
    if floor:
        facts['floor'] = floor.group(1)
    return facts


def enrich_detail(item):
    html = fetch_html({'button': 'showZvg', 'zvg_id': item['zvgId'], 'land_abk': item['land']})
    soup = BeautifulSoup(html, 'html.parser')
    text = soup.get_text('\n', strip=True)
    court = re.search(r'Amtsgericht:\s*(.*?)\s*Termine suchen', text, flags=re.S)
    if court:
        item['court'] = clean(court.group(1))
    desc = re.search(r'Beschreibung:\s*(.*?)\s*Verkehrswert', text, flags=re.S)
    item.update(extract_property_facts(desc.group(1) if desc else text))
    coords = geocode_address(item.get('address'))
    if coords:
        item.update(coords)
    for a in soup.find_all('a', href=re.compile('showAnhang')):
        label = clean(a.find_parent('tr'))
        tr = a.find_parent('tr')
        cells = tr.find_all('td') if tr else []
        attachment_kind = clean(cells[0]) if cells else ''
        attachment_name = clean(cells[1]) if len(cells) > 1 else clean(a.find_previous('td'))
        href = a.get('href') or ''
        q = parse_qs(urlparse(href).query)
        file_id = (q.get('file_id') or [''])[0]
        if not file_id:
            continue
        pdf_url = '/api/zvg/pdf?' + urlencode({'land_abk': item['land'], 'zvg_id': item['zvgId'], 'file_id': file_id})
        low_kind = folded(attachment_kind)
        low_name = folded(attachment_name)
        low = folded(f'{attachment_kind} {attachment_name} {label}')
        is_official = 'amtliche bekanntmachung' in low or 'amtliche_bekanntmachung' in low_name
        is_expose = not is_official and re.search(r'\bexpos(?:e|ee)\b', low)
        is_photo = low_kind.startswith('foto') or low_name.startswith('foto')
        if is_official and not item.get('officialPdfUrl'):
            item['officialPdfUrl'] = pdf_url
        elif is_expose and not item.get('exposePdfUrl'):
            item['exposePdfUrl'] = pdf_url
            item['thumbnailUrl'] = '/api/zvg/thumb?' + urlencode({'land_abk': item['land'], 'zvg_id': item['zvgId'], 'file_id': file_id})
        elif is_photo and not item.get('thumbnailUrl'):
            item['thumbnailUrl'] = '/api/zvg/thumb?' + urlencode({'land_abk': item['land'], 'zvg_id': item['zvgId'], 'file_id': file_id})
    return item


def search(params):
    land = params.get('land_abk', ['be'])[0] or 'be'
    court = params.get('ger_id', ['0'])[0] or '0'
    raw_objects = params.get('obj_liste', [''])[0]
    objects = [o for o in raw_objects.split(',') if o]
    if not objects:
        objects = []
        for item in get_options().get('objectTypes', []):
            objects.extend([value for value in str(item.get('value', '')).split(',') if value])
        if not objects:
            objects = ['']
    try:
        max_price = float(params.get('max_price', [''])[0] or 0)
    except ValueError:
        max_price = 0

    seen = set()
    merged = []
    max_results = 120  # safety guard: UI has no count limit, but avoid hammering the public portal.

    for obj in objects:
        for page in range(1, 11):
            data = {
                'ger_name': '', 'order_by': '2', 'land_abk': land, 'ger_id': court,
                'az1': '', 'az2': '', 'az3': '', 'az4': '', 'art': '', 'obj': '',
                'obj_liste': '', 'str': '', 'hnr': '', 'plz': '', 'ort': '', 'ortsteil': '',
                'vtermin': '', 'btermin': '', 'seite': str(page)
            }
            if obj:
                data['obj_arr[]'] = obj
            html = fetch_html({'button': 'Suchen'}, method='post', data=data)
            page_items = parse_results(html, limit=None, enrich=True)
            new_count = 0
            for item in page_items:
                key = item.get('zvgId')
                if key and key not in seen:
                    if max_price and (not item.get('price') or item.get('price') > max_price):
                        continue
                    seen.add(key)
                    merged.append(item)
                    new_count += 1
                    if len(merged) >= max_results:
                        return {'items': merged, 'source': 'zvg-portal.de', 'truncated': True}
            if not page_items or new_count == 0:
                break
    return {'items': merged, 'source': 'zvg-portal.de', 'truncated': False}


def fetch_pdf_bytes(land, zvg_id, file_id):
    r = session.get(ZVG, params={'button': 'showAnhang', 'land_abk': land, 'zvg_id': zvg_id, 'file_id': file_id}, timeout=45,
                    headers={'Referer': f'{ZVG}?button=showZvg&zvg_id={zvg_id}&land_abk={land}'})
    r.raise_for_status()
    return r.content


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def translate_path(self, path):
        # Serve files relative to project dir, not cwd surprises.
        parsed = urlparse(path)
        rel = parsed.path.lstrip('/') or 'index.html'
        return str((BASE / rel).resolve())

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/api/zvg/options':
            try:
                return json_response(self, get_options())
            except Exception as exc:
                return json_response(self, {'error': str(exc)}, 500)
        if parsed.path == '/api/zvg/search':
            try:
                return json_response(self, search(parse_qs(parsed.query)))
            except Exception as exc:
                return json_response(self, {'error': str(exc)}, 500)
        if parsed.path == '/api/zvg/detail':
            q = parse_qs(parsed.query)
            land, zvg_id = q.get('land_abk', [''])[0], q.get('zvg_id', [''])[0]
            html = fetch_html({'button': 'showZvg', 'zvg_id': zvg_id, 'land_abk': land})
            html = html.replace('<head>', '<head><base href="https://www.zvg-portal.de/">', 1)
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == '/api/zvg/pdf':
            q = parse_qs(parsed.query)
            data = fetch_pdf_bytes(q.get('land_abk', [''])[0], q.get('zvg_id', [''])[0], q.get('file_id', [''])[0])
            self.send_response(200)
            self.send_header('Content-Type', 'application/pdf')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if parsed.path == '/api/zvg/thumb':
            q = parse_qs(parsed.query)
            land, zvg_id, file_id = q.get('land_abk', [''])[0], q.get('zvg_id', [''])[0], q.get('file_id', [''])[0]
            if not shutil.which('pdftoppm'):
                return text_response(self, 'NO PREVIEW', 503)
            jpg = CACHE / f'{land}_{zvg_id}_{file_id}.jpg'
            try:
                if not jpg.exists():
                    pdf = fetch_pdf_bytes(land, zvg_id, file_id)
                    with tempfile.TemporaryDirectory() as td:
                        pdf_path = Path(td) / 'doc.pdf'
                        out = Path(td) / 'thumb'
                        pdf_path.write_bytes(pdf)
                        subprocess.run(['pdftoppm', '-f', '1', '-singlefile', '-jpeg', '-scale-to-x', '720', '-scale-to-y', '-1', str(pdf_path), str(out)], check=True, timeout=30)
                        jpg.write_bytes((Path(td) / 'thumb.jpg').read_bytes())
            except Exception as exc:
                return text_response(self, f'NO PREVIEW: {exc}', 503)
            data = jpg.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'image/jpeg')
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print(f'Bagatelle server listening on http://0.0.0.0:{port}')
    server.serve_forever()
