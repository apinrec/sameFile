/* eslint-disable no-undef */
const state = {
  filesA: [],
  filesB: [],
  filesC: [],
  hashing: false,
};

const dirA = document.getElementById('dirA');
const dirB = document.getElementById('dirB');
const dirC = document.getElementById('dirC');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const compareMode = document.getElementById('compareMode');
const nameFallback = document.getElementById('nameFallback');
const tableBody = document.querySelector('#resultsTable tbody');
const summary = document.getElementById('summary');

function updateReady() {
  const count = [dirA.files.length > 0, dirB.files.length > 0, dirC.files.length > 0].filter(Boolean).length;
  const ok = count >= 2;
  startBtn.disabled = !ok || state.hashing;
  statusEl.textContent = ok ? '可以開始比對' : '請至少選擇兩個資料夾';
}

dirA.addEventListener('change', updateReady);
dirB.addEventListener('change', updateReady);
dirC.addEventListener('change', updateReady);

resetBtn.addEventListener('click', () => {
  dirA.value = '';
  dirB.value = '';
  dirC.value = '';
  tableBody.innerHTML = '';
  summary.classList.add('hidden');
  summary.textContent = '';
  progressWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  statusEl.textContent = '請至少選擇兩個資料夾';
  startBtn.disabled = true;
});

startBtn.addEventListener('click', async () => {
  if (state.hashing) return;
  state.hashing = true;
  startBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';
  tableBody.innerHTML = '';
  summary.classList.add('hidden');
  summary.textContent = '';

  try {
    const useHash = compareMode.checked;
    const nameAssist = nameFallback.checked;

    const filesA = Array.from(dirA.files);
    const filesB = Array.from(dirB.files);
    const filesC = Array.from(dirC.files);

    const allFiles = filesA.length + filesB.length + filesC.length;
    let processed = 0;
    const tick = () => {
      processed += 1;
      progressBar.style.width = `${Math.round((processed / Math.max(allFiles, 1)) * 100)}%`;
    };

    const promises = [buildFileMap(filesA, useHash, tick), buildFileMap(filesB, useHash, tick)];
    if (filesC.length) promises.push(buildFileMap(filesC, useHash, tick));
    const built = await Promise.all(promises);
    const resA = built[0];
    const resB = built[1];
    const resC = built[2] || { map: new Map(), skipped: 0 };

    const results = compareMaps(resA.map, resB.map, resC.map, { nameAssist });
    renderResults(results);

    const counts = summarize(results);
    const skipped = resA.skipped + resB.skipped + resC.skipped;
    summary.classList.remove('hidden');
    summary.textContent = `共 ${counts.total} 筆記錄；三處相同 ${counts.all3}，兩處相同 ${counts.any2}，同名同路徑 ${counts.nameMatches}${skipped ? `；跳過無法讀取檔案 ${skipped}` : ''}`;
    statusEl.textContent = skipped ? '完成（部分檔案無法讀取，已跳過）' : '完成';
  } catch (err) {
    console.error(err);
    statusEl.textContent = `發生錯誤：${err && err.message ? err.message : String(err)}`;
  } finally {
    state.hashing = false;
    startBtn.disabled = false;
    progressWrap.classList.add('hidden');
  }
});

async function buildFileMap(files, useHash, progressCb) {
  // Map key: hash if useHash, else path; value: { paths: Set<path>, size }
  const map = new Map();
  let skipped = 0;
  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const size = file.size;
    let key;
    let hashHex = '';
    try {
      if (useHash) {
        hashHex = await sha256File(file);
        key = `${hashHex}`;
      } else {
        key = relPath;
      }
      const existed = map.get(key) || { paths: new Set(), hash: hashHex, size };
      existed.paths.add(relPath);
      existed.size = size;
      existed.hash = hashHex || existed.hash;
      map.set(key, existed);
    } catch (e) {
      // Skip unreadable files and continue
      skipped += 1;
      console.warn('Skip unreadable file:', relPath, e);
    } finally {
      progressCb();
    }
  }
  return { map, skipped };
}

async function sha256File(file) {
  // Read as ArrayBuffer, catch permission or transient read errors at caller
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return hexFromBuffer(hash);
}

function hexFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return hex;
}

