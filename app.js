const savedLanguage = localStorage.getItem('selectedLanguage');
let currentLanguage = savedLanguage || 'ru-RU';
const API_KEY = '6f9e225e6b29d098b4a4fa7826fdba57';
let currentType = 'tv';
const PAGE_SIZE = 24;
let currentPage = 1;
let fullList = [];
/** @type {Array<object>} */
let tvList = [];
/** @type {Array<object>} */
let moviesList = [];

const titleSearchInput = document.getElementById('titleSearch');
const searchMetaEl = document.getElementById('searchMeta');

function sortByRatingDesc(a, b) {
  const ra = typeof a.rating === 'number' ? a.rating : 0;
  const rb = typeof b.rating === 'number' ? b.rating : 0;
  return rb - ra;
}

function searchQueryTrimmed() {
  return titleSearchInput.value.trim();
}

function isSearchActive() {
  return searchQueryTrimmed().length > 0;
}

/** Combined TV + movies matching the search box (rating-sorted). */
function getSearchResultsList() {
  const q = searchQueryTrimmed().toLowerCase();
  if (!q) return [];
  const needle = q.normalize('NFKC');
  const match = (item) => {
    const t = String(item.title || '').normalize('NFKC').toLowerCase();
    return t.includes(needle);
  };
  return [...tvList, ...moviesList].filter(match).sort(sortByRatingDesc);
}

/** List currently shown: one tab, or merged search hits. */
function getDisplayList() {
  if (isSearchActive()) return getSearchResultsList();
  return fullList;
}

document.getElementById('tvBtn').addEventListener('click', () => {
  currentType = 'tv';
  currentPage = 1;
  titleSearchInput.value = '';
  searchMetaEl.textContent = '';
  toggleActive('tvBtn');
  loadRatings();
});

document.getElementById('movieBtn').addEventListener('click', () => {
  currentType = 'movie';
  currentPage = 1;
  titleSearchInput.value = '';
  searchMetaEl.textContent = '';
  toggleActive('movieBtn');
  loadRatings();
});

document.getElementById('prevBtn').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    renderPage();
  }
});

document.getElementById('nextBtn').addEventListener('click', () => {
  const totalPages = Math.ceil(getDisplayList().length / PAGE_SIZE) || 1;
  if (currentPage < totalPages) {
    currentPage++;
    renderPage();
  }
});

const pageNumbersEl = document.getElementById('pageNumbers');
const pageJumpInput = document.getElementById('pageJumpInput');
const pageJumpBtn = document.getElementById('pageJumpBtn');

/**
 * Page indices to show (with ellipses) for large page counts.
 * @returns {(number|'…')[]}
 */
function getPaginationSegments(totalPages, currentPage) {
  if (totalPages <= 1) return [1];
  if (totalPages <= 9) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items = [];
  const pushEllipsis = () => {
    if (items.length && items[items.length - 1] !== '…') items.push('…');
  };
  items.push(1);
  const start = Math.max(2, currentPage - 2);
  const end = Math.min(totalPages - 1, currentPage + 2);
  if (start > 2) pushEllipsis();
  for (let p = start; p <= end; p++) items.push(p);
  if (end < totalPages - 1) pushEllipsis();
  items.push(totalPages);
  return items;
}

function renderPaginationControls(totalPages) {
  pageNumbersEl.replaceChildren();
  const segments = getPaginationSegments(totalPages, currentPage);
  for (const seg of segments) {
    if (seg === '…') {
      const span = document.createElement('span');
      span.className = 'page-ellipsis';
      span.textContent = '…';
      span.setAttribute('aria-hidden', 'true');
      pageNumbersEl.appendChild(span);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-num' + (seg === currentPage ? ' is-current' : '');
    btn.textContent = String(seg);
    btn.dataset.page = String(seg);
    if (seg === currentPage) {
      btn.disabled = true;
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.addEventListener('click', () => {
        currentPage = seg;
        renderPage();
      });
    }
    pageNumbersEl.appendChild(btn);
  }

  pageJumpInput.max = String(totalPages);
  pageJumpInput.min = '1';
  pageJumpInput.value = String(currentPage);
}

function commitPageJump() {
  const totalPages = Math.ceil(getDisplayList().length / PAGE_SIZE) || 1;
  let p = parseInt(pageJumpInput.value, 10);
  if (!Number.isFinite(p)) return;
  p = Math.max(1, Math.min(totalPages, p));
  currentPage = p;
  renderPage();
}

pageJumpBtn.addEventListener('click', commitPageJump);
pageJumpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitPageJump();
  }
});

function toggleActive(activeId) {
  document.getElementById('tvBtn').classList.remove('active');
  document.getElementById('movieBtn').classList.remove('active');
  document.getElementById(activeId).classList.add('active');
}

