'use strict';

// Run a shell command via the unified channel (SSH or local) and collect
// stdout/stderr/exit into a single resolved object.
async function runCommand(ch, command) {
  const stream = await ch.exec(command);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    stream.on('data', (c) => { stdout += c.toString('utf8'); });
    stream.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    stream.on('exit', (code) => { exitCode = code; });
    stream.on('close', () => resolve({ stdout, stderr, exitCode }));
    stream.on('error', reject);
  });
}

module.exports = runCommand;
