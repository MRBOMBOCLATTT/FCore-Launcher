const { execFile } = require('child_process');

const PREFS = {
  auto: 'GpuPreference=0;',
  powersaving: 'GpuPreference=1;',
  performance: 'GpuPreference=2;'
};

// Та же штука, что в Параметры Windows -> Экран -> Графика -> выбрать GPU
// для приложения, просто прописываем это для конкретного javaw.exe сами
// Асинхронно и без оболочки: раньше execSync поднимал cmd + reg.exe на каждый запуск игры
// и блокировал главный процесс; аргументы списком заодно не ломаются на кавычках в пути
function setGpuPreference(exePath, preference) {
  if (process.platform !== 'win32') return Promise.resolve();

  const value = PREFS[preference] || PREFS.auto;
  const regPath = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';

  return new Promise(resolve => {
    // ошибка не критична — просто не подставится нужная видеокарта
    try {
      execFile('reg', ['add', regPath, '/v', exePath, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, () => resolve());
    } catch {
      resolve();
    }
  });
}

module.exports = { setGpuPreference };
