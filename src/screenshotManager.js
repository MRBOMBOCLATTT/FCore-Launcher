const fs = require('fs');
const path = require('path');

const IMAGE_EXT = /\.(png|jpg|jpeg)$/i;

function getInstancesRoot(root) {
  return path.join(root, 'instances');
}

// собирает скриншоты со всех версий+лоадеров сразу, а не только с текущей выбранной —
// чтобы галерея показывала вообще все, что накопились
function listScreenshots(root) {
  const instancesRoot = getInstancesRoot(root);
  if (!fs.existsSync(instancesRoot)) return [];

  const results = [];
  for (const instanceName of fs.readdirSync(instancesRoot)) {
    const dir = path.join(instancesRoot, instanceName, 'screenshots');
    if (!fs.existsSync(dir)) continue;

    for (const fileName of fs.readdirSync(dir)) {
      if (!IMAGE_EXT.test(fileName)) continue;
      const filePath = path.join(dir, fileName);
      const stat = fs.statSync(filePath);
      results.push({
        filePath,
        fileName,
        instance: instanceName,
        mtime: stat.mtimeMs
      });
    }
  }

  return results;
}

function deleteScreenshot(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { getInstancesRoot, listScreenshots, deleteScreenshot };
