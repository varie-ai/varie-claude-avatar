const crypto = require('node:crypto');
const os = require('node:os');

function getIpcEndpoint(platform = process.platform, homeDir = os.homedir()) {
  if (platform !== 'win32') return '/tmp/varie-claude-avatar.sock';
  const normalized = homeDir.replaceAll('/', '\\').toLowerCase();
  const userKey = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\varie-claude-avatar-${userKey}`;
}

module.exports = { getIpcEndpoint };
