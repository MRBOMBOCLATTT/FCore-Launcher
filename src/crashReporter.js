const fs = require('fs');
const path = require('path');

function getCrashDir(root) {
  const dir = path.join(root, 'crash-reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Простой разбор частых причин краша по коду выхода и последним строкам лога —
// не претендует на точный диагноз, но экономит время на банальных случаях
// вместо того чтобы гуглить голый код выхода
function diagnoseCrash({ code, recentLines = [] }) {
  const text = recentLines.join('\n');

  // ForgeWrapper (через него minecraft-launcher-core ставит Forge/NeoForge) на
  // самых свежих версиях NeoForge иногда не может разобрать установщик. Ошибка
  // выглядит непонятно, поэтому сразу подсказываем рабочий обходной путь
  if (/Unable to detect the forge installer/i.test(text)) {
    return 'Установщик NeoForge не по зубам текущей версии ForgeWrapper — так бывает на самых свежих сборках NeoForge. Закрепи в настройках ("Версия NeoForge") сборку постарее или запусти эту версию игры на Fabric/Forge.';
  }

  if (/OutOfMemoryError/i.test(text)) {
    return 'Не хватило оперативной памяти (OutOfMemoryError). Попробуй увеличить лимит ОЗУ в настройках лаунчера.';
  }

  if (/mixin.*fail|MixinApplyError|mixin config/i.test(text)) {
    const modMatch = text.match(/mixin(?:s?)? config \[([^\]]+)\]/i) || text.match(/from mod ['"]?([\w-]+)['"]?/i);
    return modMatch
      ? `Конфликт mixin у мода "${modMatch[1]}" — вероятно, он несовместим с текущей версией Minecraft/Forge/Fabric или с другим модом.`
      : 'Конфликт mixin между модами — какой-то мод внедряет несовместимые правки в код игры. Попробуй отключать моды по одному.';
  }

  if (/ClassNotFoundException|NoClassDefFoundError/i.test(text)) {
    const classMatch = text.match(/(?:ClassNotFoundException|NoClassDefFoundError):\s*([\w.$]+)/);
    return classMatch
      ? `Не найден класс "${classMatch[1]}" — скорее всего, отсутствует библиотека-зависимость одного из модов. Попробуй переустановить моды.`
      : 'Отсутствует нужный класс/библиотека — скорее всего, не хватает зависимости мода. Попробуй переустановить моды.';
  }

  if (/UnsupportedClassVersionError|has been compiled by a more recent version/i.test(text)) {
    return 'Мод скомпилирован под более новую версию Java, чем установлена. Попробуй проверить совместимость Java в настройках.';
  }

  if (/Duplicate mod|duplicate.*mod id/i.test(text)) {
    return 'Обнаружены два мода с одинаковым ID — удали дубликат из папки модов.';
  }

  if (/incompatible.*(neo)?forge|requires (neo)?forge version|requires fabric loader version/i.test(text)) {
    return 'Один из модов требует другую версию загрузчика (Forge/NeoForge/Fabric), чем сейчас установлена.';
  }

  if (code === 1) {
    return 'Общая ошибка (код 1) — чаще всего вызвана несовместимым или битым модом. Смотри строки выше со словом "Exception" или "Error".';
  }

  if (code === 134) {
    return 'Аварийное завершение JVM (SIGABRT, код 134) — часто из-за нехватки видеопамяти или конфликта в нативных библиотеках (шейдеры/оптимизации).';
  }

  if (code === -1073740791 || code === 3221226505) {
    return 'Игра упала на уровне JVM/драйвера видеокарты. Попробуй обновить драйверы видеокарты или сменить настройку GPU в лаунчере.';
  }

  return null;
}

// Пишем локальный отчёт о падении — код завершения, версия/лоадер,
// последние строки лога — чтобы не просить логи вручную при разборе жалоб
function writeCrashReport(root, { mcVersion, loader, code, recentLines = [], error = null }) {
  const dir = getCrashDir(root);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `crash-${timestamp}.log`);

  const diagnosis = diagnoseCrash({ code, recentLines });

  const header = [
    `Время: ${new Date().toLocaleString('ru-RU')}`,
    `Версия: ${mcVersion} (${loader})`,
    code !== undefined ? `Код завершения: ${code}` : null,
    error ? `Ошибка: ${error}` : null,
    diagnosis ? `` : null,
    diagnosis ? `Предполагаемая причина: ${diagnosis}` : null,
    '',
    '--- последние строки лога ---'
  ].filter(l => l !== null).join('\n');

  fs.writeFileSync(filePath, `${header}\n${recentLines.join('\n')}`);
  return filePath;
}

function listCrashReports(root) {
  const dir = getCrashDir(root);
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse()
    .map(f => ({ fileName: f, path: path.join(dir, f) }));
}

module.exports = { getCrashDir, writeCrashReport, listCrashReports, diagnoseCrash };
