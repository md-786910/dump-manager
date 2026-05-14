'use strict';

// Open an SSH connection to the Server and close it. Success means:
//   - host key passes the pin policy (or TOFU was accepted)
//   - key + passphrase authenticated successfully
//   - sshd accepted the session
// That's enough to declare the Server "connected" for the session.

const sshClient = require('../ssh/client');

async function run({ server, privateKey, passphrase, knownHosts, onUntrustedHost }) {
  const client = await sshClient.connect({
    host: server.host,
    port: server.port,
    username: server.user,
    privateKey,
    passphrase,
    knownHosts,
    onUntrustedHost,
  });
  try { client.end(); } catch { /* already closed */ }
}

module.exports = { run };
