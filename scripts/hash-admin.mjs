import { randomBytes, scryptSync } from 'node:crypto';
import { emitKeypressEvents } from 'node:readline';

if (!process.stdin.isTTY) {
  console.error('터미널에서 직접 실행해 주세요.');
  process.exit(1);
}
console.log('새 관리자 비밀번호를 입력하세요 (화면에 표시되지 않습니다):');
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();
let password = '';
process.stdin.on('keypress', (str, key) => {
  if (key.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.exit(130); }
  if (key.name === 'return') {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    if (password.length < 12) { console.error('비밀번호는 12자 이상이어야 합니다.'); process.exitCode = 1; return; }
    const salt = randomBytes(16);
    console.log(`scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`);
    console.log('위 해시를 Vercel의 ADMIN_PASSWORD_HASH 보안 환경변수에 설정하세요.');
    return;
  }
  if (key.name === 'backspace') { password = password.slice(0, -1); return; }
  if (!key.ctrl && !key.meta && str) password += str;
});