function compareMaps(mapA, mapB, mapC, { nameAssist }) {
  // Collect keys
  const keys = new Set([...mapA.keys(), ...mapB.keys(), ...mapC.keys()]);

  // For name assist, build name-based presence maps
  const namePresence = nameAssist
    ? buildNamePresence(mapA, mapB, mapC)
    : { a: new Set(), b: new Set(), c: new Set(), ab: new Set(), bc: new Set(), ac: new Set(), abc: new Set() };

  const rows = [];
  for (const key of keys) {
    const a = mapA.get(key);
    const b = mapB.get(key);
    const c = mapC.get(key);
    const size = (a && a.size) || (b && b.size) || (c && c.size) || 0;
    const hash = (a && a.hash) || (b && b.hash) || (c && c.hash) || '';

    // Determine presence counts by content key
    const present = [!!a, !!b, !!c].filter(Boolean).length;
    const tag = present === 3 ? 'all3' : present === 2 ? 'any2' : '';

    rows.push({
      key,
      size,
      hash,
      aPaths: a ? Array.from(a.paths).sort() : [],
      bPaths: b ? Array.from(b.paths).sort() : [],
      cPaths: c ? Array.from(c.paths).sort() : [],
      tag,
      nameMatch: determineNameMatch(a, b, c, namePresence),
    });
  }
  rows.sort((r1, r2) => {
    if (r1.tag === 'all3' && r2.tag !== 'all3') return -1;
    if (r2.tag === 'all3' && r1.tag !== 'all3') return 1;
    if (r1.tag === 'any2' && r2.tag === '') return -1;
    if (r2.tag === 'any2' && r1.tag === '') return 1;
    const p1 = r1.aPaths[0] || r1.bPaths[0] || r1.cPaths[0] || '';
    const p2 = r2.aPaths[0] || r2.bPaths[0] || r2.cPaths[0] || '';
    return p1.localeCompare(p2);
  });
  return rows;
}

function buildNamePresence(mapA, mapB, mapC) {
  const toNames = (map) => {
    const s = new Set();
    for (const value of map.values()) {
      for (const p of value.paths) s.add(p);
    }
    return s;
  };
  return {
    a: toNames(mapA),
    b: toNames(mapB),
    c: toNames(mapC),
  };
}

function determineNameMatch(a, b, c, namePresence) {
  if (!namePresence) return false;
  const namesA = a ? a.paths : new Set();
  const namesB = b ? b.paths : new Set();
  const namesC = c ? c.paths : new Set();
  const matchAB = intersects(namesA, namesB);
  const matchBC = intersects(namesB, namesC);
  const matchAC = intersects(namesA, namesC);
  return matchAB || matchBC || matchAC;
}

function intersects(s1, s2) {
  for (const v of s1) if (s2.has(v)) return true;
  return false;
}

function renderResults(rows) {
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.tag === 'all3') tr.classList.add('all3');
    if (r.tag === 'any2') tr.classList.add('any2');

    const pathCell = document.createElement('td');
    pathCell.className = 'path';
    pathCell.textContent = r.aPaths[0] || r.bPaths[0] || r.cPaths[0] || '';

    const sizeCell = document.createElement('td');
    sizeCell.textContent = r.size.toLocaleString();

    const hashCell = document.createElement('td');
    hashCell.className = 'hash';
    hashCell.textContent = r.hash ? r.hash.slice(0, 16) + '…' : '';

    const cellA = presenceCell(r.aPaths);
    const cellB = presenceCell(r.bPaths);
    const cellC = presenceCell(r.cPaths);

    if (r.tag === 'all3') {
      tr.classList.add('row-all3');
    } else if (r.tag === 'any2') {
      tr.classList.add('row-any2');
    }
    if (r.nameMatch) {
      const badge = document.createElement('span');
      badge.className = 'badge name-match';
      badge.textContent = '同名同路徑';
      pathCell.appendChild(document.createTextNode(' '));
      pathCell.appendChild(badge);
    }

    tr.appendChild(pathCell);
    tr.appendChild(sizeCell);
    tr.appendChild(hashCell);
    tr.appendChild(cellA);
    tr.appendChild(cellB);
    tr.appendChild(cellC);
    frag.appendChild(tr);
  }
  tableBody.innerHTML = '';
  tableBody.appendChild(frag);
}

function presenceCell(paths) {
  const td = document.createElement('td');
  const wrapper = document.createElement('div');
  wrapper.className = 'cell-presence';

  const dot = document.createElement('span');
  dot.className = 'dot' + (paths.length ? ' on' : '');
  wrapper.appendChild(dot);

  if (paths.length) {
    const list = document.createElement('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '2px';
    for (const p of paths) {
      const s = document.createElement('span');
      s.className = 'path';
      s.textContent = p;
      list.appendChild(s);
    }
    wrapper.appendChild(list);
  }
  td.appendChild(wrapper);
  return td;
}

function summarize(rows) {
  let all3 = 0, any2 = 0, nameMatches = 0;
  for (const r of rows) {
    if (r.tag === 'all3') all3 += 1;
    else if (r.tag === 'any2') any2 += 1;
    if (r.nameMatch) nameMatches += 1;
  }
  return { total: rows.length, all3, any2, nameMatches };
}


