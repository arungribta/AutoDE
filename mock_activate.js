// Simple script to load the compiled extension and call activate with a mock context
const path = require('path');
const ext = require('./dist/extension.js');

const mockContext = {
  extensionUri: { fsPath: path.resolve(__dirname) },
  subscriptions: [],
  secrets: {
    async store(k, v) { console.log('[mock secrets] store', k); this._store = this._store || {}; this._store[k] = v; },
    async get(k) { console.log('[mock secrets] get', k); return this._store ? this._store[k] : undefined; },
    async delete(k) { console.log('[mock secrets] delete', k); if (this._store) delete this._store[k]; }
  }
};

async function run() {
  console.log('Calling activate...');
  try {
    if (typeof ext.activate === 'function') {
      await ext.activate(mockContext);
      console.log('activate completed successfully');
    } else {
      console.log('No activate function exported');
    }
  } catch (e) {
    console.error('activate threw an error:', e);
  }
}

run();
