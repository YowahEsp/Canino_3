// scripts/fetch-news.js
//
// Se ejecuta dentro de la GitHub Action (Node 20, sin navegador), así que
// no hay CORS ni hace falta ningún proxy. Las claves llegan como variables
// de entorno (GitHub Secrets) y nunca se escriben en el noticias.json.
//
// Sin dependencias npm: usa fetch nativo (Node 18+) y un parser de RSS/Atom
// propio, para no depender de servicios de terceros como rss2json.

const fs = require('fs');
const path = require('path');

const KEYS = {
  NEWSDATA:   process.env.NEWSDATA_KEY,
  THENEWS:    process.env.THENEWSAPI_KEY,
  CURRENTS:   process.env.CURRENTS_KEY,
  MEDIASTACK: process.env.MEDIASTACK_KEY,
};

// Email opcional para MyMemory: sube el límite diario de traducción de
// ~5.000 a ~50.000 palabras. Si no se define, se traduce igualmente pero
// con el cupo anónimo (y con degradación elegante si se agota).
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';

const RSS_FEEDS = {
  es: 'https://www.srperro.com/rss/',
  en: 'https://www.dogster.com/feed',
};

// Artículos máximos guardados por idioma. El "cargar más" del cliente
// pagina sobre este array ya descargado: no llama a ninguna API en directo.
const MAX_PER_LANG = 80;

// Si tras deduplicar un idioma queda por debajo de este umbral, se completa
// con el RSS (antes era todo-o-nada: solo entraba el RSS con 0 resultados).
const MIN_PER_LANG = 8;

// Páginas por fuente e idioma en cada ejecución.
const PAGES_PER_SOURCE = 3;

// Cuántos artículos EN se pre-traducen en la Action (los más visibles).
// El resto conserva el botón "traducir" bajo demanda en el cliente.
const TRANSLATE_LIMIT = 15;

