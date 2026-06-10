import {
  constants as fsConstants,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  type ContentEncoding,
  type DirectoryEntry,
  type ResourceCopyParams,
  type ResourceCopyResult,
  type ResourceDeleteParams,
  type ResourceDeleteResult,
  type ResourceListParams,
  type ResourceListResult,
  type ResourceMkdirParams,
  type ResourceMkdirResult,
  type ResourceMoveParams,
  type ResourceMoveResult,
  type ResourceReadParams,
  type ResourceReadResult,
  type ResourceResolveParams,
  type ResourceResolveResult,
  type ResourceType,
  type ResourceWriteParams,
  type ResourceWriteResult,
  type ResourceWriteMode,
  type URI,
} from '@microsoft/agent-host-protocol';

import { AhpServerError, JsonRpcErrorCodes } from './errors.js';

export interface FileResourceServiceOptions {
  readonly roots?: readonly URI[];
}

type ResourceContentEncoding = 'base64' | 'utf-8';

export class FileResourceService {
  private readonly roots: string[];

  constructor(options: FileResourceServiceOptions = {}) {
    const configuredRoots = options.roots?.length ? options.roots : [`file://${process.cwd()}` as URI];
    this.roots = configuredRoots.map(root => normalizePath(uriToPath(root)));
  }

  async read(params: ResourceReadParams): Promise<ResourceReadResult> {
    const path = await this.resolveExisting(params.uri);
    const data = await readFile(path);
    const encoding = (params.encoding ?? 'utf-8') as ResourceContentEncoding;
    return {
      data: encoding === 'base64' ? data.toString('base64') : data.toString('utf8'),
      encoding: encoding as ContentEncoding,
      contentType: contentType(path, encoding),
    };
  }

  async write(params: ResourceWriteParams): Promise<ResourceWriteResult> {
    const path = await this.resolveWritable(params.uri);
    const payload = decodeData(params.data, params.encoding);
    const exists = await pathExists(path);
    if (params.createOnly && exists) {
      throw new AhpServerError(JsonRpcErrorCodes.AlreadyExists, `resource already exists: ${params.uri}`);
    }
    if (params.ifMatch) {
      if (!exists) {
        throw new AhpServerError(JsonRpcErrorCodes.Conflict, `resource etag does not match: ${params.uri}`);
      }
      const current = await stat(path);
      if (etag(current) !== params.ifMatch) {
        throw new AhpServerError(JsonRpcErrorCodes.Conflict, `resource etag does not match: ${params.uri}`);
      }
    }

    let output: Buffer;
    const mode = params.mode ?? 'truncate';
    const position = params.position ?? 0;
    if (mode === 'truncate') {
      const existing = exists ? await readFile(path) : Buffer.alloc(0);
      output = Buffer.concat([existing.subarray(0, clamp(position, 0, existing.length)), payload]);
    } else {
      const existing = exists ? await readFile(path) : Buffer.alloc(0);
      const insertAt = mode === 'append'
        ? clamp(existing.length - position, 0, existing.length)
        : clamp(position, 0, existing.length);
      output = Buffer.concat([existing.subarray(0, insertAt), payload, existing.subarray(insertAt)]);
    }

    await writeFile(path, output, { mode: 0o600 });
    return {};
  }

  async list(params: ResourceListParams): Promise<ResourceListResult> {
    const path = await this.resolveExisting(params.uri);
    const entries = await readdir(path, { withFileTypes: true }).catch(error => {
      throw mapFsError(error, `resource is not a directory: ${params.uri}`);
    });
    const result: DirectoryEntry[] = entries
      .filter(entry => entry.isFile() || entry.isDirectory())
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' as const : 'file' as const,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { entries: result };
  }

