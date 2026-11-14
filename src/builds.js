// Сборки: именованные независимые инстансы (свои моды, ресурспаки, шейдеры, миры, настройки).
// Модуль хранит только то, что нужно для подмены папки и ключа инстанса.
// Пока активной сборки нет, всё работает по-старому: instances/<версия>-<загрузчик>.

let active = null; // { id, mcVersion, loader }

function setActive(build) {
  active = build ? { id: build.id, mcVersion: build.mcVersion, loader: build.loader, folder: build.folder || null } : null;
}

function getActive() {
  return active;
}

function folderName(mcVersion, loader) {
  // подмена работает только для пары версия+загрузчик активной сборки,
  // остальные (старые) инстансы остаются на прежних папках
  if (active && active.mcVersion === mcVersion && active.loader === loader) {
    return `build-${active.id}`;
  }
  return `${mcVersion}-${loader}`;
}

// настоящая папка на диске: у сборки она названа по её имени, а ключ в настройках остаётся build-<id>
function dirName(mcVersion, loader) {
  if (active && active.mcVersion === mcVersion && active.loader === loader) {
    return active.folder || `build-${active.id}`;
  }
  return `${mcVersion}-${loader}`;
}

module.exports = { setActive, getActive, folderName, dirName };
