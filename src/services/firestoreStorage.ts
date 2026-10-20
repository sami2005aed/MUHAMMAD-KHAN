import fs from 'fs';
import path from 'path';
import { initializeApp as initAdminApp, getApps as getAdminApps, getApp as getAdminApp } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, Firestore as AdminFirestore } from 'firebase-admin/firestore';
import {
  User,
  Client,
  Job,
  Transaction,
  Invoice,
  Agreement,
  AgreementTemplate,
  AuditLog,
  ClientDocument,
  Employee,
  CompanySettings,
} from '../types.ts';

export interface DatabaseSchema {
  users: User[];
  clients: Client[];
  jobs: Job[];
  transactions: Transaction[];
  invoices: Invoice[];
  agreements: Agreement[];
  templates: AgreementTemplate[];
  auditLogs: AuditLog[];
  settings: CompanySettings;
  documents: ClientDocument[];
  employees: Employee[];
}

export interface StorageStatus {
  activeStorage: 'Cloud Firestore';
  driver: 'Firebase Admin SDK';
  projectId: string;
  databaseId: string;
  filesStorage: string;
  isPersistent: boolean;
  statusText: string;
}

export interface StorageHealthTest {
  ok: boolean;
  driver: 'Firebase Admin SDK';
  projectId: string;
  databaseId: string;
  latencyMs: number;
  testedAt: string;
  message?: string;
  error?: string;
}

let adminFirestoreInstance: AdminFirestore | null = null;
let appConfig: any = null;

export function resetAdminFirestoreInstance(): void {
  adminFirestoreInstance = null;
}

export function getFirestoreConfigDetails(): { projectId: string; databaseId: string } {
  const config = loadConfig();
  return {
    projectId: config.projectId,
    databaseId: config.firestoreDatabaseId || '(default)',
  };
}

const CHUNK_SIZE = 450 * 1024; // 450 KB per chunk (comfortably under the 1MB document limit)
const fileMemoryCache = new Map<string, { buffer: Buffer; mimetype: string }>();

function loadConfig(): any {
  if (appConfig) return appConfig;
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('firebase-applet-config.json not found. Firestore cannot be initialized.');
  }
  appConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return appConfig;
}

/**
 * Returns the singleton Firebase Admin Firestore instance.
 * Exclusively uses Firebase Admin SDK without any client SDK fallbacks.
 */
export function getAdminFirestoreDb(): AdminFirestore {
  if (adminFirestoreInstance) return adminFirestoreInstance;
  const config = loadConfig();
  const adminApp = getAdminApps().length ? getAdminApp() : initAdminApp({ projectId: config.projectId });
  adminFirestoreInstance = getAdminFirestore(adminApp, config.firestoreDatabaseId || undefined);
  return adminFirestoreInstance;
}

/**
 * Returns active storage system status for logging and health checks.
 */
export function getStorageStatus(): StorageStatus {
  const config = loadConfig();
  return {
    activeStorage: 'Cloud Firestore',
    driver: 'Firebase Admin SDK',
    projectId: config.projectId,
    databaseId: config.firestoreDatabaseId || '(default)',
    filesStorage: 'Cloud Firestore Chunks (Persistent Multi-Region Storage)',
    isPersistent: true,
    statusText: 'ONLINE & PERSISTENT (Firebase Admin SDK - Cloud Firestore collections & chunks)',
  };
}

/**
 * Performs a live end-to-end storage test by writing and reading back a small document in the 'system' collection.
 */
export async function testFirestoreConnection(): Promise<StorageHealthTest> {
  const config = loadConfig();
  const start = Date.now();
  const testPayload = {
    test: 'health-check',
    timestamp: new Date().toISOString(),
    driver: 'Firebase Admin SDK',
    nonce: Math.random().toString(36).substring(2, 12),
  };

  try {
    const db = getAdminFirestoreDb();
    const testDoc = db.collection('system').doc('health_check');
    await testDoc.set(testPayload);
    const snap = await testDoc.get();
    if (!snap.exists) {
      throw new Error('Health check document was written but not returned on read back.');
    }
    const data = snap.data();
    if (data?.nonce !== testPayload.nonce) {
      throw new Error('Health check read verification failed: payload mismatch.');
    }
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      driver: 'Firebase Admin SDK',
      projectId: config.projectId,
      databaseId: config.firestoreDatabaseId || '(default)',
      latencyMs,
      testedAt: new Date().toISOString(),
      message: `Live write and read-back test passed in ${latencyMs}ms.`,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      driver: 'Firebase Admin SDK',
      projectId: config.projectId,
      databaseId: config.firestoreDatabaseId || '(default)',
      latencyMs,
      testedAt: new Date().toISOString(),
      error: err?.message || String(err),
    };
  }
}

