// Types only: the few Node built-ins the worker uses, so `tsc` passes without @types/node
// (Orca ships no Node typings and node_modules is not committed). No runtime effect.

declare const process: {
  env: Record<string, string | undefined>
  platform: string
}

declare module 'node:child_process' {
  export interface Readable {
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
    setEncoding(encoding: string): this
  }
  export interface Writable {
    end(data?: string): void
    on(event: 'error', listener: (error: Error) => void): this
  }
  export interface ChildProcess {
    readonly pid?: number
    readonly stdin: Writable | null
    readonly stdout: Readable | null
    readonly stderr: Readable | null
    kill(signal?: string): boolean
    on(event: 'error', listener: (error: Error) => void): this
    on(event: 'close', listener: (code: number | null, signal: string | null) => void): this
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options?: { stdio?: readonly string[]; env?: Record<string, string | undefined> }
  ): ChildProcess
  export function execFile(
    file: string,
    args: readonly string[],
    options: {
      env?: Record<string, string | undefined>
      timeout?: number
      maxBuffer?: number
      encoding?: string
      cwd?: string
    },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): ChildProcess
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string): { digest(encoding: 'hex'): string }
  }
}

declare module 'node:fs' {
  export interface Dirent {
    readonly name: string
    isDirectory(): boolean
  }
  export const constants: { readonly X_OK: number }
  export const promises: {
    readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    mkdir(path: string, options: { recursive: true }): Promise<unknown>
    rename(from: string, to: string): Promise<void>
    rm(path: string, options: { force: true }): Promise<void>
    realpath(path: string): Promise<string>
    stat(path: string): Promise<{ isDirectory(): boolean }>
    access(path: string, mode?: number): Promise<void>
  }
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function resolve(...parts: string[]): string
  export function dirname(p: string): string
  export function basename(p: string): string
  export function isAbsolute(p: string): boolean
  export const sep: string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
