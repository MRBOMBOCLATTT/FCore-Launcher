const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// i18n.js рассчитан на браузер, поэтому гоняем его в изолированном контексте с минимальным окружением
function loadTranslator(lang) {
  const window = {};
  const context = vm.createContext({
    window,
    localStorage: { getItem: () => lang, setItem() {} },
    document: { documentElement: {}, body: null, addEventListener() {} },
    Node: {}, NodeFilter: {}, MutationObserver: class {}
  });
  for (const file of ['i18n-en.js', 'i18n-changelog-en.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf-8'), context);
  }
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/i18n.js'), 'utf-8'), context);
  return { t: window.i18n.t, i18n: window.i18n, dict: context.window.I18N_EN };
}

test('русский язык: текст не меняется', () => {
  const { t, i18n } = loadTranslator('ru');
  assert.equal(t('Настройки'), 'Настройки');
  assert.equal(i18n.locale, 'ru-RU');
});

test('английский: точные строки и пробелы по краям', () => {
  const { t, i18n } = loadTranslator('en');
  assert.equal(i18n.locale, 'en-US');
  assert.equal(t('Настройки'), 'Settings');
  assert.equal(t('  Загрузка...  '), '  Loading...  ');
});

test('английский: шаблоны с подстановкой', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Скачиваю «Fabric API» (2 из 3)...'), 'Downloading "Fabric API" (2 of 3)...');
  assert.equal(t('Версия 1.21.1 сейчас недоступна в списке'), 'Version 1.21.1 is currently unavailable in the list');
  assert.equal(t('Мало оперативной памяти: 1024 МБ'), 'Low RAM: 1024 MB');
});

test('английский: префикс с причиной ошибки сохраняет причину', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Не удалось загрузить статистику: network down'), 'Could not load the statistics: network down');
});

test('неизвестные строки и английский текст остаются как есть', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Совсем неизвестная строка'), 'Совсем неизвестная строка');
  assert.equal(t('Already English'), 'Already English');
});

test('шаблоны не совпадают с произвольным текстом', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Какой-то случайный текст'), 'Какой-то случайный текст');
});

test('словарь: нет пустых значений и русских букв в переводах', () => {
  const { dict } = loadTranslator('en');
  for (const [ru, en] of Object.entries(dict.exact)) {
    assert.ok(en.length > 0, `пустой перевод: ${ru}`);
    assert.equal(/[А-Яа-яЁё]/.test(en), false, `в переводе осталась кириллица: ${ru}`);
  }
  for (const [ru, en] of dict.templates) {
    assert.equal(/[А-Яа-яЁё]/.test(en), false, `в переводе осталась кириллица: ${ru}`);
  }
});

test('диалог Синта: реплики, выбор и шаблон с IP', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Здарова чебзик, как ты?'), "Yo, buddy, how's it going?");
  assert.equal(t('Нажать на кнопку'), 'Press the button');
  assert.equal(t('Меня зовут '), 'My name is ');
  assert.equal(t('Синт'), 'Synth');
  const rude = t('Вот это нихуя себе заявочка, вот так вот мы заговорили, слушай меня сюда, я знаю кто ты и где ты живешь (12.34.56.78), и у меня вопрос, какого хуя ты тут делаешь?');
  assert.match(rude, /where you live \(12\.34\.56\.78\)/);
  assert.equal(/[А-Яа-яЁё]/.test(rude), false);
});

test('ошибки Mojang из главного процесса переводятся', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Mojang временно ограничил количество запросов. Подождите 42 с и повторите.'),
    'Mojang has temporarily limited the number of requests. Wait 42 s and try again.');
});

test('«для некоторых модов» не превращается в «mods» посреди русской фразы', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('Какая-то фраза для некоторых модов'), 'Какая-то фраза для некоторых модов');
  assert.equal(t('5 модов'), '5 mods');
});

test('числа и единицы в шаблонах', () => {
  const { t } = loadTranslator('en');
  assert.equal(t('32 изменений'), '32 changes');
  assert.equal(t('1 изменение'), '1 change');
  assert.equal(t('Страница 2 из 5'), 'Page 2 of 5');
  assert.equal(t('Миров: 3, занимают 117.7 MB'), 'Worlds: 3, taking 117.7 MB');
});
