#!/usr/bin/env node
// Scripted stand-in used only by scripts/snapshot.ts to produce the README screenshot.
// It is NOT a real agent: it prints a canned transcript and keeps a spinner going.
const id = process.env.COBAN_AGENT ?? '';
const task = process.argv.slice(2).filter((a, i, all) => !(a === '--model' || all[i - 1] === '--model')).join(' ');
const w = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
const c = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', acc: '\x1b[38;5;173m', ok: '\x1b[38;5;114m', blue: '\x1b[38;5;110m' };

if (id === 'orkestra') {
  w(`\n${c.dim}>${c.r} coban'a e-posta ile giriş ekleyelim: API, istemci ve testler paralel gitsin.\n\n`);
  w(`${c.acc}⏺${c.r} İşi üç bağımsız parçaya bölüyorum. Önce hangi hesabın boş olduğuna bakıyorum.\n\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Bash${c.r}(coban usage)\n  ${c.dim}⎿  h2  5s 5%   ·   h1  5s 7%   ·   h3  5s 12%${c.r}\n\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Bash${c.r}(coban spawn h2 "HEDEF: POST /login …" --ctx "src/api.ts#router")\n  ${c.dim}⎿  açıldı: api${c.r}\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Bash${c.r}(coban spawn h3 "HEDEF: giriş formu …" --ctx "web/Login.tsx")\n  ${c.dim}⎿  açıldı: istemci${c.r}\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Bash${c.r}(coban spawn h1 "HEDEF: login uçtan uca testleri …")\n  ${c.dim}⎿  açıldı: test${c.r}\n\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Bash${c.r}(coban wait --timeout 600)\n  ${c.dim}⎿  ✉ api: POST /login hazır, {token, user} döndürüyor${c.r}\n\n`);
  w(`${c.acc}⏺${c.r} api bitti. istemci ve test hâlâ çalışıyor; test bir izin bekliyor, bakıyorum.\n\n`);
} else if (task) {
  w(`\n${c.dim}>${c.r} ${task.replace(/^\[coban\][\s\S]*?GÖREV:\s*/, '').slice(0, 70)}\n\n`);
  w(`${c.acc}⏺${c.r} ${c.b}Read${c.r}(src/api.ts)\n  ${c.dim}⎿  Read 120 lines${c.r}\n`);
  if (task.includes('ASK')) {
    w(`\n ${c.b}Bash command${c.r}\n   npx playwright test login.spec.ts\n\n Do you want to proceed?\n ${c.blue}❯ 1. Yes${c.r}\n   2. No\n`);
    setInterval(() => {}, 1 << 30);
  }
}
if (!task.includes('ASK')) {
  const frames = '✻✶✳✢·';
  let i = 0;
  setInterval(() => w(`\r${c.acc}${frames[i++ % frames.length]}${c.r} Çalışıyor… ${c.dim}(esc to interrupt)${c.r}\x1b[K`), 120);
}
