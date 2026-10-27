const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A separately branded development executable, sharing the installed Electron runtime.
// Never overwrite electron.exe or touch an installed application/userData.
function prepareDevLauncher() {
  if (process.platform !== 'win32') return null;
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'node_modules/electron/dist/electron.exe');
  // Electron identifies an un-packaged Windows runtime by the executable name.
  // Keep electron.exe in a separate directory, so helper and development paths remain correct.
  const runtimeDir = path.join(path.dirname(source), 'bidxu-dev-runtime');
  const destination = path.join(runtimeDir, 'electron.exe');
  const manifestPath = path.join(runtimeDir, 'bidxu-dev-brand.json');
  const icon = fs.readFileSync(path.join(root, 'assets/bidxu-icon.ico'));
  const sourceStat = fs.statSync(source);
  const fingerprint = JSON.stringify({ version: 2, size: sourceStat.size, modified: sourceStat.mtimeMs,
    icon: crypto.createHash('sha256').update(icon).digest('hex') });
  try {
    if (fs.existsSync(destination) && fs.readFileSync(manifestPath, 'utf8') === fingerprint) return destination;
  } catch {}

  fs.mkdirSync(runtimeDir, { recursive: true });
  for (const entry of fs.readdirSync(path.dirname(source), { withFileTypes: true })) {
    if (['electron.exe', 'Bidxu-dev.exe', 'bidxu-dev-brand.json', 'bidxu-dev-runtime'].includes(entry.name)
      || entry.name.endsWith('.tmp')) continue;
    const from = path.join(path.dirname(source), entry.name);
    const to = path.join(runtimeDir, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(to)) fs.symlinkSync(from, to, 'junction');
    } else if (entry.isFile()) {
      if (fs.existsSync(to)) {
        const current = fs.statSync(to);
        const expected = fs.statSync(from);
        if (current.size === expected.size && current.mtimeMs === expected.mtimeMs) continue;
        fs.unlinkSync(to);
      }
      try { fs.linkSync(from, to); }
      catch { fs.copyFileSync(from, to); }
    }
  }

  const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');
  const executable = NtExecutable.from(fs.readFileSync(source), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const iconFile = Data.IconFile.from(icon);
  const groups = resources.entries.filter(entry => entry.type === 14);
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang,
      iconFile.icons.map(item => item.data));
  }
  for (const version of Resource.VersionInfo.fromEntries(resources.entries)) {
    for (const language of version.getAvailableLanguages()) {
      version.setStringValues(language, { FileDescription: '标序开发预览', ProductName: '标序',
        InternalName: 'Bidxu-dev', OriginalFilename: 'electron.exe' });
    }
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, Buffer.from(executable.generate()));
    fs.renameSync(temporary, destination);
    fs.writeFileSync(manifestPath, fingerprint, 'utf8');
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return destination;
}

if (require.main === module) {
  try {
    const destination = prepareDevLauncher();
    if (destination) console.log('标序开发启动图标已就绪。');
  } catch (error) {
    console.error(`无法准备标序开发入口：${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { prepareDevLauncher };