function sanitizeForFirestore(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForFirestore(item));
  }
  if (typeof obj === 'object' && !(obj instanceof Date)) {
    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        clean[key] = sanitizeForFirestore(value);
      }
    }
    return clean;
  }
  return obj;
}

/**
 * Sets a document in Firestore via Firebase Admin SDK, awaiting completion. Throws on error.
 */
export async function firestoreSetDoc(collectionName: string, docId: string, data: any): Promise<void> {
  const db = getAdminFirestoreDb();
  const sanitized = sanitizeForFirestore(data);
  try {
    await db.collection(collectionName).doc(docId).set(sanitized);
  } catch (err: any) {
    console.error(`[FIRESTORE WRITE ERROR] Failed to write to ${collectionName}/${docId}:`, err);
    throw new Error(`Database write failed (${collectionName}): ${err?.message || 'Firestore error'}`);
  }
}

/**
 * Deletes a document from Firestore via Firebase Admin SDK, awaiting completion. Throws on error.
 */
export async function firestoreDeleteDoc(collectionName: string, docId: string): Promise<void> {
  const db = getAdminFirestoreDb();
  try {
    await db.collection(collectionName).doc(docId).delete();
  } catch (err: any) {
    console.error(`[FIRESTORE DELETE ERROR] Failed to delete from ${collectionName}/${docId}:`, err);
    throw new Error(`Database delete failed (${collectionName}): ${err?.message || 'Firestore error'}`);
  }
}

/**
 * Saves company settings document
 */
export async function firestoreSaveSettings(settings: CompanySettings): Promise<void> {
  await firestoreSetDoc('settings', 'company', settings);
}

/**
 * Loads entire database from Firestore collections on startup using Firebase Admin SDK.
 * Seeds default data ONLY if Firestore is successfully read and confirmed completely empty.
 * If Admin SDK lacks permissions, logs clear FATAL error and throws so server refuses to start.
 */