// ─── Utilidades de texto ──────────────────────────────────────────────
const stripHtml = h => (h || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&[a-z#0-9]+;/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Título normalizado para deduplicar: minúsculas, sin acentos ni signos.
const normTitle = t => (t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Clave de URL para deduplicar entre fuentes (host + ruta, sin query).
const urlKey = u => {
  try {
    const x = new URL(u);
    return (x.hostname + x.pathname).toLowerCase().replace(/\/+$/, '');
  } catch { return (u || '').toLowerCase(); }
};

// Filtro temático con límites de palabra + lista de falsos positivos.
const DOG_RE = /\b(perr[oa]s?|canin[oa]s?|cachorr[oa]s?|mascotas?|dogs?|puppy|puppies|canines?|breeds?|kennels?|pets?|veterinari[oa]s?)\b/i;
const FALSE_POS = /\b(pet project|pet peeve|teacher'?s pet|pet theory)\b/i;
const STRONG_DOG = /\b(perr|canin|cachorr|dog|puppy|puppies|kennel|veterinari)/i;
const isDogRelated = a => {
  const txt = (a.title || '') + ' ' + (a.description || '');
  if (FALSE_POS.test(txt) && !STRONG_DOG.test(txt)) return false;
  return DOG_RE.test(txt);
};

function norm(title, description, url, image, date, sourceName) {
  return {
    title: (title || '').trim(),
    description: stripHtml(description).substring(0, 220),
    url: url || '',
    urlToImage: image || null,
    publishedAt: date || new Date().toISOString(),
    sourceName: sourceName || 'Fuente desconocida',
  };
}

async function safeFetchJson(url, label) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ElCaninoBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`${label}: ${e.message}`);
    return null;
  }
}

async function safeFetchText(url, label) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ElCaninoBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    console.warn(`${label}: ${e.message}`);
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── NEWSDATA.IO — paginación por cursor ──────────────────────────────
async function fetchNewsdata(lang) {
  if (!KEYS.NEWSDATA) return [];
  const q = lang === 'es' ? 'perro canino' : 'dog canine';
  let cursor = null;
  const out = [];
  for (let i = 0; i < PAGES_PER_SOURCE; i++) {
    if (i > 0 && !cursor) break;
    let url = `https://newsdata.io/api/1/news?apikey=${KEYS.NEWSDATA}&q=${encodeURIComponent(q)}&language=${lang}&size=10`;
    if (cursor) url += `&page=${cursor}`;
    const data = await safeFetchJson(url, 'Newsdata');
    if (!data || data.status !== 'success') break;
    out.push(...(data.results || []).map(a =>
      norm(a.title, a.description, a.link, a.image_url, a.pubDate, a.source_id)
    ));
    cursor = data.nextPage || null;
  }
  return out;
}

// ─── THE NEWS API ─────────────────────────────────────────────────────
async function fetchTheNewsAPI(lang) {
  if (!KEYS.THENEWS) return [];
  const q = lang === 'es' ? 'perro canino' : 'dog canine';
  const out = [];
  for (let page = 1; page <= PAGES_PER_SOURCE; page++) {
    const url = `https://api.thenewsapi.com/v1/news/all?api_token=${KEYS.THENEWS}&search=${encodeURIComponent(q)}&language=${lang}&page=${page}&limit=10`;
    const data = await safeFetchJson(url, 'TheNewsAPI');
    if (!data || !Array.isArray(data.data) || data.data.length === 0) break;
    out.push(...data.data.map(a =>
      norm(a.title, a.description, a.url, a.image_url, a.published_at, a.source)
    ));
  }
  return out;
}

// ─── CURRENTS API ─────────────────────────────────────────────────────
async function fetchCurrents(lang) {
  if (!KEYS.CURRENTS) return [];
  const q = lang === 'es' ? 'perro canino' : 'dog canine';
  const out = [];
  for (let page = 1; page <= PAGES_PER_SOURCE; page++) {
    const url = `https://api.currentsapi.services/v1/search?apiKey=${KEYS.CURRENTS}&keywords=${encodeURIComponent(q)}&language=${lang}&page_number=${page}`;
    const data = await safeFetchJson(url, 'Currents');
    if (!data || data.status !== 'ok' || !Array.isArray(data.news) || data.news.length === 0) break;
    out.push(...data.news.map(a =>
      norm(a.title, a.description, a.url, a.image, a.published, a.author || 'Currents')
    ));
  }
  return out;
}

// ─── MEDIASTACK ───────────────────────────────────────────────────────
// Plan gratuito: 100 peticiones AL MES. Con el cron cada 30 min se agota
// en horas, así que solo se llama en una ventana diaria (≈2 peticiones/día
// = ~60/mes, por debajo del cupo). Sin proxy: al Node no le importa el HTTP.
function mediastackWindow() {
  const now = new Date();
  return now.getUTCHours() === 6 && now.getUTCMinutes() < 30;
}
async function fetchMediastack(lang) {
  if (!KEYS.MEDIASTACK || !mediastackWindow()) return [];
  const q = lang === 'es' ? 'perro,canino' : 'dog,canine';
  const url = `http://api.mediastack.com/v1/news?access_key=${KEYS.MEDIASTACK}&keywords=${encodeURIComponent(q)}&languages=${lang}&limit=10`;
  const data = await safeFetchJson(url, 'Mediastack');
  if (!data || data.error || !Array.isArray(data.data)) return [];
  return data.data.map(a => norm(a.title, a.description, a.url, a.image, a.published_at, a.source));
}

// ─── PARSER RSS/ATOM PROPIO (sin dependencias) ────────────────────────
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // amp el último para no romper otras entidades
}

// Extrae el contenido interno de la primera etiqueta <tag ...>...</tag>.
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

// Enlace: RSS usa <link>url</link>; Atom usa <link href="url"/>.
function extractLink(block) {
  const t = tagText(block, 'link');
  if (t) return t;
  const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

// Imagen: enclosure, media:content, media:thumbnail o primer <img> del cuerpo.
function extractImage(block) {
  let m = block.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\//i)
       || block.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
  if (m) return decodeEntities(m[1]);
  const body = tagText(block, 'content:encoded') || tagText(block, 'description') || tagText(block, 'summary');
  const img = body.match(/<img[^>]*src=["']([^"']+)["']/i);
  return img ? decodeEntities(img[1]) : null;
}

function parseFeed(xml, feedTitle) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = tagText(block, 'title');
    const link = extractLink(block);
    const desc = tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content:encoded');
    const date = tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date');
    if (!title || !link) continue;
    items.push(norm(title, desc, link, extractImage(block), date, 'RSS – ' + feedTitle));
  }
  return items;
}

