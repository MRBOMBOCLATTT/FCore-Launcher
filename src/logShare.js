const MAX_LINES = 25000;
const MAX_BYTES = 9 * 1024 * 1024;
const ENDPOINT = 'https://api.mclo.gs/1/log';

function redactLog(text) {
  return String(text)
    .replace(/(--(?:accessToken|clientId|xuid|session)[ =])\S+/gi, '$1[скрыто]')
    .replace(/((?:access|refresh|session|client)[_-]?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[скрыто]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[скрыто]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[скрыто]');
}

function prepareLog(text) {
  let lines = redactLog(text).split(/\r?\n/);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  let out = lines.join('\n');
  if (Buffer.byteLength(out, 'utf8') > MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(-MAX_BYTES).toString('utf8');
  }
  return out;
}

async function uploadLog(text, fetchImpl = fetch, timeoutMs = 20000) {
  const content = prepareLog(text);
  if (!content.trim()) throw new Error('Лог пуст');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ content }).toString(),
      signal: controller.signal
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'mclo.gs не отвечает, попробуйте позже' : `Не удалось отправить лог: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('mclo.gs вернул непонятный ответ');
  }
  if (!data || !data.success || typeof data.url !== 'string' || !/^https:\/\/mclo\.gs\//.test(data.url)) {
    throw new Error((data && data.error) || 'mclo.gs не принял лог');
  }
  return data.url;
}

module.exports = { redactLog, prepareLog, uploadLog };
