/* eslint-disable no-undef */
const state = {
  filesA: [],
  filesB: [],
  filesC: [],
  hashing: false,
  paused: false,
  abortController: null,
  partialResults: null,
};

const dirA = document.getElementById('dirA');
const dirB = document.getElementById('dirB');
const dirC = document.getElementById('dirC');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const deleteBtn = document.getElementById('deleteBtn');
const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const compareMode = document.getElementById('compareMode');
const nameFallback = document.getElementById('nameFallback');
const tableBody = document.querySelector('#resultsTable tbody');
const summary = document.getElementById('summary');
const selectAllA = document.getElementById('selectAllA');
const selectAllB = document.getElementById('selectAllB');
const selectAllC = document.getElementById('selectAllC');

function updateReady() {
  const count = [dirA.files.length > 0, dirB.files.length > 0, dirC.files.length > 0].filter(Boolean).length;
  const ok = count >= 2;
  startBtn.disabled = !ok || state.hashing;
  stopBtn.disabled = !state.hashing;
  statusEl.textContent = ok ? '可以開始比對' : '請至少選擇兩個資料夾';
}

dirA.addEventListener('change', updateReady);
dirB.addEventListener('change', updateReady);
dirC.addEventListener('change', updateReady);

resetBtn.addEventListener('click', () => {
  // Cancel any ongoing operation
  if (state.abortController) {
    state.abortController.abort();
  }
  
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
  stopBtn.disabled = true;
  deleteBtn.disabled = true;
  selectAllA.checked = false;
  selectAllB.checked = false;
  selectAllC.checked = false;
  
  // Reset state
  state.hashing = false;
  state.paused = false;
  state.abortController = null;
  state.partialResults = null;
});

startBtn.addEventListener('click', async () => {
  if (state.hashing) return;
  state.hashing = true;
  state.paused = false;
  state.abortController = new AbortController();
  state.partialResults = null;
  startBtn.disabled = true;
  stopBtn.disabled = false;
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
    
    // Check total file count for Raspberry Pi limitations
    const totalFiles = filesA.length + filesB.length + filesC.length;
    if (totalFiles > 10000) {
      statusEl.textContent = `檔案數量過多 (${totalFiles})，建議分批處理`;
      return;
    }

    const allFiles = filesA.length + filesB.length + filesC.length;
    let processed = 0;
    const tick = () => {
      processed += 1;
      progressBar.style.width = `${Math.round((processed / Math.max(allFiles, 1)) * 100)}%`;
    };

    // Process folders one by one to save partial results
    const resA = await buildFileMap(filesA, useHash, tick, state.abortController.signal);
    const resB = await buildFileMap(filesB, useHash, tick, state.abortController.signal);
    
    // Save partial results after processing A and B
    const partialAB = compareMaps(resA.map, resB.map, new Map(), { nameAssist });
    state.partialResults = { results: partialAB, resA, resB, resC: { map: new Map(), skipped: 0 } };
    
    const resC = filesC.length ? await buildFileMap(filesC, useHash, tick, state.abortController.signal) : { map: new Map(), skipped: 0 };

    const results = compareMaps(resA.map, resB.map, resC.map, { nameAssist });
    state.partialResults = { results, resA, resB, resC };
    renderResults(results);

    const counts = summarize(results);
    const skipped = resA.skipped + resB.skipped + resC.skipped;
    const duplicateCount = counts.all3 + counts.any2;
    summary.classList.remove('hidden');
    summary.textContent = `顯示 ${duplicateCount} 個重複檔案（三處相同 ${counts.all3}，兩處相同 ${counts.any2}）${skipped ? `；跳過無法讀取檔案 ${skipped}` : ''}`;
    statusEl.textContent = skipped ? '完成（部分檔案無法讀取，已跳過）' : '完成';
    deleteBtn.disabled = false;
  } catch (err) {
    if (err.name === 'AbortError') {
      // Show partial results if available
      if (state.partialResults) {
        const { results, resA, resB, resC } = state.partialResults;
        renderResults(results);
        
        const counts = summarize(results);
        const skipped = resA.skipped + resB.skipped + resC.skipped;
        const duplicateCount = counts.all3 + counts.any2;
        summary.classList.remove('hidden');
        summary.textContent = `顯示 ${duplicateCount} 個重複檔案（三處相同 ${counts.all3}，兩處相同 ${counts.any2}）${skipped ? `；跳過無法讀取檔案 ${skipped}` : ''}（部分結果）`;
        statusEl.textContent = '比對已停止（顯示部分結果）';
        deleteBtn.disabled = false;
      } else {
        statusEl.textContent = '比對已停止';
      }
    } else {
      console.error(err);
      statusEl.textContent = `發生錯誤：${err && err.message ? err.message : String(err)}`;
    }
  } finally {
    state.hashing = false;
    state.paused = false;
    state.abortController = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    progressWrap.classList.add('hidden');
  }
});

