(function (root) {
  function applyNotification(data) {
    const notice = document.getElementById('notice');
    const title = document.getElementById('title');
    const body = document.getElementById('body');
    if (!notice || !title || !body) return;
    const palettes = { green:['#6aa437','#8bc65a'], blue:['#3f7fc1','#62a0e0'], purple:['#7d54c4','#9c76de'], crimson:['#b6432f','#d65f47'], synt:['#d98a3d','#f0a855'] };
    const colors = palettes[data.theme] || palettes.green;
    const custom = data.theme === 'custom' && /^#[0-9a-f]{6}$/i.test(data.themeCustom || '');
    notice.style.setProperty('--accent', custom ? data.themeCustom : colors[0]);
    notice.style.setProperty('--accent-hi', custom ? data.themeCustom : colors[1]);
    notice.style.setProperty('--panel', data.themeMode === 'light' ? 'rgba(248,249,255,.97)' : 'rgba(22,25,55,.96)');
    notice.style.setProperty('--text', data.themeMode === 'light' ? '#171a2b' : '#eef1ff');
    notice.className = data.type || '';
    title.className = data.type || '';
    title.textContent = data.title || 'Уведомление';
    body.textContent = data.body || '';
    notice.classList.remove('show', 'hide');
    void notice.offsetWidth;
    notice.classList.add('show');
    clearTimeout(root.__hideTimer);
    root.__hideTimer = setTimeout(function () {
      notice.classList.remove('show');
      notice.classList.add('hide');
      clearTimeout(root.__removeTimer);
      root.__removeTimer = setTimeout(function () { notice.classList.remove('hide'); }, 250);
    }, 3800);
  }
  root.PFCSharedNotification = { apply: applyNotification };
})(window);
