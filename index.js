/**
 * Session Recycle Bin — host half.
 *
 * Right-click "delete" on a workspace session marks it pending-delete and
 * moves it into a recycle bin; the session's files (log directory + per-session
 * projection cache) are only removed after 7 days, or immediately on explicit
 * "delete now" from the bin (with a confirmation prompt on the client).
 * Restore returns the session to normal visibility.
 *
 * Everything persists through the host's own storageDomain ('session_recycle'),
 * which lands at ~/.dsh/storages/session_recycle.json.
 */
import { rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PLUGIN_ID = 'session-recycle';
const DOMAIN_NAME = 'session_recycle';
const DEFAULT_RETENTION_DAYS = 7;
const PURGE_SWEEP_MS = 60 * 60 * 1000; // hourly sweep for expired entries
const PROJCACHE_DIR = 'session_projcache';

// A permissive value schema for the domain table: `storageDomain.open()` calls
// `valueSchema.parse(raw)` on EVERY stored record at startup. A bare `null`
// (previously used here) throws on the first real record, so the table becomes
// undefined and every endpoint fails with "reading 'entries'". Records are
// plain JSON we control, so validation is a no-op.
const ANY_SCHEMA = { parse: (value) => value };

/** Append a milestone to an on-disk diagnostic log (console output is not captured in GUI logs). */
function diag(message) {
  try {
    const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
    appendFileSync(`${home}/session-recycle-debug.log`,
      `${new Date().toISOString()} ${message}\n`);
  } catch { /* diagnostics must never break the plugin */ }
}

export const name = PLUGIN_ID;

// Declare the real core services at module level so Cordis orders startup and
// hands us a context where they are directly available. The previous
// `inject = []` + nested ctx.inject() approach worked headless but the route
// registration callback never fired in the GUI host -> every /plugins/... 404.
// All four names are verified service injections used across core plugins.
export const inject = ['storageDomain', 'webServer', 'sessionPersistence', 'workspaceRegistry'];

// No Config export: the settings service inspects `Config` with `'toJSON' in cfg`
// and throws on null, which breaks the desktop welcome RPC at startup.
// Retention is fixed at 7 days (DEFAULT_RETENTION_DAYS).

/** Record stored per pending-deleted session (valueSchema mirror; plain JSON). */
// {
//   sessionId: string,
//   workspaceId: string | undefined,
//   title: string,
//   cwd: string | undefined,
//   sessionDir: string,          // the whole directory removed on purge
//   logFilePath: string,         // session.v4.jsonl.zstd inside sessionDir
//   projcachePath: string,       // ~/.dsh/storages/session_projcache/sessions/<id>.json
//   markedAt: string,            // ISO timestamp when moved into the bin
//   purgeAfter: string,          // ISO timestamp when automatic purge is allowed
// }

function logFilePathOf(projcacheFile, sessionId) {
  return projcacheFile;
}
void logFilePathOf;

/**
 * Build the manifest of files that WILL be removed when this session is
 * purged. Every entry is an absolute path; `exists` reflects the current disk
 * state so the client can gray out entries that are already gone.
 */
async function buildManifest(sessionPersistence, sessionId) {
  const entries = [];
  const snap = await sessionPersistence.stat(sessionId);
  if (snap?.location?.path) {
    const dir = dirname(snap.location.path);
    entries.push({ kind: 'dir', path: dir, exists: true, note: 'session log directory' });
    entries.push({ kind: 'file', path: snap.location.path, exists: true, note: 'session log (session.v4.jsonl.zstd)' });
  }
  const proj = projcachePathFor(sessionId);
  entries.push({ kind: 'file', path: proj, exists: true, note: 'per-session projection cache' });
  return entries;
}

/**
 * Resolve the per-session projection cache file. The storage root is not
 * exposed by the host API, so we reconstruct it from the known DSH home
 * layout (verified: /Users/cao/.dsh/storages/session_projcache/sessions/<id>.json).
 */
function projcachePathFor(sessionId) {
  const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
  return `${home}/storages/${PROJCACHE_DIR}/sessions/${sessionId}.json`;
}

export function apply(ctx) {
  diag(`apply(): keys=[${['storageDomain', 'webServer', 'sessionPersistence', 'workspaceRegistry'].map(k => `${k}:${ctx[k] === undefined ? 'MISSING' : 'ok'}`).join(', ')}]`);
  const service = new RecycleBinService(ctx);
  ctx.effect(() => () => service.dispose(), 'session-recycle');
  // Register HTTP routes FIRST, synchronously: never let a slow/failing
  // storageDomain.open() defer the exact-route registrations behind the
  // client-modules /plugins fallback (which returns an empty 404).
  try {
    service.registerRoutes();
    diag('registerRoutes(): done');
  } catch (error) {
    diag(`registerRoutes(): FAILED ${error?.stack ?? error}`);
  }
  void service.start();
}

class RecycleBinService {
  constructor(ctx) {
    this.rootCtx = ctx;
    this.ctx = ctx;
    this.domain = undefined;
    this.table = undefined;
    this.sweepTimer = undefined;
    this.disposers = [];
  }

  /** Switch to the context that declared storageDomain as an injection. */
  attach(scoped) {
    this.ctx = scoped;
  }

  get logger() {
    try {
      return this.ctx.logger ?? { info() {}, warn() {}, error() {} };
    } catch {
      return { info() {}, warn() {}, error() {} };
    }
  }

  async start() {
    try {
      await this.startInner();
      diag('start(): ready');
    } catch (error) {
      diag(`start(): FAILED ${error?.stack ?? error}`);
      console.error('[session-recycle] startup failed:', error?.stack ?? error);
      try { this.logger.error('session-recycle: startup failed (plugin disabled until fixed): %s', error); } catch {}
    }
  }

  async startInner() {
    // Open the durable domain (single-layout JSON file on disk). storageDomain
    // is declared in module-level inject, so it is available on ctx directly.
    const storageDomain = this.ctx.storageDomain;
    if (storageDomain === undefined) throw new Error('storageDomain service unavailable');
    this.domain = await storageDomain.open({
      name: DOMAIN_NAME,
      version: 1,
      layout: 'single',
      tables: {
        entries: { valueSchema: ANY_SCHEMA },
      },
    });
    this.table = this.domain.table('entries');

    // Hourly sweep + one sweep at startup.
    this.scheduleSweep();
    this.disposers.push(() => clearTimeout(this.sweepTimer));

    // Expose HTTP endpoints for the web client.
    // Routes are already registered in apply(); kept here as a safety net for
    // contexts where apply() could not see webServer but a later ctx can.
    if (this.routeDisposers === undefined) this.registerRoutes();
  }

  dispose() {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  scheduleSweep() {
    const tick = async () => {
      try {
        const purged = await this.purgeExpired();
        if (purged.length > 0) {
          this.logger.info(`session-recycle: auto-purged ${purged.length} expired session(s)`);
        }
      } catch (error) {
        this.logger.warn('session-recycle: sweep failed: %s', error);
      } finally {
        this.sweepTimer = setTimeout(tick, PURGE_SWEEP_MS);
        this.sweepTimer.unref?.();
      }
    };
    this.sweepTimer = setTimeout(tick, 30 * 1000);
    this.sweepTimer.unref?.();
  }

  // ---------------------------------------------------------------- operations

  /**
   * Mark a session pending-delete: the record lands in the recycle bin and the
   * session is archived in the workspace registry so it disappears from the
   * sidebar immediately, while its files stay untouched for 7 days.
   */
  async moveToTrash(sessionId, { stopActivity = false } = {}) {
    const sessionPersistence = this.ctx.sessionPersistence;
    if (sessionPersistence === undefined) throw new Error('sessionPersistence service unavailable');
    if (await this.table.get(sessionId)) return this.describe(sessionId);

    // Refuse to bin an active session unless the caller asks to stop it first
    // (mirrors WorkspaceRegistry.archiveSession semantics).
    let activity = [];
    if (typeof this.ctx.waterfall === 'function') {
      try {
        activity = await this.ctx.waterfall(
          'workspace/session-activity', { sessionId }, () => Promise.resolve([]),
        ) ?? [];
      } catch (error) {
        this.logger.warn('session-recycle: activity check failed: %s', error);
      }
    }
    if (activity.length > 0 && !stopActivity) {
      const error = new Error(`session '${sessionId}' is active`);
      error.code = 'session-active';
      error.activity = activity;
      throw error;
    }

    const snap = await sessionPersistence.stat(sessionId);
    if (!snap) {
      const error = new Error(`session '${sessionId}' not found`);
      error.code = 'session-unknown';
      throw error;
    }

    const now = new Date();
    const purgeAfter = new Date(now.getTime() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const workspace = this.findWorkspaceOf(sessionId);

    const record = {
      sessionId,
      workspaceId: workspace?.id,
      title: this.titleOf(sessionId, snap),
      cwd: snap.header?.cwd,
      sessionDir: snap.location?.path ? dirname(snap.location.path) : undefined,
      logFilePath: snap.location?.path,
      projcachePath: projcachePathFor(sessionId),
      markedAt: now.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    };

    await this.table.put(sessionId, record);

    // Hide the session from every grouping surface via the supported archive
    // path (registry handles pin-drop and activity stop for us).
    const registry = this.ctx.workspaceRegistry;
    if (registry !== undefined) {
      await registry.archiveSession(sessionId, stopActivity ? { stopActivity: true } : {});
    }
    return this.describe(sessionId);
  }

  /** Return a session to normal visibility; the bin record is dropped. */
  async restore(sessionId) {
    const record = await this.table.get(sessionId);
    if (!record) {
      const error = new Error(`session '${sessionId}' is not in the recycle bin`);
      error.code = 'not-in-trash';
      throw error;
    }
    const registry = this.ctx.workspaceRegistry;
    if (registry !== undefined) await registry.unarchiveSession(sessionId);
    await this.table.delete(sessionId);
    return { restored: true, sessionId };
  }

  /**
   * Delete immediately (right-click in the bin). Files are removed best-effort:
   * the session log directory and the projection cache file; failures are
   * collected, not fatal, so partial cleanup still drops the bin record.
   */
  async purgeNow(sessionId) {
    const record = await this.table.get(sessionId);
    if (!record) {
      const error = new Error(`session '${sessionId}' is not in the recycle bin`);
      error.code = 'not-in-trash';
      throw error;
    }
    const removed = await this.removeFiles(record);
    const registry = this.ctx.workspaceRegistry;
    if (registry !== undefined) {
      // Deliberately keep the session in archivedSessionIds: the client's
      // sessions.list snapshot still holds the stale summary until its next
      // full refresh, and the sidebar's default filter hides archived ids.
      // Unarchiving here would make the ghost row VISIBLE again.
      // The client calls sessions.refresh() after a successful purge, which
      // drops the stale summary (the purged session is gone from
      // persistence.list()), after which the archived entry is inert.
      void registry;
    }
    await this.table.delete(sessionId);
    return { purged: true, sessionId, removed };
  }

  async purgeExpired() {
    const now = Date.now();
    const expired = [];
    for (const [sessionId, record] of await this.table.entries()) {
      if (new Date(record.purgeAfter).getTime() <= now) expired.push(sessionId);
    }
    const purged = [];
    for (const sessionId of expired) {
      try {
        await this.purgeNow(sessionId);
        purged.push(sessionId);
      } catch (error) {
        this.logger.warn('session-recycle: purge of %s failed: %s', sessionId, error);
      }
    }
    return purged;
  }

  async list() {
    const entries = [];
    for (const [, record] of await this.table.entries()) {
      entries.push({
        ...record,
        manifest: await this.manifestOf(record),
        // Refine a stored id-prefix title once the projection cache has a real
        // one (records written by an older build stored the prefix only).
        title: record.title === record.sessionId.slice(0, 8)
          ? this.titleOf(record.sessionId)
          : record.title,
        daysRemaining: Math.max(0, Math.ceil(
          (new Date(record.purgeAfter).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
        )),
      });
    }
    entries.sort((a, b) => b.markedAt.localeCompare(a.markedAt));
    return { entries };
  }

  async describe(sessionId) {
    const record = await this.table.get(sessionId);
    if (!record) return undefined;
    return {
      ...record,
      manifest: await this.manifestOf(record),
      daysRemaining: Math.max(0, Math.ceil(
        (new Date(record.purgeAfter).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
      )),
    };
  }

  async manifestOf(record) {
    const entries = [];
    if (record.logFilePath) {
      entries.push({
        kind: 'file', path: record.logFilePath,
        exists: this.exists(record.logFilePath),
        note: 'session log (session.v4.jsonl.zstd)',
      });
    }
    if (record.sessionDir) {
      entries.push({
        kind: 'dir', path: record.sessionDir,
        exists: this.exists(record.sessionDir),
        note: 'session log directory (removed with all contents)',
      });
    }
    if (record.projcachePath) {
      entries.push({
        kind: 'file', path: record.projcachePath,
        exists: this.exists(record.projcachePath),
        note: 'per-session projection cache',
      });
    }
    return entries;
  }

  exists(path) {
    try { return existsSync(path); } catch { return false; }
  }

  async removeFiles(record) {
    const removed = [];
    const errors = [];
    if (record.sessionDir) {
      try {
        rmSync(record.sessionDir, { recursive: true, force: true });
        removed.push(record.sessionDir);
      } catch (error) {
        errors.push({ path: record.sessionDir, error: String(error) });
      }
    }
    if (record.projcachePath) {
      try {
        rmSync(record.projcachePath, { force: true });
        removed.push(record.projcachePath);
      } catch (error) {
        errors.push({ path: record.projcachePath, error: String(error) });
      }
    }
    return { removed, errors };
  }

  findWorkspaceOf(sessionId) {
    const registry = this.ctx.workspaceRegistry;
    if (registry === undefined) return undefined;
    for (const workspace of registry.list()) {
      if (workspace.sessionIds?.includes(sessionId)) return { id: workspace.id, path: workspace.path, title: workspace.title };
    }
    return undefined;
  }

  titleOf(sessionId, snap) {
    // The registry does not expose titles; the per-session projection cache on
    // disk carries the user-visible one at record.rows.title.val. Reading it
    // here keeps the recycle-bin rows reviewable by a human instead of showing
    // a bare id prefix. Any unreadable/absent value falls back to the prefix.
    void snap;
    try {
      const raw = readFileSync(projcachePathFor(sessionId), 'utf8');
      const parsed = JSON.parse(raw);
      const value = parsed?.record?.rows?.title?.val ?? parsed?.rows?.title?.val;
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    } catch {
      // Missing cache (already swept) or unparsable: fall through.
    }
    return sessionId.slice(0, 8);
  }

  // -------------------------------------------------------------------- routes

  registerRoutes() {
    // Guards against the apply() + startInner() double call registering the
    // same exact paths twice (a composition-level contract violation).
    if (this.routeDisposers !== undefined) return;
    {
      const webServer = this.ctx.webServer;
      if (webServer === undefined) {
        diag('registerRoutes(): webServer MISSING');
        this.logger.error('session-recycle: webServer service unavailable, routes not registered');
        return;
      }
      const disposers = [];
      // The web client calls /plugins/session-recycle/<op>. Exact routes win
      // over the client-modules /plugins/<package>/ prefix fallback.
      const route = (entry) => {
        try {
          disposers.push(webServer.register(entry));
          diag(`route registered: ${entry.path}`);
        } catch (error) {
          diag(`route FAILED ${entry.path}: ${error?.stack ?? error}`);
        }
      };

      const json = (res, status, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
      };

      const handle = (method, run) => async (req, res) => {
        if (req.method !== method) return json(res, 405, { error: 'method not allowed' });
        try {
          const body = method === 'POST' ? await readBody(req) : undefined;
          return await run(body, res);
        } catch (error) {
          const code = error?.code;
          const status = code === 'session-active' ? 409
            : code === 'session-unknown' || code === 'not-in-trash' ? 404
              : 500;
          return json(res, status, { error: String(error?.message ?? error), code });
        }
      };

      route({
        kind: 'exact',
        path: `/plugins/${PLUGIN_ID}/preview`,
        handler: handle('POST', async (body, res) => {
          const sessionId = body?.sessionId;
          if (!sessionId) return json(res, 400, { error: 'sessionId required' });
          // Manifest preview: stat now, no state changes.
          try {
            const sessionPersistence = this.ctx.sessionPersistence;
            if (sessionPersistence === undefined) {
              return json(res, 503, { error: 'sessionPersistence service unavailable', code: 'service-unavailable' });
            }
            const snap = await sessionPersistence.stat(sessionId);
            if (!snap) return json(res, 404, { error: `session '${sessionId}' not found`, code: 'session-unknown' });
            const record = {
              logFilePath: snap.location?.path,
              sessionDir: snap.location?.path ? dirname(snap.location.path) : undefined,
              projcachePath: projcachePathFor(sessionId),
            };
            return json(res, 200, { manifest: await this.manifestOf(record) });
          } catch (error) {
            return json(res, 500, { error: String(error?.message ?? error) });
          }
        }),
      });
      route({
        kind: 'exact',
        path: `/plugins/${PLUGIN_ID}/list`,
        handler: handle('GET', async (_body, res) => json(res, 200, await this.list())),
      });
      route({
        kind: 'exact',
        path: `/plugins/${PLUGIN_ID}/trash`,
        handler: handle('POST', async (body, res) => {
          const sessionId = body?.sessionId;
          if (!sessionId) return json(res, 400, { error: 'sessionId required' });
          return json(res, 200, await this.moveToTrash(sessionId, { stopActivity: body?.stopActivity === true }));
        }),
      });
      route({
        kind: 'exact',
        path: `/plugins/${PLUGIN_ID}/restore`,
        handler: handle('POST', async (body, res) => {
          const sessionId = body?.sessionId;
          if (!sessionId) return json(res, 400, { error: 'sessionId required' });
          return json(res, 200, await this.restore(sessionId));
        }),
      });
      route({
        kind: 'exact',
        path: `/plugins/${PLUGIN_ID}/purge`,
        handler: handle('POST', async (body, res) => {
          const sessionId = body?.sessionId;
          if (!sessionId) return json(res, 400, { error: 'sessionId required' });
          return json(res, 200, await this.purgeNow(sessionId));
        }),
      });

      this.routeDisposers = disposers;
      this.disposers.push(() => { for (const dispose of disposers) dispose(); });
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}
