import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const DRIVE_PREFIX = "__shelf_drive_v1__";
export const DRIVE_CHUNK = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const magic = encoder.encode("SHELFD01");
export interface DriveMetadata { id: string; name: string; size: number; addedAt: string; sourceDevice: string; sha256: string; }
export interface Sealed { nonce: string; ciphertext: string; }
export interface PasswordDriveVault { version: 1; scope: string; salt: string; iterations: 600000; wrappedKey: Sealed; }
export interface AccountDriveVault { version: 2; scope: string; keyMode:'account'; }
export type DriveVault=PasswordDriveVault|AccountDriveVault;
export interface DriveWire { version: 1; id: string; metadata: Sealed; size: number; sha256: string; remoteIds?:string[]; downloadReceipt?:string; commitReceipt?:string; }

export function base64(bytes: Uint8Array): string {
  let value = "";
  for (let start = 0; start < bytes.length; start += 8192) value += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(value);
}
export function unbase64(value: string): Uint8Array {
  // Avoid a repeated-group regex: multi-megabyte transfer parts overflow V8's regex stack.
  if (value.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("DRIVE_INVALID");
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function buffer(bytes: Uint8Array): ArrayBuffer { return bytes.slice().buffer; }
async function aes(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error("DRIVE_INVALID_KEY");
  return crypto.subtle.importKey("raw", buffer(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(bytes: Uint8Array, key: Uint8Array, aad: string): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  return { nonce: base64(nonce), ciphertext: base64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) }, await aes(key), buffer(bytes)))) };
}
async function open(value: Sealed, key: Uint8Array, aad: string): Promise<Uint8Array> {
  const nonce = unbase64(value.nonce), ciphertext = unbase64(value.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16) throw new Error("DRIVE_INVALID");
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) }, await aes(key), buffer(ciphertext))); }
  catch { throw new Error("DRIVE_WRONG_PASSWORD_OR_DAMAGED"); }
}
async function passwordKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (password.length < 8 || encoder.encode(password).length > 1024) throw new Error("DRIVE_PASSWORD_MIN_8");
  const input = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", buffer(input), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: buffer(salt), iterations: 600000, hash: "SHA-256" }, material, 256));
  } finally { input.fill(0); }
}
export async function createDriveVault(password: string, scope: string): Promise<{ vault: PasswordDriveVault; key: Uint8Array }> {
  if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error("DRIVE_INVALID");
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = crypto.getRandomValues(new Uint8Array(32));
  const wrapping = await passwordKey(password, salt);
  try { return { vault: { version: 1, scope, salt: base64(salt), iterations: 600000, wrappedKey: await seal(key, wrapping, `shelf-drive-vault-v1:${scope}`) }, key }; }
  catch (error) { key.fill(0); throw error; }
  finally { wrapping.fill(0); }
}
export async function unlockDriveVault(vault: DriveVault, password: string, scope: string): Promise<Uint8Array> {
  if (vault.version !== 1 || vault.scope !== scope || vault.iterations !== 600000 || unbase64(vault.salt).length !== 16) throw new Error("DRIVE_INVALID_VAULT");
  const wrapping = await passwordKey(password, unbase64(vault.salt));
  try { const key = await open(vault.wrappedKey, wrapping, `shelf-drive-vault-v1:${scope}`); if (key.length !== 32) { key.fill(0); throw new Error("DRIVE_INVALID_KEY"); } return key; }
  finally { wrapping.fill(0); }
}
export async function openDriveMetadata(wire: DriveWire, key: Uint8Array, scope: string): Promise<DriveMetadata> {
  const plain = await open(wire.metadata, key, `shelf-drive-meta-v1:${scope}:${wire.id}`);
  try {
    const meta = JSON.parse(decoder.decode(plain)) as DriveMetadata;
    if (meta.id !== wire.id || typeof meta.name !== "string" || !meta.name || meta.name.length > 512 || /[\r\n\0]/.test(meta.name) || !Number.isSafeInteger(meta.size) || meta.size < 0 || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isFinite(Date.parse(meta.addedAt)) || typeof meta.sourceDevice !== "string" || meta.sourceDevice.length > 80) throw new Error("DRIVE_INVALID_METADATA");
    const expected = 24 + meta.size + Math.max(1, Math.ceil(meta.size / DRIVE_CHUNK)) * 16;
    if (wire.size !== expected || wire.version !== 1 || !/^[a-f0-9]{64}$/.test(wire.sha256)) throw new Error("DRIVE_INVALID_METADATA");
    return meta;
  } finally { plain.fill(0); }
}
function nonce(prefix: Uint8Array, index: number): Uint8Array { const value = new Uint8Array(12); value.set(prefix); new DataView(value.buffer).setUint32(8, index); return value; }
function dataAad(scope: string, id: string, index: number, size: number): ArrayBuffer { return buffer(encoder.encode(`shelf-drive-data-v1:${scope}:${id}:${index}/${size}`)); }
export async function encryptDriveFile(file: Blob, meta: Omit<DriveMetadata, "size" | "sha256">, key: Uint8Array, scope: string): Promise<{ body: Blob; wire: DriveWire; metadata: DriveMetadata }> {
  if (file.size > DRIVE_CHUNK * 0xffffffff) throw new Error("DRIVE_TOO_LARGE");
  const header = new Uint8Array(24); header.set(magic); const prefix = crypto.getRandomValues(new Uint8Array(8)); header.set(prefix, 8); new DataView(header.buffer).setBigUint64(16, BigInt(file.size));
  const parts: BlobPart[] = [buffer(header)], plainHash = sha256.create(), cipherHash = sha256.create(); cipherHash.update(header);
  const cipher = await aes(key), chunks = Math.max(1, Math.ceil(file.size / DRIVE_CHUNK));
  for (let index = 0; index < chunks; index++) {
    const bytes = new Uint8Array(await file.slice(index * DRIVE_CHUNK, (index + 1) * DRIVE_CHUNK).arrayBuffer()); plainHash.update(bytes);
    try { const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(nonce(prefix, index)), additionalData: dataAad(scope, meta.id, index, file.size) }, cipher, buffer(bytes))); cipherHash.update(encrypted); parts.push(buffer(encrypted)); }
    finally { bytes.fill(0); }
  }
  const metadata = { ...meta, size: file.size, sha256: bytesToHex(plainHash.digest()) }, body = new Blob(parts);
  return { body, metadata, wire: { version: 1, id: meta.id, metadata: await seal(encoder.encode(JSON.stringify(metadata)), key, `shelf-drive-meta-v1:${scope}:${meta.id}`), size: body.size, sha256: bytesToHex(cipherHash.digest()) } };
}
export async function decryptDriveFile(body: Blob, wire: DriveWire, key: Uint8Array, scope: string): Promise<Blob> {
  const meta = await openDriveMetadata(wire, key, scope);
  if (body.size !== wire.size) throw new Error("DRIVE_INVALID_DATA");
  const header = new Uint8Array(await body.slice(0, 24).arrayBuffer());
  if (!magic.every((b, i) => header[i] === b) || Number(new DataView(header.buffer).getBigUint64(16)) !== meta.size) throw new Error("DRIVE_INVALID_DATA");
  const plainHash = sha256.create(), cipherHash = sha256.create(); cipherHash.update(header);
  const cipher = await aes(key), parts: BlobPart[] = [], chunks = Math.max(1, Math.ceil(meta.size / DRIVE_CHUNK));
  let offset = 24;
  for (let index = 0; index < chunks; index++) {
    const size = Math.min(DRIVE_CHUNK, Math.max(0, meta.size - index * DRIVE_CHUNK)) + 16;
    const bytes = new Uint8Array(await body.slice(offset, offset + size).arrayBuffer()); offset += size; cipherHash.update(bytes);
    let plain: Uint8Array;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(nonce(header.subarray(8, 16), index)), additionalData: dataAad(scope, meta.id, index, meta.size) }, cipher, buffer(bytes))); }
    catch { throw new Error("DRIVE_DAMAGED_DATA"); }
    plainHash.update(plain); parts.push(buffer(plain)); plain.fill(0);
  }
  if (bytesToHex(cipherHash.digest()) !== wire.sha256 || bytesToHex(plainHash.digest()) !== meta.sha256) throw new Error("DRIVE_DAMAGED_DATA");
  return new Blob(parts);
}