// Stop functionality
stopBtn.addEventListener('click', () => {
  if (state.hashing) {
    // Stop the comparison
    state.abortController.abort();
    statusEl.textContent = '比對已停止';
  }
});

async function buildFileMap(files, useHash, progressCb, signal) {
  // Map key: hash if useHash, else path; value: { paths: Set<path>, size }
  const map = new Map();
  let skipped = 0;
  
  if (useHash) {
    // Two-phase approach: first group by name+size, then hash only candidates
    const nameSizeMap = new Map();
    
    // Phase 1: Group by name+size (with batching for large folders)
    // Smaller batch size for Raspberry Pi to avoid memory issues
    const batchSize = 500; // Reduced for Raspberry Pi compatibility
    for (let i = 0; i < files.length; i += batchSize) {
      if (signal && signal.aborted) {
        throw new Error('AbortError');
      }
      
      const batch = files.slice(i, i + batchSize);
      for (const file of batch) {
        const relPath = file.webkitRelativePath || file.name;
        const size = file.size;
        const nameSizeKey = `${relPath}:${size}`;
        
        if (!nameSizeMap.has(nameSizeKey)) {
          nameSizeMap.set(nameSizeKey, []);
        }
        nameSizeMap.get(nameSizeKey).push(file);
        progressCb();
      }
      
      // Allow other operations to run between batches (longer delay for Raspberry Pi)
      if (i + batchSize < files.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    
    // Phase 2: Hash only files that have potential duplicates (with batching)
    const candidates = Array.from(nameSizeMap.entries()).filter(([_, fileList]) => fileList.length > 1);
    const hashBatchSize = 5; // Even smaller for Raspberry Pi CPU limitations
    
    for (let i = 0; i < candidates.length; i += hashBatchSize) {
      if (signal && signal.aborted) {
        throw new Error('AbortError');
      }
      
      const batch = candidates.slice(i, i + hashBatchSize);
      for (const [nameSizeKey, fileList] of batch) {
        // Multiple files with same name+size, need to hash them
        for (const file of fileList) {
          const relPath = file.webkitRelativePath || file.name;
          const size = file.size;
          let hashHex = '';
          
          try {
            hashHex = await sha256File(file);
            const key = `${hashHex}`;
            const existed = map.get(key) || { paths: new Set(), hash: hashHex, size };
            existed.paths.add(relPath);
            existed.size = size;
            existed.hash = hashHex;
            map.set(key, existed);
          } catch (e) {
            skipped += 1;
            console.warn('Skip unreadable file:', relPath, e);
            // Log specific error for Raspberry Pi debugging
            if (e.message && e.message.includes('too large')) {
              console.warn('File size limit exceeded:', relPath, file.size);
            }
          }
        }
      }
      
      // Allow other operations to run between hash batches (longer delay for Raspberry Pi)
      if (i + hashBatchSize < candidates.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    // Add unique files (no hashing needed)
    for (const [nameSizeKey, fileList] of nameSizeMap) {
      if (fileList.length === 1) {
        const file = fileList[0];
        const relPath = file.webkitRelativePath || file.name;
        const size = file.size;
        const key = nameSizeKey; // Use name+size as key for unique files
        const existed = map.get(key) || { paths: new Set(), hash: '', size };
        existed.paths.add(relPath);
        existed.size = size;
        existed.hash = '';
        map.set(key, existed);
      }
    }
  } else {
    // Original approach for name-only comparison
    for (const file of files) {
      if (signal && signal.aborted) {
        throw new Error('AbortError');
      }
      
      const relPath = file.webkitRelativePath || file.name;
      const size = file.size;
      const key = relPath;
      const existed = map.get(key) || { paths: new Set(), hash: '', size };
      existed.paths.add(relPath);
      existed.size = size;
      existed.hash = '';
      map.set(key, existed);
      progressCb();
    }
  }
  
  return { map, skipped };
}

async function sha256File(file) {
  // Read as ArrayBuffer, catch permission or transient read errors at caller
  // Add size check for Raspberry Pi memory limitations
  if (file.size > 100 * 1024 * 1024) { // 100MB limit
    throw new Error(`File too large for processing: ${file.size} bytes`);
  }
  
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
  // Only show duplicate files (appearing in 2 or more folders)
  const duplicateRows = rows.filter(r => r.tag === 'all3' || r.tag === 'any2');
  
  for (const r of duplicateRows) {
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

    const cellA = presenceCell(r.aPaths, 'A');
    const cellB = presenceCell(r.bPaths, 'B');
    const cellC = presenceCell(r.cPaths, 'C');

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

function presenceCell(paths, column) {
  const td = document.createElement('td');
  const wrapper = document.createElement('div');
  wrapper.className = 'cell-presence';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = paths.length === 0;
  checkbox.dataset.column = column;
  wrapper.appendChild(checkbox);

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

// Delete functionality
deleteBtn.addEventListener('click', () => {
  const selectedFiles = getSelectedFiles();
  if (selectedFiles.length === 0) {
    alert('請先選擇要刪除的檔案');
    return;
  }
  
  if (confirm(`確定要刪除 ${selectedFiles.length} 個檔案嗎？此操作無法復原。`)) {
    deleteSelectedFiles(selectedFiles);
  }
});

function getSelectedFiles() {
  const selected = [];
  const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]:checked');
  for (const cb of checkboxes) {
    const row = cb.closest('tr');
    const pathCell = row.querySelector('.path');
    const column = cb.dataset.column;
    if (pathCell && column) {
      selected.push({
        path: pathCell.textContent.trim(),
        column: column
      });
    }
  }
  return selected;
}

function deleteSelectedFiles(selectedFiles) {
  // Note: Browser security prevents direct file deletion
  // This is a placeholder for the UI feedback
  console.log('Files to delete:', selectedFiles);
  alert('由於瀏覽器安全限制，無法直接刪除檔案。請手動刪除以下檔案：\n\n' + 
    selectedFiles.map(f => `${f.column}: ${f.path}`).join('\n'));
  
  // Remove selected rows from table
  const checkboxes = tableBody.querySelectorAll('input[type="checkbox"]:checked');
  for (const cb of checkboxes) {
    const row = cb.closest('tr');
    if (row) {
      row.remove();
    }
  }
  
  // Update summary
  const remainingRows = tableBody.querySelectorAll('tr').length;
  summary.textContent = `剩餘 ${remainingRows} 個重複檔案（已移除選取的檔案）`;
}

// Select all functionality
selectAllA.addEventListener('change', () => {
  const checkboxes = tableBody.querySelectorAll('input[data-column="A"]:not([disabled])');
  for (const cb of checkboxes) {
    cb.checked = selectAllA.checked;
  }
});

selectAllB.addEventListener('change', () => {
  const checkboxes = tableBody.querySelectorAll('input[data-column="B"]:not([disabled])');
  for (const cb of checkboxes) {
    cb.checked = selectAllB.checked;
  }
});

selectAllC.addEventListener('change', () => {
  const checkboxes = tableBody.querySelectorAll('input[data-column="C"]:not([disabled])');
  for (const cb of checkboxes) {
    cb.checked = selectAllC.checked;
  }
});


