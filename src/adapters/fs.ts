import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'

export interface FsLike {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean } | null>
  realpath(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  append(path: string, text: string): Promise<void>
  mkdir(path: string): Promise<void>
  list(dir: string): Promise<string[]>
}

export const nodeFs: FsLike = {
  async lstat(path) {
    try {
      return await lstat(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  },
  realpath,
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  read: (path) => readFile(path, 'utf8'),
  write: (path, text) => writeFile(path, text, 'utf8'),
  append: (path, text) => appendFile(path, text, 'utf8'),
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },
  list: (dir) => readdir(dir),
}
