import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('.').filter(f => /^\d\d-.*\.ts$/.test(f)).sort();
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 45000);
const CONC = Number(process.env.CONC || 4);

function run(file) {
  return new Promise(resolve => {
    const p = spawn('npx', ['tsx', file], { cwd: process.cwd(), env: process.env });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => {
      clearTimeout(t);
      let status = code === 0 ? 'PASS' : (code === null ? 'TIMEOUT' : 'FAIL(' + code + ')');
      const first = err.split('\n').map(l => l.trim()).filter(l => /Error|error TS|Cannot find|not assignable|SyntaxError|TypeError|ReferenceError|ERR_/.test(l))[0] || '';
      resolve({ file, status, first: first.slice(0, 150) });
    });
  });
}

const results = [];
const queue = [...files];
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const f = queue.shift();
    results.push(await run(f));
  }
}));

results.sort((a, b) => a.file.localeCompare(b.file));
let pass = 0;
for (const r of results) {
  if (r.status === 'PASS') pass++;
  console.log(r.file.padEnd(32) + r.status.padEnd(9) + (r.status === 'PASS' ? '' : r.first));
}
console.log('\nPASS ' + pass + '/' + results.length);
