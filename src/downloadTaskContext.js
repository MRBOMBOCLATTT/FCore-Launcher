const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithDownloadContext(context, operation) {
  return storage.run(context, operation);
}

function getDownloadContext() {
  return storage.getStore() || null;
}

module.exports = { runWithDownloadContext, getDownloadContext };