  async copy(params: ResourceCopyParams): Promise<ResourceCopyResult> {
    const source = await this.resolveExisting(params.source);
    const destination = await this.resolveWritable(params.destination);
    if (params.failIfExists && await pathExists(destination)) {
      throw new AhpServerError(JsonRpcErrorCodes.AlreadyExists, `resource already exists: ${params.destination}`);
    }
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      await cp(source, destination, { recursive: true, force: !params.failIfExists, errorOnExist: params.failIfExists });
    } else {
      await copyFile(source, destination, params.failIfExists ? fsConstants.COPYFILE_EXCL : 0);
    }
    return {};
  }

  async delete(params: ResourceDeleteParams): Promise<ResourceDeleteResult> {
    const path = await this.resolveExisting(params.uri);
    await rm(path, { recursive: params.recursive ?? false });
    return {};
  }

  async move(params: ResourceMoveParams): Promise<ResourceMoveResult> {
    const source = await this.resolveExisting(params.source);
    const destination = await this.resolveWritable(params.destination);
    if (params.failIfExists && await pathExists(destination)) {
      throw new AhpServerError(JsonRpcErrorCodes.AlreadyExists, `resource already exists: ${params.destination}`);
    }
    if (!params.failIfExists && await pathExists(destination)) {
      await rm(destination, { recursive: true, force: true });
    }
    await rename(source, destination);
    return {};
  }

  async resolve(params: ResourceResolveParams): Promise<ResourceResolveResult> {
    const path = params.followSymlinks === false
      ? this.resolveAllowedPath(params.uri)
      : await this.resolveExisting(params.uri);
    const stats = params.followSymlinks === false ? await lstat(path) : await stat(path);
    if (params.followSymlinks === false && stats.isSymbolicLink()) {
      this.assertAllowedPath(path);
    }
    return {
      uri: pathToFileURL(path).href as URI,
      type: resourceType(stats),
      ...(stats.isDirectory() ? {} : { size: stats.size }),
      mtime: stats.mtime.toISOString(),
      ctime: stats.ctime.toISOString(),
      ...(stats.isFile() ? { contentType: contentType(path, 'base64') } : {}),
      etag: etag(stats),
    };
  }

  async mkdir(params: ResourceMkdirParams): Promise<ResourceMkdirResult> {
    const path = this.resolveAllowedPath(params.uri);
    await this.assertNearestExistingParentAllowed(path);
    if (await pathExists(path)) {
      const stats = await stat(path);
      if (!stats.isDirectory()) {
        throw new AhpServerError(JsonRpcErrorCodes.AlreadyExists, `resource already exists and is not a directory: ${params.uri}`);
      }
      return {};
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    return {};
  }

  private async resolveExisting(uri: URI | string): Promise<string> {
    const requested = this.resolveAllowedPath(uri);
    try {
      const canonical = await realpath(requested);
      this.assertAllowedPath(canonical);
      return canonical;
    } catch (error) {
      throw mapFsError(error, `resource not found: ${uri}`);
    }
  }

  private async resolveWritable(uri: URI): Promise<string> {
    const requested = this.resolveAllowedPath(uri);
    const parent = dirname(requested);
    try {
      const canonicalParent = await realpath(parent);
      this.assertAllowedPath(canonicalParent);
      if (await pathExists(requested)) {
        const canonicalTarget = await realpath(requested);
        this.assertAllowedPath(canonicalTarget);
      }
      return requested;
    } catch (error) {
      throw mapFsError(error, `resource parent not found: ${uri}`);
    }
  }

  private async assertNearestExistingParentAllowed(path: string): Promise<void> {
    let current = dirname(path);
    while (true) {
      if (await pathExists(current)) {
        const canonical = await realpath(current);
        this.assertAllowedPath(canonical);
        return;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new AhpServerError(JsonRpcErrorCodes.NotFound, `resource parent not found: ${path}`);
      }
      current = parent;
    }
  }

  private resolveAllowedPath(uri: URI | string): string {
    const path = normalizePath(uriToPath(uri));
    this.assertAllowedPath(path);
    return path;
  }

  private assertAllowedPath(path: string): void {
    const normalized = normalizePath(path);
    if (this.roots.some(root => normalized === root || relative(root, normalized).startsWith('..') === false && !isAbsolute(relative(root, normalized)))) {
      return;
    }
    throw new AhpServerError(JsonRpcErrorCodes.PermissionDenied, `resource is outside allowed roots: ${path}`);
  }
}

function uriToPath(uri: URI | string): string {
  if (!uri.startsWith('file://')) {
    throw new AhpServerError(JsonRpcErrorCodes.PermissionDenied, `unsupported resource URI scheme: ${uri}`);
  }
  return fileURLToPath(uri);
}

function normalizePath(path: string): string {
  return normalize(resolve(path));
}

function decodeData(data: string, encoding: ContentEncoding): Buffer {
  if (encoding === 'base64') {
    return Buffer.from(data, 'base64');
  }
  if (encoding === 'utf-8') {
    return Buffer.from(data, 'utf8');
  }
  throw new AhpServerError(JsonRpcErrorCodes.InvalidParams, `unsupported resource encoding: ${encoding}`);
}

function contentType(path: string, encoding: ResourceContentEncoding): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') {
    return 'application/json';
  }
  if (ext === '.md') {
    return 'text/markdown';
  }
  if (ext === '.txt' || encoding === 'utf-8') {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function resourceType(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): ResourceType {
  if (stats.isFile()) {
    return 'file' as ResourceType;
  }
  if (stats.isDirectory()) {
    return 'directory' as ResourceType;
  }
  if (stats.isSymbolicLink()) {
    return 'symlink' as ResourceType;
  }
  return 'file' as ResourceType;
}

function etag(stats: { size: number; mtimeMs: number }): string {
  return `W/"${stats.size}-${Math.trunc(stats.mtimeMs)}"`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function mapFsError(error: unknown, fallback: string): Error {
  if (!isNodeError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
    return new AhpServerError(JsonRpcErrorCodes.NotFound, fallback);
  }
  if (error.code === 'EEXIST') {
    return new AhpServerError(JsonRpcErrorCodes.AlreadyExists, fallback);
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    return new AhpServerError(JsonRpcErrorCodes.PermissionDenied, fallback);
  }
  return new AhpServerError(JsonRpcErrorCodes.InternalError, error.message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