export async function loadDatabaseFromFirestore(
  getInitialData: () => DatabaseSchema
): Promise<DatabaseSchema> {
  const config = loadConfig();
  console.log(`[STORAGE INIT] Connecting to Cloud Firestore via Firebase Admin SDK (${config.firestoreDatabaseId || 'default'})...`);

  const db = getAdminFirestoreDb();

  let userDocs: User[] = [];
  let isUsersEmpty = false;

  try {
    const snap = await db.collection('users').get();
    isUsersEmpty = snap.empty;
    userDocs = snap.docs.map(d => d.data() as User);
  } catch (readErr: any) {
    const fatalMsg =
      "Admin SDK has no permission on the Firestore project. Grant the Cloud Run service account the 'Cloud Datastore User' role";
    console.error(`[FATAL ERROR] ${fatalMsg}`);
    console.error(`[FATAL ERROR DETAILS]`, readErr);
    throw new Error(fatalMsg);
  }

  // Seed default dataset ONLY if users collection was successfully read and is truly empty
  if (isUsersEmpty || userDocs.length === 0) {
    console.log('[STORAGE INIT] Firestore is confirmed completely empty. Seeding initial default dataset to Firestore...');
    const initial = getInitialData();
    try {
      await seedDatabaseToFirestore(initial);
    } catch (seedErr: any) {
      const fatalMsg =
        "Admin SDK has no permission on the Firestore project. Grant the Cloud Run service account the 'Cloud Datastore User' role";
      console.error(`[FATAL ERROR] ${fatalMsg}`);
      console.error(`[FATAL ERROR DETAILS]`, seedErr);
      throw new Error(fatalMsg);
    }
    console.log('[STORAGE INIT] Initial seed complete. All entities persisted to Cloud Firestore.');
    return initial;
  }

  console.log(`[STORAGE INIT] Found ${userDocs.length} existing users in Firestore. Loading all collections...`);

  let clients: Client[] = [];
  let jobs: Job[] = [];
  let transactions: Transaction[] = [];
  let invoices: Invoice[] = [];
  let agreements: Agreement[] = [];
  let templates: AgreementTemplate[] = [];
  let auditLogs: AuditLog[] = [];
  let documents: ClientDocument[] = [];
  let employees: Employee[] = [];
  let settings: CompanySettings;

  try {
    const [
      cSnap,
      jSnap,
      tSnap,
      iSnap,
      aSnap,
      tmplSnap,
      audSnap,
      dSnap,
      eSnap,
      sSnap,
    ] = await Promise.all([
      db.collection('clients').get(),
      db.collection('jobs').get(),
      db.collection('transactions').get(),
      db.collection('invoices').get(),
      db.collection('agreements').get(),
      db.collection('templates').get(),
      db.collection('auditLogs').get(),
      db.collection('documents').get(),
      db.collection('employees').get(),
      db.collection('settings').doc('company').get(),
    ]);

    clients = cSnap.docs.map(d => d.data() as Client);
    jobs = jSnap.docs.map(d => d.data() as Job);
    transactions = tSnap.docs.map(d => d.data() as Transaction);
    invoices = iSnap.docs.map(d => d.data() as Invoice);
    agreements = aSnap.docs.map(d => d.data() as Agreement);
    templates = tmplSnap.docs.map(d => d.data() as AgreementTemplate);
    auditLogs = audSnap.docs.map(d => d.data() as AuditLog);
    documents = dSnap.docs.map(d => d.data() as ClientDocument);
    employees = eSnap.docs.map(d => d.data() as Employee);

    if (sSnap.exists) {
      settings = sSnap.data() as CompanySettings;
    } else {
      const initial = getInitialData();
      settings = initial.settings;
      await db.collection('settings').doc('company').set(sanitizeForFirestore(settings));
    }
  } catch (err: any) {
    const fatalMsg =
      "Admin SDK has no permission on the Firestore project. Grant the Cloud Run service account the 'Cloud Datastore User' role";
    console.error(`[FATAL ERROR] ${fatalMsg}`);
    console.error(`[FATAL ERROR DETAILS]`, err);
    throw new Error(fatalMsg);
  }

  // Sort descending by timestamp / creation
  jobs.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  transactions.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
  auditLogs.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  documents.sort((a, b) => new Date(b.uploadedAt || 0).getTime() - new Date(a.uploadedAt || 0).getTime());

  console.log(
    `[STORAGE INIT] Loaded from Cloud Firestore via Firebase Admin SDK: ` +
    `${userDocs.length} users, ${clients.length} clients, ${jobs.length} jobs, ` +
    `${transactions.length} transactions, ${invoices.length} invoices, ` +
    `${agreements.length} agreements, ${employees.length} employees, ${documents.length} documents.`
  );

  return {
    users: userDocs,
    clients,
    jobs,
    transactions,
    invoices,
    agreements,
    templates,
    auditLogs,
    settings: settings!,
    documents,
    employees,
  };
}

/**
 * Seeds initial database data to Firestore using Firebase Admin SDK
 */
async function seedDatabaseToFirestore(data: DatabaseSchema): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const u of data.users) {
    promises.push(firestoreSetDoc('users', u.id, u));
  }
  for (const c of data.clients) {
    promises.push(firestoreSetDoc('clients', c.id, c));
  }
  for (const j of data.jobs) {
    promises.push(firestoreSetDoc('jobs', j.id, j));
  }
  for (const t of data.transactions) {
    promises.push(firestoreSetDoc('transactions', t.id, t));
  }
  for (const i of data.invoices) {
    promises.push(firestoreSetDoc('invoices', i.id, i));
  }
  for (const a of data.agreements) {
    promises.push(firestoreSetDoc('agreements', a.id, a));
  }
  for (const tmpl of data.templates) {
    promises.push(firestoreSetDoc('templates', tmpl.id, tmpl));
  }
  for (const l of data.auditLogs) {
    promises.push(firestoreSetDoc('auditLogs', l.id, l));
  }
  for (const d of data.documents) {
    promises.push(firestoreSetDoc('documents', d.id, d));
  }
  for (const e of data.employees) {
    promises.push(firestoreSetDoc('employees', e.id, e));
  }
  promises.push(firestoreSetDoc('settings', 'company', data.settings));

  await Promise.all(promises);
}

/**
 * Saves an uploaded file persistently to Firestore using partitioned chunks.
 * Zero local filesystem disk writes. Keeps in memory cache.
 */