async function fetchRSS(lang) {
  const rssUrl = RSS_FEEDS[lang];
  const xml = await safeFetchText(rssUrl, 'RSS');
  if (!xml) return [];
  const feedTitle = tagText(xml.match(/<channel[\s\S]*?<\/title>/i)?.[0] || xml, 'title') || (lang === 'es' ? 'srperro' : 'dogster');
  return parseFeed(xml, feedTitle);
}

// ─── TRADUCCIÓN (MyMemory, solo en la Action) ─────────────────────────
async function translatePair(title, description) {
  const text = (title || '') + ' ||| ' + (description || '');
  let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|es';
  if (MYMEMORY_EMAIL) url += '&de=' + encodeURIComponent(MYMEMORY_EMAIL);
  const data = await safeFetchJson(url, 'MyMemory');
  const t = data && data.responseData && data.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) return null;
  const parts = t.split('|||').map(s => s.trim());
  return { title_es: parts[0] || '', description_es: parts[1] || '' };
}

async function preTranslate(articles) {
  let done = 0;
  for (let i = 0; i < Math.min(TRANSLATE_LIMIT, articles.length); i++) {
    const a = articles[i];
    const tr = await translatePair(a.title, a.description);
    if (tr) { a.title_es = tr.title_es; a.description_es = tr.description_es; done++; }
    else break; // cupo agotado o error: paramos y dejamos el resto bajo demanda
    await sleep(300); // amable con el rate-limit
  }
  return done;
}

// ─── AGREGADOR POR IDIOMA ─────────────────────────────────────────────
function dedupe(list) {
  const seenTitle = new Set();
  const seenUrl = new Set();
  const out = [];
  for (const a of list) {
    if (!a.title || !a.url || !a.publishedAt) continue;
    const tk = normTitle(a.title);
    const uk = urlKey(a.url);
    if (!tk || seenTitle.has(tk) || seenUrl.has(uk)) continue;
    seenTitle.add(tk); seenUrl.add(uk);
    out.push(a);
  }
  return out;
}

async function fetchLang(lang) {
  const results = await Promise.allSettled([
    fetchNewsdata(lang),
    fetchTheNewsAPI(lang),
    fetchCurrents(lang),
    fetchMediastack(lang),
  ]);

  let combined = [];
  results.forEach(r => { if (r.status === 'fulfilled') combined.push(...r.value); });

  let unique = dedupe(combined.filter(isDogRelated));

  // Umbral: si hay pocas noticias, completar con RSS (no todo-o-nada).
  if (unique.length < MIN_PER_LANG) {
    if (unique.length === 0) console.warn(`Sin resultados de APIs para "${lang}", usando RSS`);
    else console.warn(`Solo ${unique.length} para "${lang}", completando con RSS`);
    const rss = await fetchRSS(lang); // los feeds ya son temáticos (perros)
    unique = dedupe([...unique, ...rss]);
  }

  const ranked = unique
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, MAX_PER_LANG)
    .map((a, i) => ({ id: `${lang}-${i}`, ...a }));

  return ranked;
}

// ─── COMPARACIÓN PARA NO COMMITEAR SI NO HAY CAMBIOS ──────────────────
// generatedAt cambia siempre; si lo dejáramos en el diff, la Action
// commitearía en cada ejecución. Comparamos solo el contenido (es/en).
function contentSignature(obj) {
  return JSON.stringify({ es: obj.es || [], en: obj.en || [] });
}

// ─── PUNTO DE ENTRADA ──────────────────────────────────────────────────
(async () => {
  const [es, en] = await Promise.all([fetchLang('es'), fetchLang('en')]);

  const translated = await preTranslate(en);
  console.log(`Pre-traducidos ${translated}/${Math.min(TRANSLATE_LIMIT, en.length)} artículos EN`);

  const outPath = path.join(__dirname, '..', 'noticias.json');
  const next = { es, en };

  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}

  if (previous && contentSignature(previous) === contentSignature(next)) {
    console.log('Sin cambios en el contenido: no se reescribe noticias.json (sin commit).');
    if (es.length === 0 && en.length === 0) {
      console.error('Aviso: no hay noticias y tampoco había antes.');
    }
    return;
  }

  const output = { generatedAt: new Date().toISOString(), es, en };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Escrito ${outPath}: ${es.length} artículos ES, ${en.length} artículos EN`);

  if (es.length === 0 && en.length === 0) {
    console.error('Aviso: ninguna fuente devolvió nada en ninguno de los dos idiomas.');
  }
})();