/** @param item Must include `_listType` when mixing TV and movies (search mode). */
async function fetchOneItem(item) {
  const mediaType = item._listType || currentType;
  const tmdbId = Number(item.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) {
    const cacheKey = `${mediaType}_id_${tmdbId}_${currentLanguage}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);

    const detailURL = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${API_KEY}&language=${currentLanguage}`;
    const res = await fetch(detailURL);
    if (res.ok) {
      const data = await res.json();
      if (data && data.id) {
        localStorage.setItem(cacheKey, JSON.stringify(data));
        return data;
      }
    }
  }

  const cacheKey = `${mediaType}_${item.title}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  let queryURL = `https://api.themoviedb.org/3/search/${mediaType}?api_key=${API_KEY}&query=${encodeURIComponent(item.title)}&language=${currentLanguage}`;
  if (item.year) {
    if (mediaType === 'tv') queryURL += `&first_air_date_year=${item.year}`;
    else if (mediaType === 'movie') queryURL += `&primary_release_year=${item.year}`;
  }
  const res = await fetch(queryURL);
  const data = await res.json();
  const first = data.results?.[0];
  if (first) localStorage.setItem(cacheKey, JSON.stringify(first));
  return first || null;
}

async function loadRatings() {
  const [tvRaw, moviesRaw] = await Promise.all([
    fetch('tv.json').then((r) => r.json()),
    fetch('movies.json').then((r) => r.json()),
  ]);

  tvList = tvRaw.sort(sortByRatingDesc).map((row) => ({ ...row, _listType: 'tv' }));
  moviesList = moviesRaw.sort(sortByRatingDesc).map((row) => ({ ...row, _listType: 'movie' }));
  fullList = currentType === 'tv' ? tvList : moviesList;

  const displayList = getDisplayList();
  const totalPages = Math.ceil(displayList.length / PAGE_SIZE) || 1;
  if (currentPage > totalPages) currentPage = Math.max(1, totalPages);

  const paginationEl = document.getElementById('pagination');
  paginationEl.style.display = totalPages > 1 ? 'flex' : 'none';
  await renderPage();
}

const playerModal = document.getElementById('playerModal');
const kinobdMount = document.getElementById('kinobdMount');
const playerModalTitle = document.getElementById('playerModalTitle');
let kinobdScriptPromise = null;

function ensureKinobdScript() {
  if (typeof window.kbp === 'function') return Promise.resolve();
  if (kinobdScriptPromise) return kinobdScriptPromise;
  kinobdScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://kinobd.net/js/player_.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('KinoBD script failed to load'));
    document.head.appendChild(s);
  });
  return kinobdScriptPromise;
}

function clearKinobdDom() {
  document.getElementById('kinobd-wrapper')?.remove();
  document.getElementById('kinobd-buttons')?.remove();
  document.getElementById('kinobd')?.remove();
}

async function initKinobdWidget(errorContainer) {
  const hadKbp = typeof window.kbp === 'function';
  try {
    await ensureKinobdScript();
    if (hadKbp && typeof window.kbp === 'function') {
      window.kbp();
    }
  } catch (e) {
    errorContainer.innerHTML = '<p style="padding:1rem;color:#c00;">Failed to load KinoBD widget.</p>';
  }
}

async function finalizeKinobdMount() {
  await initKinobdWidget(kinobdMount);
  playerModal.classList.add('is-open');
}

/**
 * Online player: Kinopoisk ID only (data-kinopoisk), not TMDb.
 */
async function openPlayerModal(title, kinopoiskId) {
  playerModalTitle.textContent = title || 'Player';
  clearKinobdDom();
  kinobdMount.replaceChildren();
  easterKinobdMount.replaceChildren();

  const kp = Number(kinopoiskId);
  if (!Number.isInteger(kp) || kp <= 0) {
    kinobdMount.innerHTML = '<p style="padding:1rem;color:#555;">No Kinopoisk ID for this title.</p>';
    playerModal.classList.add('is-open');
    return;
  }

  const div = document.createElement('div');
  div.id = 'kinobd';
  div.setAttribute('data-kinopoisk', String(kp));
  kinobdMount.appendChild(div);
  await finalizeKinobdMount();
}

/**
 * KinoBD torrent block: data-player="torrent" + data-title (per KinoBD docs).
 */
async function openTorrentModal(displayTitle, listTitle) {
  const title = (displayTitle && String(displayTitle).trim()) || (listTitle && String(listTitle).trim()) || '';
  playerModalTitle.textContent = title ? `Torrents — ${title}` : 'Torrents';
  clearKinobdDom();
  kinobdMount.replaceChildren();
  easterKinobdMount.replaceChildren();

  if (!title) {
    kinobdMount.innerHTML = '<p style="padding:1rem;color:#555;">No title to look up torrents.</p>';
    playerModal.classList.add('is-open');
    return;
  }

  const div = document.createElement('div');
  div.id = 'kinobd';
  div.setAttribute('data-player', 'torrent');
  div.setAttribute('data-title', title);
  kinobdMount.appendChild(div);
  await finalizeKinobdMount();
}

function closePlayerModal() {
  playerModal.classList.remove('is-open');
  clearKinobdDom();
  kinobdMount.replaceChildren();
}

