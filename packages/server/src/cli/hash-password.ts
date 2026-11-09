/**
 * Генерация bcrypt-хэша для config.yaml.
 *   npm run hash-password              — спросит пароль (ввод скрыт)
 *   npm run hash-password -- 'пароль'  — из аргумента (останется в истории shell!)
 */
import bcrypt from 'bcryptjs';

async function readHidden(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    // Пароль из пайпа: echo -n 'pass' | npm run hash-password
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  let password = process.argv[2];
  if (!password) {
    password = await readHidden('Пароль: ');
    if (process.stdin.isTTY) {
      const again = await readHidden('Ещё раз: ');
      if (again !== password) {
        console.error('Пароли не совпадают');
        process.exit(1);
      }
    }
  }
  if (password.length < 8) {
    console.error('Пароль должен быть не короче 8 символов');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

void main();
