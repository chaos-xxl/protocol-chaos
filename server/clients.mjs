// Credentials for the Remote level (§9.2): one bearer token per client, each revocable alone.
//
// The tokens live in clients.json next to the repository file, readable by its owner only,
// and only as SHA-256 hashes: a token is shown once, when it is created. The file is read
// again whenever it changes, so a client removed while a server runs is refused at once.
// A token names a client, not a person: it decides which `actor` that connection may
// write as, nothing more.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'clients.json';
export const CLIENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_PREFIX = 'pc_';

const digest = (token) => createHash('sha256').update(token, 'utf8').digest();

export class Clients {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, FILE);
    this.loaded = undefined; // identity of the file as last read
    this.entries = [];
  }

  /** The current entries, read again only when the file changed. */
  load() {
    let stat;
    try {
      stat = statSync(this.file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.entries = [];
      this.loaded = 'none';
      return this.entries;
    }
    const identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (identity !== this.loaded) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.entries = Array.isArray(data?.clients) ? data.clients.filter((entry) => typeof entry?.name === 'string') : [];
      this.loaded = identity;
    }
    return this.entries;
  }

  list() {
    return this.load().map(({ name, createdAt }) => ({ name, createdAt }));
  }

  /** Creates a client and returns its token, which is not kept anywhere in clear. */
  add(name) {
    if (!CLIENT_NAME.test(name ?? '')) {
      throw new Error('A client name is 1 to 64 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or a digit, such as "laptop" or "hermes".');
    }
    const entries = this.load();
    if (entries.some((entry) => entry.name === name)) {
      throw new Error(`A client named "${name}" already exists. Remove it first to issue it a new token.`);
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.save([...entries, { name, tokenSha256: digest(token).toString('hex'), createdAt: new Date().toISOString() }]);
    return token;
  }

  /** Removes a client; its token stops working at once. False when there was none. */
  remove(name) {
    const entries = this.load();
    if (!entries.some((entry) => entry.name === name)) return false;
    this.save(entries.filter((entry) => entry.name !== name));
    return true;
  }

  /** The name of the client a bearer token was issued for, or undefined. */
  verify(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return undefined;
    const presented = digest(token);
    let match;
    for (const entry of this.load()) {
      const stored = Buffer.from(typeof entry.tokenSha256 === 'string' ? entry.tokenSha256 : '', 'hex');
      // Compare with every entry, so the time taken does not tell which one matched.
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = entry.name;
    }
    return match;
  }

  save(entries) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ clients: entries }, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    this.loaded = undefined;
  }
}