document.getElementById('playerModalClose').addEventListener('click', closePlayerModal);
playerModal.addEventListener('click', (e) => {
  if (e.target === playerModal) closePlayerModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && playerModal.classList.contains('is-open')) closePlayerModal();
});

const easterEggPanel = document.getElementById('easterEggPanel');
const easterKinobdMount = document.getElementById('easterKinobdMount');
const easterKpInput = document.getElementById('easterKpInput');
const easterKpCheck = document.getElementById('easterKpCheck');

let globeClickCount = 0;
let globeClickTimer = null;
const GLOBE_CLICK_RESET_MS = 2500;

document.getElementById('langGlobeLabel').addEventListener('click', () => {
  clearTimeout(globeClickTimer);
  globeClickCount += 1;
  if (globeClickCount >= 5) {
    globeClickCount = 0;
    easterEggPanel.classList.add('is-visible');
    easterEggPanel.setAttribute('aria-hidden', 'false');
    easterKpInput.focus();
    return;
  }
  globeClickTimer = setTimeout(() => {
    globeClickCount = 0;
  }, GLOBE_CLICK_RESET_MS);
});

easterKpCheck.addEventListener('click', async () => {
  const raw = easterKpInput.value.trim();
  const kp = Number(raw);
  closePlayerModal();
  clearKinobdDom();
  easterKinobdMount.replaceChildren();

  if (!Number.isInteger(kp) || kp <= 0) {
    const p = document.createElement('p');
    p.className = 'easter-error';
    p.textContent = 'Enter a valid positive Kinopoisk ID.';
    easterKinobdMount.appendChild(p);
    return;
  }

  const div = document.createElement('div');
  div.id = 'kinobd';
  div.setAttribute('data-kinopoisk', String(kp));
  easterKinobdMount.appendChild(div);
  await initKinobdWidget(easterKinobdMount);
});

easterKpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') easterKpCheck.click();
});

async function renderPage() {
  const displayList = getDisplayList();
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = displayList.slice(start, start + PAGE_SIZE);

  const container = document.getElementById('list');
  container.innerHTML = '';

  if (isSearchActive()) {
    const n = displayList.length;
    const q = searchQueryTrimmed();
    searchMetaEl.textContent = n
      ? `${n} match${n === 1 ? '' : 'es'} for “${q}” (TV + movies)`
      : `No matches for “${q}”`;
  } else {
    searchMetaEl.textContent = '';
  }

  const results = await Promise.all(pageItems.map((item) => fetchOneItem(item)));

  pageItems.forEach((item, i) => {
    const first = results[i];
    if (!first) return;

    const mediaType = item._listType || currentType;
    const poster = first.poster_path
      ? `https://image.tmdb.org/t/p/w300${first.poster_path}`
      : 'https://via.placeholder.com/300x450?text=No+poster';
    const tmdbNumericId = first.id;
    const tmdbLink = `https://www.themoviedb.org/${mediaType}/${tmdbNumericId}`;
    const displayName = first.name || first.title || item.title;
    const kinopoiskIdForPlayer = item.kinopoisk_id;

    const card = document.createElement('div');
    card.className = 'card';
    const torrentIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 16l4-4h-3V4h-2v8H8l4 4zm9-13h-6v2h6v14H3V5h6V3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`;
    card.innerHTML = `
      <img src="${poster}" alt="${item.title}" loading="lazy" />
      <div class="card-title"><strong>${displayName}</strong></div>
      <div class="card-footer">
        <button type="button" class="torrent-btn" title="Torrents" aria-label="Open torrents (KinoBD)">${torrentIcon}</button>
        <button type="button" class="info-btn" title="Open on TMDb" aria-label="Open on The Movie Database">i</button>
        <div class="rating">⭐ ${item.rating}</div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.info-btn') || e.target.closest('.torrent-btn')) return;
      openPlayerModal(displayName, kinopoiskIdForPlayer);
    });

    card.querySelector('.torrent-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openTorrentModal(displayName, item.title);
    });

    card.querySelector('.info-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(tmdbLink, '_blank', 'noopener,noreferrer');
    });

    container.appendChild(card);
  });

  const totalPages = Math.ceil(displayList.length / PAGE_SIZE) || 1;
  document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${totalPages}`;
  document.getElementById('prevBtn').disabled = currentPage <= 1;
  document.getElementById('nextBtn').disabled = currentPage >= totalPages;

  renderPaginationControls(totalPages);

  const paginationEl = document.getElementById('pagination');
  paginationEl.style.display = totalPages > 1 ? 'flex' : 'none';
}

titleSearchInput.addEventListener('input', () => {
  currentPage = 1;
  renderPage();
});

document.getElementById('lang').addEventListener('change', (e) => {
  const newLang = e.target.value;
  localStorage.clear();
  localStorage.setItem('selectedLanguage', newLang);
  currentLanguage = newLang;
  currentPage = 1;
  loadRatings();
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('lang').value = currentLanguage;
  loadRatings();
});
