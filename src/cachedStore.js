const Store = require('electron-store');

// electron-store (точнее, conf под ним) при КАЖДОМ get() заново читает файл настроек с диска
// и парсит весь JSON. На большом конфиге (много сборок и модов) это ~2 мс на один get(),
// а на открытие разделов их приходятся десятки подряд — отсюда подтормаживания интерфейса.
//
// Здесь кэшируем только чтение через get():
//  • кэш сбрасывается при любой записи (set/delete/reset — всё идёт через сеттер store),
//    поэтому устаревших данных не бывает: файл пишет только этот процесс;
//  • наружу отдаём копию объектов/массивов, как и раньше (раньше каждый get() парсил файл заново,
//    и мутация результата не влияла на хранилище) — поведение для вызывающего кода не меняется;
//  • запись, onDidAnyChange, has() и прочее читают файл как раньше: onDidAnyChange сравнивает
//    старое и новое состояние, и ему нужны независимые снимки, а не общий объект.
class CachedStore extends Store {
  get store() {
    if (this._fcReading) {
      if (this._fcCache === undefined) this._fcCache = super.store;
      return this._fcCache;
    }
    return super.store;
  }

  set store(value) {
    this._fcCache = undefined;
    try {
      super.store = value;
    } finally {
      this._fcCache = undefined;
    }
  }

  get(key, defaultValue) {
    this._fcReading = true;
    let value;
    try {
      value = super.get(key, defaultValue);
    } finally {
      this._fcReading = false;
    }
    return value !== null && typeof value === 'object' ? structuredClone(value) : value;
  }
}

module.exports = CachedStore;