export async function firestoreSaveFile(
  filename: string,
  mimetype: string,
  size: number,
  buffer: Buffer
): Promise<string> {
  // Store in memory cache
  fileMemoryCache.set(filename, { buffer, mimetype });

  // Partition into chunks
  const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

  // Write file metadata document
  await firestoreSetDoc('files', filename, {
    filename,
    mimetype,
    size,
    totalChunks,
    uploadedAt: new Date().toISOString(),
  });

  // Write each chunk
  const chunkPromises: Promise<void>[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, buffer.length);
    const chunkBuffer = buffer.subarray(start, end);
    const chunkDocId = `${filename}_chunk_${i}`;

    chunkPromises.push(
      firestoreSetDoc('file_chunks', chunkDocId, {
        filename,
        chunkIndex: i,
        data: chunkBuffer.toString('base64'),
      })
    );
  }

  await Promise.all(chunkPromises);
  console.log(`[STORAGE] Uploaded '${filename}' (${size} bytes, ${totalChunks} chunks) to persistent Cloud Firestore via Firebase Admin SDK.`);

  return `/uploads/${filename}`;
}

/**
 * Retrieves a file from in-memory cache or reconstructs it from Firestore chunks.
 * Zero local filesystem disk writes.
 */
export async function firestoreGetFile(filename: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
  if (fileMemoryCache.has(filename)) {
    return fileMemoryCache.get(filename)!;
  }

  const db = getAdminFirestoreDb();
  const metaSnap = await db.collection('files').doc(filename).get();
  if (!metaSnap.exists) {
    return null;
  }
  const meta = metaSnap.data();
  if (!meta) return null;

  const totalChunks = meta.totalChunks || 1;
  const chunkPromises: Promise<any>[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunkDocId = `${filename}_chunk_${i}`;
    chunkPromises.push(db.collection('file_chunks').doc(chunkDocId).get());
  }

  const chunkSnaps = await Promise.all(chunkPromises);
  const buffers: Buffer[] = [];

  for (let i = 0; i < totalChunks; i++) {
    const snap = chunkSnaps[i];
    if (!snap.exists) {
      throw new Error(`Missing file chunk ${i} for file ${filename}`);
    }
    const chunkData = snap.data();
    buffers.push(Buffer.from(chunkData.data, 'base64'));
  }

  const fullBuffer = Buffer.concat(buffers);
  const result = {
    buffer: fullBuffer,
    mimetype: meta.mimetype || 'application/octet-stream',
  };

  fileMemoryCache.set(filename, result);
  return result;
}

/**
 * Restores a full JSON database backup into Firestore collections
 */
export async function restoreBackupToFirestore(backupData: DatabaseSchema): Promise<void> {
  console.log('[RESTORE] Starting database restoration into Cloud Firestore via Firebase Admin SDK...');

  const writePromises: Promise<void>[] = [];

  if (Array.isArray(backupData.users)) {
    for (const u of backupData.users) {
      writePromises.push(firestoreSetDoc('users', u.id, u));
    }
  }
  if (Array.isArray(backupData.clients)) {
    for (const c of backupData.clients) {
      writePromises.push(firestoreSetDoc('clients', c.id, c));
    }
  }
  if (Array.isArray(backupData.jobs)) {
    for (const j of backupData.jobs) {
      writePromises.push(firestoreSetDoc('jobs', j.id, j));
    }
  }
  if (Array.isArray(backupData.transactions)) {
    for (const t of backupData.transactions) {
      writePromises.push(firestoreSetDoc('transactions', t.id, t));
    }
  }
  if (Array.isArray(backupData.invoices)) {
    for (const i of backupData.invoices) {
      writePromises.push(firestoreSetDoc('invoices', i.id, i));
    }
  }
  if (Array.isArray(backupData.agreements)) {
    for (const a of backupData.agreements) {
      writePromises.push(firestoreSetDoc('agreements', a.id, a));
    }
  }
  if (Array.isArray(backupData.templates)) {
    for (const tmpl of backupData.templates) {
      writePromises.push(firestoreSetDoc('templates', tmpl.id, tmpl));
    }
  }
  if (Array.isArray(backupData.auditLogs)) {
    for (const l of backupData.auditLogs) {
      writePromises.push(firestoreSetDoc('auditLogs', l.id, l));
    }
  }
  if (Array.isArray(backupData.documents)) {
    for (const d of backupData.documents) {
      writePromises.push(firestoreSetDoc('documents', d.id, d));
    }
  }
  if (Array.isArray(backupData.employees)) {
    for (const e of backupData.employees) {
      writePromises.push(firestoreSetDoc('employees', e.id, e));
    }
  }
  if (backupData.settings) {
    writePromises.push(firestoreSetDoc('settings', 'company', backupData.settings));
  }

  await Promise.all(writePromises);
  console.log('[RESTORE] Database successfully restored and persisted to Cloud Firestore via Firebase Admin SDK!');
}

