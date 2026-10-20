// File storage for the reference server. The repository is one JSON file in the export
// format of §8.6, so its owner can read it, back it up, and move it to another server.
//
// Several processes may share the file: an assistant usually starts its own server.
// Every write takes a lock file, reloads what other processes committed, applies the
// change, and replaces the file in one rename, so no process overwrites what another has
// committed (§5.1) and the file is never left half-written. Reads reload the file when
// another process has changed it.
import {
  closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { Repository } from './repository.mjs';
import { ProtocolError } from './validate.mjs';

const FILE = 'repository.json';
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export class Store {
  constructor(directory) {
    this.file = join(directory, FILE);
    this.lockFile = `${this.file}.lock`;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.repo = new Repository();
    this.loaded = undefined; // identity of the file as last read or written
    this.writes = Promise.resolve(); // writes of this process, one after another
    try {
      this.refresh();
    } catch {
      // A damaged file is reported by every call instead, so the server still starts.
    }
  }

  /** A read: sees everything committed so far, by any process. */
  read(run) {
    this.refresh();
    return run(this.repo);
  }

  /** A write: one at a time across every process that shares the file. */
  write(run) {
    const next = this.writes.then(async () => {
      await this.lock();
      try {
        this.refresh();
        const before = this.repo.version;
        try {
          const result = run(this.repo);
          if (this.repo.version !== before) this.save();
          return result;
        } catch (error) {
          // A rejected write changes nothing, but read the file again rather than trust memory.
          this.loaded = undefined;
          throw error;
        }
      } finally {
        this.unlock();
      }
    });
    this.writes = next.catch(() => {});
    return next;
  }

  /** Reloads the file if another process replaced it since this one last read or wrote it. */
  refresh() {
    let fd;
    try {
      fd = openSync(this.file, 'r');
    } catch (error) {
      if (error.code !== 'ENOENT') throw this.unreadable(error);
      if (this.loaded !== 'none') {
        this.repo = new Repository();
        this.loaded = 'none';
      }
      return;
    }
    try {
      const stat = fstatSync(fd);
      const identity = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      if (identity === this.loaded) return;
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const read = readSync(fd, buffer, offset, stat.size - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      const repo = new Repository();
      try {
        repo.importRepository({ snapshot: JSON.parse(buffer.subarray(0, offset).toString('utf8')) });
      } catch (error) {
        throw this.unreadable(error);
      }
      this.repo = repo;
      this.loaded = identity;
    } finally {
      closeSync(fd);
    }
  }

  save() {
    const snapshot = this.repo.exportRepository({});
    const temporary = `${this.file}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file);
    const stat = statSync(this.file);
    this.loaded = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  async lock() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600);
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
        closeSync(fd);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      this.clearStaleLock();
      if (Date.now() > deadline) {
        throw new ProtocolError('REPOSITORY_BUSY', 'Another assistant is writing to this repository. Nothing was changed; try again in a moment.');
      }
      await pause(15);
    }
  }

  unlock() {
    rmSync(this.lockFile, { force: true });
  }

  /** A lock left behind by a process that ended, or held far longer than any write takes. */
  clearStaleLock() {
    let content;
    let age;
    try {
      content = readFileSync(this.lockFile, 'utf8');
      age = Date.now() - statSync(this.lockFile).mtimeMs;
    } catch {
      return;
    }
    // A lock still being written has no pid yet; only its age can make it stale.
    const pid = Number(content.trim().split(' ')[0]);
    const stale = age > STALE_LOCK_MS || (Number.isInteger(pid) && pid > 0 && !alive(pid));
    if (!stale) return;
    try {
      if (readFileSync(this.lockFile, 'utf8') === content) rmSync(this.lockFile, { force: true });
    } catch {
      // Someone else cleared it first.
    }
  }

  unreadable(error) {
    return new ProtocolError(
      'INTERNAL_ERROR',
      `The repository file ${this.file} could not be read (${error.message}). Nothing was changed; the file was left as it is.`,
    );
  }
}
