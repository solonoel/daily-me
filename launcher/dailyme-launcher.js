/**
 * Daily Me File Launcher
 * Local HTTP server on port 3333 that opens files via Windows shell.
 * Installed to C:\Tools\DailyMe\ by start-dailyme-launcher.bat
 * Auto-registered as Windows startup item on first run.
 */

const http = require('http');
const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3333;
const LAUNCHER_NAME = 'DailyMeLauncher';

// ── STARTUP REGISTRATION ──────────────────────────────────────────────────────

function registerStartup() {
  try {
    const scriptPath = path.resolve(__filename);
    const batPath = path.join(path.dirname(scriptPath), 'start-dailyme-launcher.bat');
    const launchCmd = fs.existsSync(batPath)
      ? `"${batPath}"`
      : `"${process.execPath}" "${scriptPath}"`;

    try {
      const current = execSync(
        `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${LAUNCHER_NAME}"`,
        { stdio: 'pipe' }
      ).toString();
      if (current.includes(LAUNCHER_NAME)) {
        console.log('[Startup] Already registered.');
        return;
      }
    } catch(e) {}

    execSync(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${LAUNCHER_NAME}" /t REG_SZ /d "${launchCmd}" /f`,
      { stdio: 'pipe' }
    );
    console.log('[Startup] Registered as Windows startup item.');
  } catch (e) {
    console.warn('[Startup] Could not register startup item:', e.message);
  }
}

// ── OPEN FILE ─────────────────────────────────────────────────────────────────

function openFile(filePath, callback) {
  filePath = filePath.trim().replace(/^["']|["']$/g, '');
  if (!filePath) return callback(400, 'No file path provided');

  if (!fs.existsSync(filePath)) {
    console.warn('[Open] File not found:', filePath);
    return callback(404, 'File not found');
  }

  exec(`start "" "${filePath}"`, { shell: 'cmd.exe' }, (err) => {
    if (err) {
      console.error('[Open] Error:', err.message);
      return callback(500, `Failed to open: ${err.message}`);
    }
    callback(200, 'OK');
  });
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/ping') {
    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
    return;
  }

  if (url.pathname === '/browse') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.OpenFileDialog',
      '$f.Title = "Select File for Daily Me"',
      '$f.Filter = "All Files (*.*)|*.*"',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$dummy = New-Object System.Windows.Forms.Form',
      '$dummy.TopMost = $true',
      '$dummy.StartPosition = "CenterScreen"',
      '$dummy.Size = New-Object System.Drawing.Size(1,1)',
      '$dummy.Show()',
      '$dummy.Hide()',
      '$result = $f.ShowDialog($dummy)',
      '$dummy.Dispose()',
      'if ($result -eq "OK") { $f.FileName } else { "" }'
    ].join('; ');
    exec(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, { timeout: 120000 }, (err, stdout) => {
      const filePath = (stdout || '').trim();
      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({ path: filePath || null }));
    });
    return;
  }

  if (url.pathname === '/open') {
    const filePath = url.searchParams.get('path') || '';
    console.log('[Open] Request:', filePath);
    openFile(filePath, (statusCode, message) => {
      res.writeHead(statusCode, CORS_HEADERS);
      res.end(JSON.stringify({ status: statusCode === 200 ? 'ok' : 'error', message }));
    });
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`[Server] Port ${PORT} already in use — launcher may already be running.`);
    process.exit(0);
  } else {
    console.error('[Server] Error:', e.message);
    process.exit(1);
  }
});

registerStartup();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Daily Me Launcher] Running on http://localhost:${PORT}`);
});
