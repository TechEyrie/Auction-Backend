import path from 'node:path';
import ImageKit from 'imagekit';
import { AppError } from '../../shared/errors.ts';
import { assertSafeKey, imageKitStorageKey, parseImageKitStorageKey } from './storage-keys.ts';
import type { MediaPutResult, MediaStorage } from './storage.ts';

export type ImageKitStorageClient = {
  upload: (options: {
    file: Buffer;
    fileName: string;
    folder?: string;
    useUniqueFileName?: boolean;
  }) => Promise<{ fileId: string; url: string; filePath: string }>;
  getFileDetails: (fileId: string) => Promise<{ url: string }>;
  deleteFile: (fileId: string) => Promise<void>;
};

function fileNameFromLogicalKey(logicalKey: string): string {
  const base = path.posix.basename(logicalKey.replace(/\\/g, '/'));
  return base || logicalKey.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200);
}

function normalizeFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) return '/araq-kahraman/listings';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function createImageKitClient(options: {
  urlEndpoint: string;
  publicKey: string;
  privateKey: string;
}): ImageKitStorageClient {
  const ik = new ImageKit({
    urlEndpoint: options.urlEndpoint,
    publicKey: options.publicKey,
    privateKey: options.privateKey,
  });
  return {
    upload: async (uploadOptions) => {
      const response = await ik.upload({
        file: uploadOptions.file,
        fileName: uploadOptions.fileName,
        folder: uploadOptions.folder,
        useUniqueFileName: uploadOptions.useUniqueFileName ?? false,
      });
      return { fileId: response.fileId, url: response.url, filePath: response.filePath };
    },
    getFileDetails: async (fileId) => {
      const response = await ik.getFileDetails(fileId);
      return { url: response.url };
    },
    deleteFile: async (fileId) => {
      await ik.deleteFile(fileId);
    },
  };
}

export function createImageKitStorage(options: {
  urlEndpoint: string;
  publicKey: string;
  privateKey: string;
  folder: string;
  client?: ImageKitStorageClient;
}): MediaStorage {
  const folder = normalizeFolder(options.folder);
  const client = options.client ?? createImageKitClient(options);

  const resolveFileId = (key: string): string => {
    assertSafeKey(key);
    const fileId = parseImageKitStorageKey(key);
    if (!fileId) {
      throw new AppError('INTERNAL', 'ImageKit storage key is missing a file id', { details: { key } });
    }
    return fileId;
  };

  return {
    driver: 'imagekit',
    async put(logicalKey, bytes) {
      assertSafeKey(logicalKey);
      const fileName = fileNameFromLogicalKey(logicalKey);
      const uploaded = await client.upload({
        file: bytes,
        fileName,
        folder,
        useUniqueFileName: false,
      });
      const result: MediaPutResult = {
        key: imageKitStorageKey(uploaded.fileId),
        publicUrl: uploaded.url,
      };
      return result;
    },
    async get(key) {
      const fileId = resolveFileId(key);
      const details = await client.getFileDetails(fileId);
      const response = await fetch(details.url);
      if (!response.ok) {
        throw new AppError('NOT_FOUND', 'Media object not found');
      }
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(key) {
      const fileId = resolveFileId(key);
      await client.deleteFile(fileId);
    },
    async exists(key) {
      try {
        const fileId = resolveFileId(key);
        await client.getFileDetails(fileId);
        return true;
      } catch {
        return false;
      }
    },
  };
}
