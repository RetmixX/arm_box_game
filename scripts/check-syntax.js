// Проверка синтаксиса всех web/assets/*.js: `node --check` берёт только один файл,
// а glob в npm-скриптах на Windows не раскрывается — поэтому перебираем файлы сами.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'web', 'assets');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'inherit' });
  } catch (_) {
    failed++;
  }
}
console.log(failed ? 'Синтаксис: ошибки в ' + failed + ' из ' + files.length + ' файлов' : 'Синтаксис: ' + files.length + ' файлов без ошибок');
process.exit(failed ? 1 : 0);
