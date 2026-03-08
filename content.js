(function () {
  if (window.__highlighterInitialized) return;
  window.__highlighterInitialized = true;

  // --- State ---
  let isDrawingMode = false;
  let isSidebarOpen = false;
  let currentColor = '#FF4444';
  let currentOpacity = 0.35;
  let boxes = [];
  let shortcuts = { toggleDraw: 'Alt+D', stopDraw: 'Escape' };
  let pendingShortcutKey = null; // which shortcut is being reassigned

  // --- Constants ---
  const CONTAINER_ID = 'highlighter-ext-container';
  const SIDEBAR_ID = 'highlighter-ext-sidebar';
  const BANNER_ID = 'highlighter-ext-banner';
  const MIN_BOX_SIZE = 5;

  let container = null;
  let sidebar = null;
  let banner = null;

  // --- Shortcut Helpers ---
  function keyComboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
      parts.push(key);
    }
    return parts.join('+');
  }

  function matchesShortcut(e, shortcutStr) {
    if (!shortcutStr) return false;
    const combo = keyComboFromEvent(e);
    return combo.toLowerCase() === shortcutStr.toLowerCase();
  }

  async function saveShortcuts() {
    await chrome.storage.local.set({ shortcuts });
  }

  // --- Storage ---
  function getStorageKey() {
    return 'boxes::' + location.origin + location.pathname + location.search;
  }

  async function loadBoxes() {
    const key = getStorageKey();
    const data = await chrome.storage.local.get(key);
    boxes = data[key] || [];
    renderAllBoxes();
    if (isSidebarOpen) renderSidebar();
  }

  async function saveBoxes() {
    const key = getStorageKey();
    await chrome.storage.local.set({ [key]: boxes });
  }

  // --- Container ---
  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText =
      'position:absolute;top:0;left:0;width:100%;min-height:100%;pointer-events:none;z-index:2147483640;';
    document.body.appendChild(container);

    const ro = new ResizeObserver(() => {
      container.style.height = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ) + 'px';
    });
    ro.observe(document.body);
    ro.observe(document.documentElement);

    return container;
  }

  // --- Box Rendering ---
  function getSortedBoxes() {
    return [...boxes].sort((a, b) => a.createdAt - b.createdAt);
  }

  function createBoxElement(box, index) {
    const el = document.createElement('div');
    el.className = 'highlighter-box';
    el.dataset.boxId = box.id;
    el.style.cssText = `
      position:absolute;
      left:${box.x}px;top:${box.y}px;
      width:${box.width}px;height:${box.height}px;
      background-color:${box.color};
      opacity:${box.opacity};
      pointer-events:none;
      box-sizing:border-box;
      border:2px solid ${box.color};
    `;

    // Number badge (top-left)
    const badge = document.createElement('div');
    badge.className = 'highlighter-box-number';
    badge.textContent = index + 1;
    badge.style.cssText = `
      position:absolute;top:-12px;left:-12px;
      min-width:24px;height:24px;border-radius:12px;
      background:${box.color};color:#fff;
      font-size:12px;font-weight:700;line-height:24px;text-align:center;
      pointer-events:none;z-index:1;
      padding:0 4px;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      box-shadow:0 1px 3px rgba(0,0,0,0.4);
      opacity:1;
    `;
    el.appendChild(badge);

    // Close button (top-right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'highlighter-box-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = `
      position:absolute;top:-10px;right:-10px;
      width:22px;height:22px;border-radius:50%;
      border:none;background:#ff4444;color:#fff;
      font-size:14px;line-height:22px;text-align:center;
      cursor:pointer;pointer-events:auto;
      opacity:0.7;transition:opacity 0.15s;z-index:1;
    `;
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.7'; });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBox(box.id);
    });
    el.appendChild(closeBtn);

    return el;
  }

  function renderAllBoxes() {
    ensureContainer();
    container.querySelectorAll('.highlighter-box').forEach((el) => el.remove());
    const sorted = getSortedBoxes();
    sorted.forEach((box, index) => {
      container.appendChild(createBoxElement(box, index));
    });
  }

  function deleteBox(id) {
    boxes = boxes.filter((b) => b.id !== id);
    saveBoxes();
    renderAllBoxes(); // full re-render for renumbering
    if (isSidebarOpen) renderSidebar();
  }

  // --- Drawing Banner ---
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.className = 'highlighter-drawing-banner';
      banner.innerHTML = '<span class="highlighter-banner-dot"></span> Drawing Mode &mdash; <strong>Ctrl + Drag</strong> to draw a box';
      document.body.appendChild(banner);
    }
    banner.style.display = 'flex';
  }

  function hideBanner() {
    if (banner) banner.style.display = 'none';
  }

  // --- Drawing Logic ---
  let drawState = null;

  function setDrawingMode(enabled) {
    isDrawingMode = enabled;
    if (!enabled) {
      document.documentElement.classList.remove('highlighter-drawing-mode');
    }
    chrome.storage.local.set({ drawingMode: isDrawingMode });
  }

  function onMouseDown(e) {
    if (!isDrawingMode || !e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const preview = document.createElement('div');
    preview.className = 'highlighter-preview';
    preview.style.cssText = `
      position:absolute;
      left:${e.pageX}px;top:${e.pageY}px;
      width:0;height:0;
      background-color:${currentColor};
      opacity:${currentOpacity};
      border:2px dashed ${currentColor};
      pointer-events:none;
      z-index:2147483645;
    `;
    ensureContainer();
    container.appendChild(preview);

    drawState = { startX: e.pageX, startY: e.pageY, previewEl: preview };
  }

  function onMouseMove(e) {
    if (!drawState) return;
    e.preventDefault();
    e.stopPropagation();

    const { startX, startY, previewEl } = drawState;
    const x = Math.min(startX, e.pageX);
    const y = Math.min(startY, e.pageY);
    const w = Math.abs(e.pageX - startX);
    const h = Math.abs(e.pageY - startY);

    previewEl.style.left = x + 'px';
    previewEl.style.top = y + 'px';
    previewEl.style.width = w + 'px';
    previewEl.style.height = h + 'px';
  }

  function onMouseUp(e) {
    if (!drawState) return;
    e.preventDefault();
    e.stopPropagation();

    const { startX, startY, previewEl } = drawState;
    previewEl.remove();

    const x = Math.min(startX, e.pageX);
    const y = Math.min(startY, e.pageY);
    const w = Math.abs(e.pageX - startX);
    const h = Math.abs(e.pageY - startY);

    drawState = null;

    if (w < MIN_BOX_SIZE || h < MIN_BOX_SIZE) return;

    const newBox = {
      id: crypto.randomUUID(),
      x, y, width: w, height: h,
      color: currentColor,
      opacity: currentOpacity,
      memo: '',
      createdAt: Date.now()
    };

    boxes.push(newBox);
    saveBoxes();
    renderAllBoxes();
    if (isSidebarOpen) renderSidebar();
  }

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);

  // --- Keyboard Shortcuts ---
  document.addEventListener('keydown', (e) => {
    // Shortcut reassignment mode: capture next key combo
    if (pendingShortcutKey) {
      // Ignore bare modifier keys
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const combo = keyComboFromEvent(e);
      shortcuts[pendingShortcutKey] = combo;
      pendingShortcutKey = null;
      saveShortcuts();
      if (isSidebarOpen) renderSidebar();
      return;
    }

    // Stop drawing shortcut
    if (isDrawingMode && matchesShortcut(e, shortcuts.stopDraw)) {
      e.preventDefault();
      setDrawingMode(false);
      if (isSidebarOpen) renderSidebar();
      return;
    }
    // Toggle drawing mode shortcut
    if (matchesShortcut(e, shortcuts.toggleDraw)) {
      e.preventDefault();
      setDrawingMode(!isDrawingMode);
      // Auto-open sidebar when toggling drawing
      if (!isSidebarOpen) toggleSidebar(true);
      else renderSidebar();
      return;
    }
    // Ctrl key: show crosshair cursor only while held
    if (e.key === 'Control' && isDrawingMode) {
      document.documentElement.classList.add('highlighter-drawing-mode');
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Control') {
      document.documentElement.classList.remove('highlighter-drawing-mode');
    }
  }, true);

  // --- Sidebar ---
  function ensureSidebar() {
    if (sidebar && document.body.contains(sidebar)) return sidebar;
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;
    sidebar.style.cssText = `
      position:fixed;top:0;right:0;
      width:320px;height:100vh;
      background:#1e1e2e;color:#cdd6f4;
      z-index:2147483647;
      overflow-y:auto;
      box-shadow:-3px 0 10px rgba(0,0,0,0.3);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-size:13px;display:none;
    `;
    document.body.appendChild(sidebar);
    return sidebar;
  }

  function renderSidebar() {
    ensureSidebar();
    sidebar.innerHTML = '';

    // === Header ===
    const header = document.createElement('div');
    header.style.cssText =
      'padding:12px 16px;border-bottom:1px solid #45475a;display:flex;justify-content:space-between;align-items:center;';

    const title = document.createElement('strong');
    title.textContent = 'Highlighter';
    title.style.cssText = 'font-size:15px;color:#f5c2e7;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00D7';
    closeBtn.style.cssText =
      'background:none;border:none;color:#cdd6f4;font-size:22px;cursor:pointer;padding:0 4px;';
    closeBtn.addEventListener('click', () => toggleSidebar(false));
    header.appendChild(closeBtn);
    sidebar.appendChild(header);

    // === Controls Panel ===
    const controls = document.createElement('div');
    controls.style.cssText = 'padding:12px 16px;border-bottom:1px solid #45475a;';

    // Hint text
    const hint = document.createElement('div');
    if (isDrawingMode) {
      hint.style.cssText = 'padding:8px 12px;margin-bottom:10px;background:#1e66f5;color:#fff;border-radius:6px;font-size:12px;text-align:center;';
      hint.innerHTML = '\u25CF Drawing Mode ON &mdash; <strong>Ctrl + Drag</strong> to draw &nbsp;|&nbsp; <strong>' + shortcuts.stopDraw + '</strong> Stop';
    } else {
      hint.style.cssText = 'padding:6px 12px;margin-bottom:10px;color:#6c7086;font-size:12px;text-align:center;';
      hint.innerHTML = '<strong>' + shortcuts.toggleDraw + '</strong> toggle &nbsp;|&nbsp; <strong>' + shortcuts.stopDraw + '</strong> stop';
    }
    controls.appendChild(hint);

    // Draw toggle button
    const drawBtn = document.createElement('button');
    drawBtn.textContent = isDrawingMode ? 'Stop Drawing' : 'Start Drawing';
    drawBtn.style.cssText = `
      display:block;width:100%;padding:8px;margin-bottom:10px;
      border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;
      background:${isDrawingMode ? '#f38ba8' : '#89b4fa'};color:#1e1e2e;
      transition:background 0.2s;
    `;
    drawBtn.addEventListener('click', () => {
      setDrawingMode(!isDrawingMode);
      renderSidebar();
    });
    controls.appendChild(drawBtn);

    // Color + Opacity row
    const settingsRow = document.createElement('div');
    settingsRow.style.cssText = 'display:flex;align-items:center;gap:10px;';

    // Color picker
    const colorLabel = document.createElement('label');
    colorLabel.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:#a6adc8;';
    colorLabel.textContent = 'Color ';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = currentColor;
    colorInput.style.cssText = 'width:28px;height:28px;border:none;border-radius:4px;cursor:pointer;background:none;';
    colorInput.addEventListener('input', (e) => {
      currentColor = e.target.value;
      saveGlobalSettings();
    });
    colorLabel.appendChild(colorInput);
    settingsRow.appendChild(colorLabel);

    // Opacity slider
    const opacityLabel = document.createElement('label');
    opacityLabel.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:12px;color:#a6adc8;flex:1;';
    opacityLabel.textContent = 'Opacity ';
    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0.05';
    opacityInput.max = '1';
    opacityInput.step = '0.05';
    opacityInput.value = currentOpacity;
    opacityInput.style.cssText = 'flex:1;height:4px;accent-color:#89b4fa;';
    const opacityVal = document.createElement('span');
    opacityVal.textContent = Math.round(currentOpacity * 100) + '%';
    opacityVal.style.cssText = 'min-width:32px;text-align:right;font-size:11px;';
    opacityInput.addEventListener('input', (e) => {
      currentOpacity = parseFloat(e.target.value);
      opacityVal.textContent = Math.round(currentOpacity * 100) + '%';
      saveGlobalSettings();
    });
    opacityLabel.appendChild(opacityInput);
    opacityLabel.appendChild(opacityVal);
    settingsRow.appendChild(opacityLabel);

    controls.appendChild(settingsRow);
    sidebar.appendChild(controls);

    // === Box Count ===
    const countBar = document.createElement('div');
    countBar.style.cssText = 'padding:8px 16px;border-bottom:1px solid #313244;font-size:12px;color:#6c7086;';
    countBar.textContent = `${boxes.length} highlight${boxes.length !== 1 ? 's' : ''} on this page`;
    sidebar.appendChild(countBar);

    // === Box List ===
    if (boxes.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px 16px;text-align:center;color:#6c7086;';
      empty.textContent = 'No highlights yet. Start drawing!';
      sidebar.appendChild(empty);
    } else {
      const sorted = getSortedBoxes();

      sorted.forEach((box, index) => {
        const entry = document.createElement('div');
        entry.style.cssText = 'padding:10px 16px;border-bottom:1px solid #313244;';

        // Label row
        const label = document.createElement('div');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';

        const numBadge = document.createElement('span');
        numBadge.textContent = index + 1;
        numBadge.style.cssText = `
          display:inline-flex;align-items:center;justify-content:center;
          min-width:22px;height:22px;border-radius:11px;
          background:${box.color};color:#fff;
          font-size:11px;font-weight:700;padding:0 4px;
        `;
        label.appendChild(numBadge);

        const name = document.createElement('span');
        name.textContent = `Box #${index + 1}`;
        name.style.fontWeight = '600';
        label.appendChild(name);

        entry.appendChild(label);

        // Memo
        const memo = document.createElement('textarea');
        memo.value = box.memo || '';
        memo.placeholder = 'Add a note...';
        memo.rows = 2;
        memo.style.cssText =
          'width:100%;resize:vertical;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:4px;padding:4px 6px;font-size:12px;font-family:inherit;';
        memo.addEventListener('change', () => {
          box.memo = memo.value;
          saveBoxes();
        });
        entry.appendChild(memo);

        // Actions
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:6px;margin-top:6px;';

        const goBtn = document.createElement('button');
        goBtn.textContent = 'Go to';
        goBtn.style.cssText =
          'padding:3px 10px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;';
        goBtn.addEventListener('click', () => {
          window.scrollTo({ top: Math.max(0, box.y - 100), left: Math.max(0, box.x - 100), behavior: 'smooth' });
        });
        actions.appendChild(goBtn);

        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.style.cssText =
          'padding:3px 10px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;';
        delBtn.addEventListener('click', () => deleteBox(box.id));
        actions.appendChild(delBtn);

        entry.appendChild(actions);
        sidebar.appendChild(entry);
      });
    }

    // === Shortcuts Settings ===
    const scSection = document.createElement('div');
    scSection.style.cssText = 'padding:12px 16px;border-top:1px solid #45475a;';

    const scTitle = document.createElement('div');
    scTitle.textContent = 'Shortcuts';
    scTitle.style.cssText = 'font-size:12px;font-weight:600;color:#a6adc8;margin-bottom:8px;';
    scSection.appendChild(scTitle);

    const scEntries = [
      { key: 'toggleDraw', label: 'Toggle Drawing' },
      { key: 'stopDraw', label: 'Stop Drawing' }
    ];

    scEntries.forEach(({ key, label }) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;';

      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:12px;color:#6c7086;';
      row.appendChild(lbl);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:center;gap:6px;';

      const badge = document.createElement('span');
      badge.style.cssText = 'padding:2px 8px;background:#313244;border:1px solid #45475a;border-radius:4px;font-size:11px;font-family:monospace;color:#cdd6f4;';
      if (pendingShortcutKey === key) {
        badge.textContent = 'Press a key...';
        badge.style.background = '#1e66f5';
        badge.style.borderColor = '#1e66f5';
        badge.style.color = '#fff';
      } else {
        badge.textContent = shortcuts[key];
      }
      right.appendChild(badge);

      const changeBtn = document.createElement('button');
      changeBtn.textContent = pendingShortcutKey === key ? 'Cancel' : 'Change';
      changeBtn.style.cssText =
        'padding:2px 6px;background:none;border:1px solid #45475a;border-radius:3px;color:#a6adc8;font-size:10px;cursor:pointer;';
      changeBtn.addEventListener('click', () => {
        if (pendingShortcutKey === key) {
          pendingShortcutKey = null;
        } else {
          pendingShortcutKey = key;
        }
        renderSidebar();
      });
      right.appendChild(changeBtn);

      row.appendChild(right);
      scSection.appendChild(row);
    });

    sidebar.appendChild(scSection);
  }

  function toggleSidebar(forceState) {
    ensureSidebar();
    isSidebarOpen = forceState !== undefined ? forceState : !isSidebarOpen;
    sidebar.style.display = isSidebarOpen ? 'block' : 'none';
    if (isSidebarOpen) renderSidebar();
    chrome.storage.local.set({ sidebarOpen: isSidebarOpen });
  }

  async function saveGlobalSettings() {
    const settings = {
      defaultColor: currentColor,
      defaultOpacity: currentOpacity
    };
    await chrome.storage.local.set({ globalSettings: settings });
  }

  // --- Message Listener ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'TOGGLE_SIDEBAR':
        toggleSidebar();
        sendResponse({ ok: true, isSidebarOpen });
        break;
      case 'GET_STATE':
        sendResponse({ isDrawing: isDrawingMode, isSidebarOpen });
        break;
    }
    return true;
  });

  // --- SPA Navigation ---
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      loadBoxes();
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', () => loadBoxes());

  // --- Boot ---
  (async () => {
    const data = await chrome.storage.local.get(['globalSettings', 'sidebarOpen', 'drawingMode', 'shortcuts']);
    if (data.globalSettings) {
      currentColor = data.globalSettings.defaultColor || currentColor;
      currentOpacity = data.globalSettings.defaultOpacity ?? currentOpacity;
    }
    if (data.shortcuts) {
      shortcuts = { ...shortcuts, ...data.shortcuts };
    }
    await loadBoxes();
    if (data.sidebarOpen) toggleSidebar(true);
    if (data.drawingMode) setDrawingMode(true);
  })();
})();
