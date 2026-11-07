// Uso: npm run release -- 0.2.1
// Alza la versione (package.json, Cargo.toml e i lock), committa, crea il tag vX.Y.Z e lo pubblica: la build parte su GitHub.
const fs = require('fs');
const { execSync } = require('child_process');

const version = process.argv[2];
const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd) => execSync(cmd).toString().trim();
const fail = (msg) => { console.error(msg); process.exit(1); };

if (!/^\d+\.\d+\.\d+$/.test(version || '')) fail('Uso: npm run release -- X.Y.Z');
if (out('git branch --show-current') !== 'main') fail('Il rilascio si fa da main');
if (out('git status --porcelain')) fail('Ci sono modifiche non committate: committale prima');
if (out(`git tag -l v${version}`)) fail(`Il tag v${version} esiste gia'`);

const cargo = 'src-tauri/Cargo.toml';
const text = fs.readFileSync(cargo, 'utf8');
if (!/^version = "[^"]*"/m.test(text)) fail('Versione non trovata in ' + cargo);
fs.writeFileSync(cargo, text.replace(/^version = "[^"]*"/m, `version = "${version}"`));

sh(`npm version ${version} --no-git-tag-version`); // package.json e package-lock.json
sh(`cargo update -w --manifest-path ${cargo}`); // Cargo.lock
sh('git add -A');
sh(`git commit -m "Versione ${version}"`);
sh(`git tag v${version}`);
sh(`git push origin main v${version}`);
console.log(`\nv${version} pubblicato: la build e' in corso su GitHub (Actions), poi compare tra le Release.`);
