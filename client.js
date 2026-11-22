/**
 * Session Recycle Bin — web client half.
 *
 * 1. Adds a "移入回收站" item to the workspace session right-click menu.
 *    Picking it opens a confirm dialog listing the files that will be
 *    removed if the session is later purged, then calls the host route.
 * 2. Registers a sidebar panel row (`sidebar.panellist`) plus a full
 *    `main` page listing pending-deleted sessions with their file
 *    manifests, restore and delete-now actions (delete-now re-confirms
 *    with the manifest).
 *
 * Dependencies: ONLY `react` / `react/jsx-runtime` — both are plain
 * entries in the host module map, so no bundle-time wiring is needed.
 * UI components are styled inline with DSW CSS variables, matching how
 * dsh-connect-workbuddy degrades when host widgets are unavailable.
 */
window.__ModuleLoader__.load({
  id: 'session-recycle',
  factory(require) {
    const React = require('react');
    const jsx = require('react/jsx-runtime');
    const h = React.createElement;
    const j = (type, props, ...children) => jsx.jsx(type, props ?? {}, ...children);

    const NS = 'session-recycle';
    const BASE = '/plugins/session-recycle';
    const PANEL_ID = 'session-recycle-bin';

    // Tell the host-authoritative session list to re-pull so the workspace
    // sidebar reflects the change without a restart. The client `sessions`
    // service (provided by @deepseek-ai/dsh-api-session-controller on the
    // client root ctx, with `refresh(): Promise<void>`) is stashed by apply()
    // once the plugin fiber starts. Best-effort: sidebar staleness is
    // cosmetic, so failures only log.
    let sessionsApi = undefined;
    function notifyWorkspaceChanged() {
      const refresh = sessionsApi?.refresh;
      if (typeof refresh === 'function') {
        Promise.resolve(refresh.call(sessionsApi)).catch((e) =>
          console.warn(`[${NS}] sessions.refresh failed:`, e));
      } else {
        console.warn(`[${NS}] sessions service unavailable; sidebar may stay stale until reload`);
      }
    }

    async function call(op, body, method = 'POST') {
      const res = await fetch(`${BASE}/${op}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    }

    // ------------------------------------------------------------- primitives

    const BTN_BASE = {
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-color-border, rgba(127,127,127,0.3))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      padding: '4px 12px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    };

    function Button({ kind = 'default', disabled, onClick, children }) {
      const style = { ...BTN_BASE };
      if (kind === 'primary') {
        style.background = 'var(--dsw-alias-color-brand, #4e6ef2)';
        style.borderColor = 'transparent';
        style.color = '#fff';
      } else if (kind === 'danger') {
        style.color = '#e5484d';
        style.borderColor = 'rgba(229,72,77,0.45)';
      }
      if (disabled) { style.opacity = 0.5; style.cursor = 'not-allowed'; }
      return h('button', { style, disabled, onClick }, children);
    }

    function Overlay({ onClose, children }) {
      const [hoveringCard, setHoveringCard] = React.useState(false);
      return h('div', {
        onClick: () => { if (!hoveringCard) onClose(); },
        style: {
          // The backdrop dims the page behind the dialog (kept, as requested);
          // the dialog card itself uses an explicit mid-grey palette instead of
          // theme aliases — those resolved to a near-black card with inherited
          // dark text in the desktop web shell, making confirmations unreadable.
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
      },
        h('div', {
          onMouseEnter: () => setHoveringCard(true),
          onMouseLeave: () => setHoveringCard(false),
          style: {
            width: 560, maxWidth: '92vw', maxHeight: '80vh', overflow: 'auto',
            background: '#2b2b2e',
            color: '#e6e6e6',
            border: '1px solid #45454a',
            borderRadius: 10, padding: 18,
            boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
            fontFamily: 'inherit',
          },
        }, children),
      );
    }

    function ToastMessage({ text }) {
      return h('div', {
        style: {
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10000, background: 'rgba(30,30,30,0.92)', color: '#fff',
          fontSize: 13, padding: '8px 16px', borderRadius: 8,
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        },
      }, text);
    }

    // Simple toast bus — module-level so plain callbacks can raise toasts.
    const toastListeners = new Set();
    let toastText = null;
    function showToast(text) {
      toastText = text;
      for (const l of [...toastListeners]) try { l(); } catch {}
    }
    function ToastHost() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        toastListeners.add(force);
        return () => toastListeners.delete(force);
      }, []);
      if (!toastText) return null;
      return h(ToastMessage, { text: toastText });
    }
    // Auto-clear: re-arm a timer on every toast.
    let toastTimer;
    const _origShow = showToast;
    function showToastAuto(text) {
      _origShow(text);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => showToast(null), 3500);
    }
    const toast = showToastAuto;

    // ---------------------------------------------- move-to-trash dialog request
    // The structured context-menu `run` callback is a plain function, not a
    // component, so it cannot hold React state. A tiny module-level store
    // bridges the menu action to a `shell.overlay` dialog component.
    const trashDialogListeners = new Set();
    let trashDialogReq = null; // { sessionId, manifest } | null
    function setTrashDialogReq(req) {
      trashDialogReq = req;
      for (const l of [...trashDialogListeners]) try { l(); } catch {}
    }
    function useTrashDialogReq() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        trashDialogListeners.add(force);
        return () => trashDialogListeners.delete(force);
      }, []);
      return trashDialogReq;
    }

    // ---------------------------------------------------------- manifest list

    function ManifestList({ manifest }) {
      const rows = (manifest ?? []).map((entry, index) => h('div', {
        key: index,
        style: {
          display: 'flex', gap: 8, alignItems: 'baseline',
          fontSize: 12, lineHeight: '18px', padding: '2px 0',
          opacity: entry.exists === false ? 0.45 : 1,
        },
      },
        h('code', {
          style: {
            fontFamily: 'var(--dsw-alias-font-code, monospace)',
            fontSize: 11,
            background: 'var(--dsw-alias-color-fill-tertiary, rgba(127,127,127,0.12))',
            borderRadius: 4,
            padding: '1px 6px',
            wordBreak: 'break-all',
          },
        }, entry.path),
        h('span', { style: { flexShrink: 0, opacity: 0.6, whiteSpace: 'nowrap' } }, entry.note),
      ));
      return h('div', { style: { margin: '6px 0' } },
        rows.length > 0 ? rows : h('div', { style: { opacity: 0.6, fontSize: 12 } }, '(无文件记录)'));
    }

    // ------------------------------------------------------------ confirm modal

    function ConfirmDialog({ state }) {
      if (!state?.open) return null;
      const { title, message, manifest, confirmLabel, danger, onConfirm, onClose, busy } = state;
      return h(Overlay, { onClose: () => { if (!busy) onClose(); } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, title),
          h('div', { style: { fontSize: 13, lineHeight: '20px', opacity: 0.8, marginBottom: 4 } }, message),
          manifest ? h('div', null,
            h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.7, margin: '10px 0 2px' } }, '将删除以下文件：'),
            h(ManifestList, { manifest }),
          ) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
            h(Button, { onClick: () => { if (!busy) onClose(); } }, '取消'),
            h(Button, {
              kind: danger ? 'danger' : 'primary',
              disabled: busy,
              onClick: onConfirm,
            }, busy ? '处理中…' : confirmLabel),
          ),
        ),
      );
    }

    // ------------------------------------------------------------ trash panel

    // ------------------------------------------------------ bin row context menu

    /**
     * Right-click menu for one recycle-bin record.
     *
     * Requirement 3 asks for delete-now *by right-click* on a bin record, so the
     * menu is the primary path and the row buttons are the discoverable one.
     * Both open the same confirmation dialogs, which list the files to remove.
     */
    function ContextMenu({ state, onClose }) {
      if (!state) return null;
      const { x, y, entry, onRestore, onPurge } = state;
      const item = (label, danger, onClick) => h('div', {
        onClick: () => { onClose(); onClick(); },
        style: {
          padding: '6px 14px',
          fontSize: 13,
          cursor: 'pointer',
          color: danger ? '#e5484d' : 'inherit',
          borderRadius: 6,
        },
        onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-color-fill-tertiary, rgba(127,127,127,0.14))'; },
        onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent'; },
      }, label);

      // The overlay catches the click-away dismiss; the menu stops propagation
      // so choosing a row does not immediately close the whole surface first.
      return h('div', {
        onMouseDown: onClose,
        onContextMenu: (event) => { event.preventDefault(); onClose(); },
        style: { position: 'fixed', inset: 0, zIndex: 9998 },
      },
        h('div', {
          onMouseDown: (event) => event.stopPropagation(),
          style: {
            position: 'fixed',
            left: x,
            top: y,
            minWidth: 160,
            padding: 4,
            borderRadius: 8,
            background: 'var(--dsw-alias-color-bg, #1e1e1e)',
            border: '1px solid var(--dsw-alias-color-border, rgba(127,127,127,0.3))',
            boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
          },
        },
          item(`还原「${entry.title}」`, false, () => onRestore(entry)),
          item('立即永久删除…', true, () => onPurge(entry)),
        ),
      );
    }

    function TrashPanel() {
      const [entries, setEntries] = React.useState(undefined);
      const [error, setError] = React.useState(undefined);
      const [dialog, setDialog] = React.useState(null);
      const [busyId, setBusyId] = React.useState(undefined);
      // Right-click menu on a bin row: { x, y, entry } | null.
      const [ctxMenu, setCtxMenu] = React.useState(null);

      const refresh = React.useCallback(async () => {
        try {
          const data = await call('list', undefined, 'GET');
          setEntries(data.entries ?? []);
          setError(undefined);
        } catch (e) { setError(String(e.message ?? e)); }
      }, []);

      React.useEffect(() => { void refresh(); }, [refresh]);

      const doRestore = (entry) => {
        setDialog({
          open: true,
          title: '还原会话',
          message: `将「${entry.title}」移出回收站并恢复到工作区列表。不会删除任何文件。`,
          confirmLabel: '还原',
          onConfirm: async () => {
            setBusyId(entry.sessionId);
            try {
              await call('restore', { sessionId: entry.sessionId });
              setDialog(null);
              toast(`已还原「${entry.title}」`);
              void refresh();
              notifyWorkspaceChanged();
            } catch (e) { setError(String(e.message ?? e)); } finally { setBusyId(undefined); }
          },
          onClose: () => setDialog(null),
        });
      };

      const doPurge = (entry) => {
        setDialog({
          open: true,
          danger: true,
          title: '立即删除（不等待 7 天）',
          message: `将永久删除「${entry.title}」的会话记录及其文件，此操作不可撤销。`,
          manifest: entry.manifest,
          confirmLabel: '永久删除',
          onConfirm: async () => {
            setBusyId(entry.sessionId);
            try {
              await call('purge', { sessionId: entry.sessionId });
              setDialog(null);
              toast(`已永久删除「${entry.title}」`);
              void refresh();
              notifyWorkspaceChanged();
            } catch (e) { setError(String(e.message ?? e)); } finally { setBusyId(undefined); }
          },
          onClose: () => setDialog(null),
        });
      };

      if (error !== undefined) {
        return h('div', { style: { padding: 16, fontSize: 13, color: 'crimson' } }, `加载失败：${error}`);
      }
      if (entries === undefined) {
        return h('div', { style: { padding: 16, fontSize: 13, opacity: 0.6 } }, '加载中…');
      }

      return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 8 } },
        h(ConfirmDialog, { state: dialog }),
        h(ContextMenu, {
          state: ctxMenu === null ? null : { ...ctxMenu, onRestore: doRestore, onPurge: doPurge },
          onClose: () => setCtxMenu(null),
        }),
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } },
          `回收站（${entries.length} 项）`),
        entries.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, '回收站为空。右键工作区会话可将其移入回收站；7 天后自动清除。')
          : h(React.Fragment, null,
              h('div', { style: { fontSize: 11, opacity: 0.55, marginBottom: 2 } },
                '右键记录可直接还原或立即永久删除（不需等 7 天）。'),
              entries.map((entry) => h('div', {
                key: entry.sessionId,
                onContextMenu: (event) => {
                  event.preventDefault();
                  setCtxMenu({ x: event.clientX, y: event.clientY, entry });
                },
                style: {
                  border: '1px solid var(--dsw-alias-color-border, rgba(127,127,127,0.25))',
                  borderRadius: 8,
                  padding: '8px 10px',
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', {
                      style: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: entry.sessionId,
                    }, entry.title),
                    h('div', { style: { fontSize: 11, opacity: 0.6 } },
                      `标记于 ${new Date(entry.markedAt).toLocaleString()} · ${entry.daysRemaining} 天后自动清除`),
                  ),
                  busyId === entry.sessionId
                    ? h('span', { style: { fontSize: 12, opacity: 0.6 } }, '…')
                    : h(React.Fragment, null,
                        h(Button, { kind: 'default', onClick: () => doRestore(entry) }, '还原'),
                        h(Button, { kind: 'danger', onClick: () => doPurge(entry) }, '立即删除'),
                      ),
                ),
                h(ManifestList, { manifest: entry.manifest }),
              ))),
      );
    }

    // ------------------------------------------- move-to-trash confirm dialog
    // Rendered in `shell.overlay`, driven by the module-level request store so
    // the structured context-menu `run` callback can open it.

    function TrashRequestDialog() {
      const req = useTrashDialogReq();
      const [busy, setBusy] = React.useState(false);
      if (!req) return null;

      const confirm = async () => {
        setBusy(true);
        try {
          await call('trash', { sessionId: req.sessionId });
          toast('已移入回收站，7 天后自动清除（可在回收站面板还原）');
          setTrashDialogReq(null);
          notifyWorkspaceChanged();
        } catch (e) {
          toast(`移入回收站失败：${e.message ?? e}`);
          setTrashDialogReq(null);
        } finally { setBusy(false); }
      };

      return h(Overlay, { onClose: () => { if (!busy) setTrashDialogReq(null); } },
        h('div', null,
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, '移入回收站'),
          h('div', { style: { fontSize: 13, lineHeight: '20px', opacity: 0.85 } },
            `将「${req.title}」从列表隐藏并标记为待删除；7 天后自动清除其文件。期间可在「回收站」面板还原。`),
          h('div', null,
            h('div', { style: { fontSize: 12, fontWeight: 600, opacity: 0.8, margin: '12px 0 2px' } }, '清除时将删除以下文件：'),
            h(ManifestList, { manifest: req.manifest }),
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 } },
            h(Button, { onClick: () => setTrashDialogReq(null) }, '取消'),
            h(Button, { kind: 'danger', disabled: busy, onClick: confirm }, busy ? '处理中…' : '移入回收站'),
          ),
        ),
      );
    }

    // ------------------------------------------------------------ icons

    function trashGlyph(size) {
      return [
        h('path', {
          key: 'lid',
          d: 'M2.5 4h11M6.5 4V2.8c0-.44.36-.8.8-.8h1.4c.44 0 .8.36.8.8V4M4 4l.7 9.2c.05.72.65 1.3 1.37 1.3h3.86c.72 0 1.32-.58 1.37-1.3L12 4',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'bars',
          d: 'M6.6 7v5M9.4 7v5',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
        }),
      ];
    }

    function PanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
      }, trashGlyph(size));
    }

    // Icon rendered inside the host's standard context-menu row (14px, currentColor).
    function TrashMenuIcon(props) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
      }, trashGlyph(14));
    }

    // ------------------------------------------------------------ registration

    return {
      name: NS,
      inject: ['slots'],
      apply(clientCtx) {
        // Stash the client `sessions` service for notifyWorkspaceChanged().
        // Plugin fiber ctx resolves services from the client root ctx via the
        // reflect chain; resolve() (not get()) avoids the inject-declaration
        // requirement and just returns undefined if the service is absent.
        try {
          sessionsApi = clientCtx.resolve('sessions');
          if (sessionsApi === undefined) {
            console.warn(`[${NS}] client 'sessions' service not resolvable at apply()`);
          }
        } catch (error) {
          console.warn(`[${NS}] resolving client 'sessions' failed:`, error);
        }

        const register = (slotName, meta, component) => {
          try {
            return clientCtx.slots.inject(slotName, () => clientCtx.slots.register(meta, component));
          } catch (error) {
            console.error(`[${NS}] slot '${slotName}' failed to register:`, error);
            return undefined;
          }
        };

        // Sidebar nav row → main keyed page. Mirrors workbuddy: the row's
        // glyph is the registered component; the page is a separate `main`
        // entry keyed by PANEL_ID so the row's click can open it.
        register('sidebar.panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 80,
          label: '回收站',
        }, PanelIcon);

        register('main', {
          name: 'main',
          key: PANEL_ID,
        }, TrashPanel);

        // Toast host: render into the conversation dock so toasts survive
        // on any panel. Guarded — if the seat is absent the toasts just
        // don't show.
        register('conversation.composer.dock', {
          name: 'conversation.composer.dock',
          id: `${NS}.toast`,
          order: 90,
        }, ToastHost);

        // Move-to-trash confirmation dialog lives in the host's overlay seat.
        register('shell.overlay', {
          name: 'shell.overlay',
          id: `${NS}.trash-request`,
        }, TrashRequestDialog);

        // Glyph for our context-menu action, registered once at apply time
        // (same pattern as the built-in session menus). 14px / currentColor
        // is the host convention for context-menu icons.
        register('contextMenu.icon', {
          name: 'contextMenu.icon',
          key: `${NS}.menu.delete.icon`,
        }, TrashMenuIcon);

        // Structured session context-menu action. This is the SAME path the
        // built-in Archive/Pin items use, so our row inherits the host's menu
        // typography and spacing (the legacy `sidebar.workspaces.session.menu.item`
        // slot rendered a hand-styled div, which looked different). The `run`
        // callback only stages a dialog request; the dialog itself fetches the
        // manifest for human review before calling `trash`.
        clientCtx.inject(['contextMenus'], (menuCtx) => {
          menuCtx.effect(() => menuCtx.contextMenus.register({
            id: `${NS}.session.moveToTrash`,
            target: 'session',
            order: 700, // after built-ins: pin100/rename200/fork300/copy450/archive600
            resolve: ({ sessionId, displayTitle }) => [{
              id: 'moveToTrash',
              label: '移入回收站…',
              icon: { key: `${NS}.menu.delete.icon` },
              run: () => {
                // Fetch the file manifest first, then open the confirm dialog.
                call('preview', { sessionId })
                  .then((data) => setTrashDialogReq({
                    sessionId,
                    title: displayTitle || sessionId.slice(0, 8),
                    manifest: data.manifest ?? [],
                  }))
                  .catch(() => setTrashDialogReq({
                    sessionId,
                    title: displayTitle || sessionId.slice(0, 8),
                    manifest: [],
                  }));
              },
            }],
          }), `${NS}: session context menu`);
        });
      },
    };
  },
});
