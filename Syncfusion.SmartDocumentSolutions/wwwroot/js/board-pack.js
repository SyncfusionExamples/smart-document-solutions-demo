/* ============================================================================
 * board-pack.js
 *
 * Client-side state owner + centre-panel renderer for the
 * Board Pack demo. Mirrors the role claimIntake.js plays for
 * the Claims Intake demo:
 *   * owns the workflow state in localStorage
 *   * renders the packet list, the workflow stepper, and the
 *     centre panel from a single state object
 *   * talks to /api/board-pack/* for upload / convert / pack /
 *     preview / manifest operations
 *
 * Modes seen in the URL + the switch (row, action):
 *   '' (load)  -> Upload
 *   'convert'  -> Convert
 *   'pack'     -> Pack & Sign
 *   'export'   -> Export
 *
 * Public surface (window.boardPack):
 *   state, save(), load(), wipe(),
 *   addDocument(doc), removeDocument(id),
 *   pickUploadedFile(file),
 *   setMode(mode),
 *   reset()
 *   on(event, fn) / emit(event, payload)
 *
 * The render() function rewrites the centre panel on every
 * state change so packet actions always reflect the latest
 * server snapshot.
 * ========================================================================== */
(function () {
    'use strict';

    var STORAGE_KEY = 'boardPack.state.v1';
    // Bump SCHEMA_VERSION whenever the shape of the state object
    // changes in a way that is not backwards compatible. The
    // load() helper compares the on-disk schemaVersion against
    // this constant and, on mismatch, drops the cached snapshot
    // entirely so the user is never served a stale view from a
    // previous deployment (a known cause of "flash of stale
    // content" after a CloudFront deploy where the HTML shell
    // is invalidated but the user's localStorage still holds a
    // snapshot from the previous version). v1 -> v2 introduced
    // the synchronous first-render bootstrap.
    var SCHEMA_VERSION = 2;
    var STEPS = ['upload', 'convert', 'pack', 'export'];

    var listeners = Object.create(null);
    var state = emptyState();
    var serverState = null;

    function emptyState() {
        return {
            schemaVersion: SCHEMA_VERSION,
            sessionId: '',
            activeMode: 'upload',
            documents: [],
            passwordProtect: false,
            password: '',
            passwordFeedback: '',
            passwordFeedbackType: 'info',
            // Single packet-wide watermark applied to every page
            // of the final Board Pack when enabled. The Pack
            // step renders one editor (toggle / "Confidential"
            // text / colour picker) instead of N per-document
            // rows so the user can configure the watermark once
            // for the entire merged document.
            commonWatermark: {
                enabled: false,
                text: 'Confidential',
                color: '#1d4ed8',
                fontSize: 48,
                opacity: 0.25,
                rotation: -40
            },
            boardPackPreviewUrl: '',
            sourcesPreviewUrl: '',
            boardPackGenerated: false,
            sourcesGenerated: false,
            manifestGenerated: false,
            // packDirty mirrors workspace.PackDirty from the
            // server. It is true when the user has changed a
            // Pack-side setting (reorder, bookmark title,
            // watermark, password) AFTER the last successful
            // Pack run. While true, the previously generated
            // Board Pack is OUT OF DATE - the Export step is
            // not "complete", and the bpRunPack button must
            // stay enabled so the user can rebuild the deck
            // from the current configuration. Cleared on every
            // successful /api/board-pack/pack response.
            packDirty: false,
            // Tracks whether the user has ever reached the
            // Export step. Used by the stepper to keep the green
            // tick on the Export circle after the user navigates
            // back to an earlier step - completionIndex() alone
            // can't tick the last step because nothing is
            // strictly `< max`.
            exportVisited: false,
            hasNewPendingFiles: false,
            // serverReady flips to true only after the first
            // /api/board-pack/workspace response has landed and
            // been merged into the local state. The boot path
            // keeps the splash overlay up while this is false
            // and removes it the first time it becomes true, so
            // the user is never shown a "ready" UI based purely
            // on the localStorage snapshot.
            serverReady: false
        };
    }

    // -- helpers -----------------------------------------------------------------
    function safeJson(r) {
        var status = r.status;
        return r.text().then(function (text) {
            if (!text) {
                return { ok: false, status: status, body: '', payload: null };
            }
            var ct = (r.headers.get('content-type') || '').toLowerCase();
            if (ct.indexOf('json') >= 0) {
                try { return { ok: r.ok, status: status, payload: JSON.parse(text) }; }
                catch (e) { return { ok: false, status: status, payload: null }; }
            }
            return { ok: false, status: status, body: text, payload: null };
        });
    }
    function failureMessage(env, fallback) {
        if (env && env.payload && env.payload.message) { return env.payload.message; }
        if (env && env.status) { return fallback + ' (server returned ' + env.status + ').'; }
        return fallback;
    }
    function escapeHtml(value) {
        if (value === null || value === undefined) { return ''; }
        return String(value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function formatBytes(bytes) {
        if (!bytes || bytes < 0) { return '0 B'; }
        var units = ['B', 'KB', 'MB', 'GB'];
        var n = bytes, i = 0;
        while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
        var fixed = (i === 0) ? n.toString() : n.toFixed(1);
        return fixed + ' ' + units[i];
    }
    function formatDate(iso) {
        if (!iso) { return ''; }
        try {
            var d = new Date(iso);
            if (isNaN(d.getTime())) { return ''; }
            var hh = d.getHours(); var mm = d.getMinutes();
            var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
            return d.toLocaleDateString() + ' ' + pad(hh) + ':' + pad(mm);
        } catch (e) { return ''; }
    }
    function pulseButton(button) {
        if (!button) { return; }
        button.classList.remove('bp-pulse-running');
        void button.offsetWidth;
        button.classList.add('bp-pulse-running');
    }
    function on(name, fn) {
        if (!listeners[name]) { listeners[name] = []; }
        listeners[name].push(fn);
    }
    function emit(name, payload) {
        (listeners[name] || []).forEach(function (fn) { try { fn(payload); } catch (e) { /* ignore */ } });
    }
    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            // localStorage may be full on very large packets.
            // Silently swallow so the demo keeps working.
        }
    }
    function load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) { return; }
            var parsed = JSON.parse(raw);
            // SCHEMA-GUARD: any snapshot that does not match the
            // current SCHEMA_VERSION is treated as corrupt. The
            // previous behaviour was to silently fall back to
            // emptyState() and leave the old snapshot on disk,
            // which is the most common root cause of the
            // "flash of stale content" after a CloudFront
            // deploy: a stale `documents` array, an old
            // `activeMode`, or a leftover `sessionId` from a
            // previous deployment would bleed into the first
            // render and survive long enough to be visible to
            // the user before the server response overwrote it.
            // Wipe the entry so the new schema starts from a
            // clean slate and future loads do not repeat the
            // cost of a schema-mismatch attempt.
            if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) {
                try { localStorage.removeItem(STORAGE_KEY); } catch (e2) { /* ignore */ }
                return;
            }
            state = Object.assign(emptyState(), parsed);
        } catch (e) {
            // ignore corrupt cache
            try { localStorage.removeItem(STORAGE_KEY); } catch (e2) { /* ignore */ }
        }
    }
    function wipe() {
        try { localStorage.removeItem(STORAGE_KEY); }
        catch (e) { /* ignore */ }
        state = emptyState();
    }

    // -- pack-dirty state machine ---------------------------------------------
    // The Pack step has its own micro state machine layered on top of
    // the four-step workflow: once a Board Pack has been generated
    // and the user has reached the Export step, the user can still
    // hop back to the Pack step to tweak settings. Those tweaks
    // *invalidate* the previously generated deliverables, so we need
    // to:
    //   *  Disable the Build button while the packet is in sync with
    //      the last Pack run (the user has nothing to do).
    //   *  Re-enable the Build button as soon as a Pack-side change
    //      is detected.
    //   *  Drop the Export step's "complete" tick until Pack runs
    //      again - the deliverables are stale.
    // markPackDirty() is the single mutation point for the client
    // side: it flips state.packDirty, clears the Export visited
    // flag, and re-renders. The server is the source of truth - the
    // helpers also stash the new value in localStorage so the state
    // survives a page reload before the next /workspace poll.
    function markPackDirty() {
        if (!state.boardPackGenerated) {
            // No prior export to invalidate - nothing to clear.
            return;
        }
        state.packDirty = true;
        // Clear the Export step tick: with the packet dirty, the
        // Export step is no longer "complete" - the user must run
        // Pack again before the deliverables are trustworthy.
        state.exportVisited = false;
        save();
        render();
    }

    // True when the most recent Pack run still matches the current
    // Pack configuration. Used by both the stepper renderer (to
    // decide whether to tick the Export step) and the Pack view
    // (to decide whether to disable the Build button).
    // hasNewPendingFiles is treated as a "dirty" signal even when
    // packDirty is false: the previous Pack run is still in sync
    // with the existing documents, but the new unprocessed files
    // mean the existing PDF/ZIP/manifest no longer cover the full
    // packet, so Export is NOT considered complete.
    function isExportCurrent() {
        return !!state.boardPackGenerated && !state.packDirty && !state.hasNewPendingFiles;
    }

    // -- session-aware fetch wrapper --------------------------------------------
    // All Board Pack API calls go through bpFetch, which adds the
    // X-BP-Session header AND a `bpSession` query string parameter
    // whenever state.sessionId is known. The server reads BOTH in
    // AdoptBpSession() and calls _store.AdoptSessionKey() before
    // every action.
    //
    // Belt-and-braces: CloudFront in front of the demo strips the
    // inbound `Cookie` header from origin-bound requests under the
    // default Origin Request Policy, AND strips unknown custom
    // headers (`X-BP-Session`). The query string is the only
    // transport that is *guaranteed* to be forwarded to the origin
    // under every default CloudFront configuration. By carrying the
    // session key in the URL itself, the origin can always pin the
    // request to the correct session without relying on the
    // ci_session cookie surviving the CDN hop.
    function bpFetch(rawUrl, opts) {
        opts = opts || {};
        opts.credentials = 'same-origin';
        if (state.sessionId) {
            // 1. Query string — always forwarded by CloudFront.
            var url = rawUrl;
            var sep = url.indexOf('?') >= 0 ? '&' : '?';
            url = url + sep + 'bpSession=' + encodeURIComponent(state.sessionId);
            // 2. Custom header — forwarded only if CloudFront's
            //    Origin Request Policy includes it, but harmless
            //    if dropped. (We can't control CloudFront's
            //    policy from the app, so the query string is the
            //    authoritative transport.)
            opts.headers = Object.assign({ 'X-BP-Session': state.sessionId }, opts.headers || {});
            return fetch(url, opts);
        }
        return fetch(rawUrl, opts);
    }

    // -- server sync ------------------------------------------------------------
    function refreshFromServer(preserveActiveMode) {
        var currentMode = state.activeMode;
        return bpFetch(window.appUrl('/api/board-pack/workspace'))
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.workspace) {
                    state.serverReady = false;
                    save();
                    render();
                    return;
                }
                serverState = env.payload.workspace;
                state.sessionId = serverState.sessionId || '';
                if (!preserveActiveMode) {
                    state.activeMode = (serverState.activeMode || 'upload').toLowerCase();
                } else {
                    state.activeMode = currentMode || 'upload';
                }
                state.passwordProtect = !!serverState.passwordProtect;
                state.commonWatermark = Object.assign({}, state.commonWatermark, serverState.commonWatermark || {});
                state.boardPackPreviewUrl = serverState.boardPackPreviewUrl || '';
                state.sourcesPreviewUrl = serverState.sourcesPreviewUrl || '';
                state.boardPackGenerated = !!serverState.boardPackGenerated;
                state.sourcesGenerated = !!serverState.sourcesGenerated;
                state.manifestGenerated = !!serverState.manifestGenerated;
                // packDirty is server-authoritative: any Pack-side
                // change (reorder, bookmark, watermark, password)
                // sets it on the server BEFORE the response is
                // returned, and a successful /pack call clears it.
                // We surface it as a top-level state field so the
                // Pack view can disable the Build button when the
                // packet is in sync and re-enable it on any change.
                state.packDirty = !!serverState.packDirty;
                state.documents = (serverState.documents || []).map(function (d) { return Object.assign({}, d); });
                state.serverReady = true;
                save();
                render();
            });
    }

    // -- file upload ------------------------------------------------------------
    function pickUploadedFile(file) {
        var fd = new FormData();
        fd.append('document', file, file.name);
        return bpFetch(window.appUrl('/api/board-pack/upload'), { method: 'POST', body: fd })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Upload failed.'));
                }
                return env.payload.document;
            });
    }

    // Upload a default template via the server-side /upload-by-template
    // endpoint. Mirrors apiUploadDefaultTemplate() in claimIntake.js:
    // the server reads the file from wwwroot/templatefiles/BoardPack/
    // and materialises it into the per-session Office folder —
    // no CDN fetch, no multipart re-upload, no CloudFront round-trip.
    //
    // state.sessionId (set by the preceding refreshFromServer call) is
    // forwarded as sessionKey so the server can call AdoptSessionKey
    // (via PerSessionFileStore) and pin all three sequential uploads to
    // the same workspace even when CloudFront TLS termination causes the
    // browser to drop the Secure-flagged ci_session cookie between
    // requests.
    function uploadDefaultTemplate(template) {
        var body = { fileName: template.name };
        if (state.sessionId) { body.sessionKey = state.sessionId; }
        return bpFetch(window.appUrl('/api/board-pack/upload-by-template'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Could not load template ' + template.name + '.'));
                }
                return env.payload.document;
            });
    }

    function addDefaultDocuments() {
        var defaultNames = [
            'Executive_Board_Report.docx',
            'Financial_Performance_Dashboard.xlsx',
            'Board_Performance_Presentation.pptx'
        ];
        // Only upload templates that are not already present.
        // The previous guard (`state.documents.length > 0`) returned
        // immediately whenever the localStorage snapshot had even one
        // document — e.g. a stale single-doc session from an earlier
        // AWS CloudFront visit with `activeMode:"convert"` — causing
        // the other two templates to never be loaded.
        var existingNames = (state.documents || []).map(function (d) {
            return (d.fileName || '').toLowerCase();
        });
        var missing = defaultNames.filter(function (n) {
            return existingNames.indexOf(n.toLowerCase()) === -1;
        });
        if (missing.length === 0) { return Promise.resolve(); }

        // Upload all missing templates in PARALLEL, then do a single
        // refreshFromServer so the UI reflects the full set of documents
        // in one shot.
        //
        // Parallel is safe here because every uploadDefaultTemplate call
        // passes `state.sessionId` both as a `bpSession` query-string
        // param (via bpFetch) AND as `sessionKey` in the POST body. The
        // server uses AdoptSessionKey() to pin each request to the same
        // workspace regardless of whether the CDN forwards the
        // Secure-flagged ci_session cookie. All three uploads therefore
        // land in the same session and the subsequent single
        // refreshFromServer returns the full set.
        //
        // The previous sequential chain was a safety measure against a
        // now-fixed bug where the cookie was the only session transport;
        // without the cookie each sequential upload could create a new
        // workspace and the documents from earlier uploads would
        // disappear before the next one started.
        return Promise.all(missing.map(function (name) {
            return uploadDefaultTemplate({ name: name });
        })).then(function () {
            return refreshFromServer();
        }).then(function () {
            emit('documents-changed', state.documents);
        });
    }

    function addDocument(doc) {
        // Server reflects the new packet; refresh from server
        // so the rest of the UI (status badges, etc.) stays
        // authoritative.
        return refreshFromServer().then(function () {
            if (state.boardPackGenerated) {
                state.hasNewPendingFiles = true;
                save();
                render();
            }
            emit('documents-changed', state.documents);
        });
    }

    function removeDocument(id) {
        // Removing a document from the packet invalidates the
        // previously generated Board Pack. Optimistic local
        // flip; the server confirms on the next /workspace poll.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/documents/' + encodeURIComponent(id)), {
            method: 'DELETE'
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not remove document.'));
                }
                return refreshFromServer(true);
            });
    }

    function reorderDocuments(ids) {
        // Optimistically flip the packDirty flag BEFORE the
        // server round-trip returns so the Build button enables
        // itself (and the Export step drops its tick) the
        // instant the user drops a row. The subsequent
        // refreshFromServer() inside .then() will re-read the
        // authoritative server flag (which the controller has
        // already set to true) and confirm the change.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/reorder'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: ids })
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not reorder.'));
                }
                return refreshFromServer(true);
            });
    }

    function updateWatermark(id, payload) {
        // Per-document watermark edits invalidate the
        // previously exported Board Pack. Optimistic local
        // flip; the server is the source of truth on the
        // next /workspace poll.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/watermarks/' + encodeURIComponent(id)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not update watermark.'));
                }
                return refreshFromServer(true);
            });
    }

    function updateCommonWatermark(payload) {
        // Toggling the common watermark (or editing its text
        // / colour) invalidates the previously exported Board
        // Pack. Optimistic local flip so the Build button
        // re-enables itself immediately on click.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/watermark'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not update watermark.'));
                }
                return refreshFromServer(true);
            });
    }

    function updateBookmark(id, payload) {
        // Bookmark edits invalidate the previously exported
        // Board Pack because the merged PDF's outline is
        // generated at Pack time. Optimistic local flip; the
        // server confirms on the next /workspace poll.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/bookmarks/' + encodeURIComponent(id)), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not update bookmark title.'));
                }
                return refreshFromServer(true);
            });
    }

    function updateSecurity(payload) {
        // Toggling password protection (or saving a new
        // password) invalidates the previously exported Board
        // Pack. Optimistic local flip so the Build button
        // re-enables itself immediately on click.
        markPackDirty();
        return bpFetch(window.appUrl('/api/board-pack/security'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Could not update security settings.'));
                }
                return refreshFromServer(true);
            });
    }

    function convertAll() {
        // Convert documents one-at-a-time so the UI can show each
        // document transitioning from Waiting → Converting → Converted
        // (or Failed) in real time, rather than waiting for a single
        // bulk request to complete before any status updates are visible.
        // The "waiting" / "failed" filter naturally skips documents
        // that are already Converted, so previously processed files
        // that are part of an existing Board Pack are NEVER
        // re-sent to the server - the new files added after the
        // Board Pack was generated are the only ones this loop
        // touches.
        var pending = (state.documents || []).filter(function (d) {
            var s = (d.status || '').toLowerCase();
            return s === 'waiting' || s === 'failed';
        });

        if (pending.length === 0) {
            // Nothing to do - refresh to get the latest server state.
            // Also clear the "new pending files" flag defensively:
            // if every document is already Converted there is no
            // outstanding work left to do, so the stepper can be
            // re-enabled and the ticks restored.
            if (state.hasNewPendingFiles) {
                state.hasNewPendingFiles = false;
            }
            return refreshFromServer(true);
        }

        // Build a sequential promise chain so the convert cards update
        // one-by-one rather than all-at-once.
        var chain = Promise.resolve();
        var anyError = null;

        pending.forEach(function (doc) {
            chain = chain.then(function () {
                // Optimistically mark this document as Converting in local
                // state so the card immediately shows the progress bar at 55%
                // before the server responds.
                var idx = -1;
                for (var i = 0; i < state.documents.length; i++) {
                    if (state.documents[i].id === doc.id) { idx = i; break; }
                }
                if (idx >= 0) {
                    state.documents[idx] = Object.assign({}, state.documents[idx], { status: 'Converting' });
                }
                render(); // Show "Converting" spinner on this card immediately

                return bpFetch(window.appUrl('/api/board-pack/convert/' + encodeURIComponent(doc.id)), {
                    method: 'POST'
                })
                .then(safeJson)
                .then(function (env) {
                    if (!env.ok || !env.payload) {
                        anyError = failureMessage(env, 'Conversion failed for ' + doc.fileName + '.');
                    }
                    // Merge the server's authoritative document list into
                    // local state so the card shows Converted / Failed.
                    if (env.payload && env.payload.workspace && env.payload.workspace.documents) {
                        var serverDocs = env.payload.workspace.documents;
                        state.documents = state.documents.map(function (d) {
                            var serverDoc = serverDocs.find(function (sd) { return sd.id === d.id; });
                            return serverDoc ? Object.assign({}, d, serverDoc) : d;
                        });
                        render();
                    }
                });
            });
        });

        return chain.then(function () {
            // Final authoritative refresh from the server so every status
            // field and convertedPreviewUrl is correct.
            return refreshFromServer(true).then(function () {
                // Once the chain finishes, every doc is either
                // Converted or Failed. If the Board Pack is
                // already generated and ALL docs are now in the
                // Converted state, the new-pending-files flag
                // has done its job - clear it so the stepper
                // regains navigation to Convert / Pack / Export
                // and the green ticks on Convert + Pack come
                // back. If any conversion failed we leave the
                // flag in place so the user can retry from the
                // Upload view.
                if (state.hasNewPendingFiles) {
                    var allConvertedNow = (state.documents || []).every(function (d) {
                        return (d.status || '').toLowerCase() === 'converted';
                    });
                    if (allConvertedNow) {
                        state.hasNewPendingFiles = false;
                        save();
                    }
                }
                if (anyError) { throw new Error(anyError); }
            });
        });
    }

    function packNow() {
        return bpFetch(window.appUrl('/api/board-pack/pack'), {
            method: 'POST'
        })
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Pack failed.'));
                }
                return refreshFromServer();
            });
    }

    function downloadBoardPack(kind) {
        // Build a hidden anchor so the response streams the
        // file directly with the browser's download manager.
        var link = document.createElement('a');
        link.href = window.appUrl('/api/board-pack/download/' + kind);
        link.download = '';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        setTimeout(function () {
            try { document.body.removeChild(link); } catch (e) { /* ignore */ }
        }, 250);
    }

    function openManifestPreview() {
        return bpFetch(window.appUrl('/api/board-pack/manifest'))
            .then(safeJson)
            .then(function (env) {
                if (!env.ok || !env.payload) {
                    throw new Error(failureMessage(env, 'Audit manifest is not available.'));
                }
                return env.payload;
            })
            .then(function (payload) {
                var body = document.getElementById('jsonPreviewBody');
                if (body) {
                    body.textContent = JSON.stringify(payload, null, 2);
                }
                openModal('jsonPreviewModal');
            });
    }

    function render() {
        // Use the shared workflow-step active and completed classes to correctly highlight the current step and display green completion checkmarks, ensuring the stepper reflects workflow progress beyond the Upload step.
        var activeMode = (state.activeMode || 'upload').toLowerCase();
        var activeIndex = Math.max(0, STEPS.indexOf(activeMode));
        var completedIndex = completionIndex();
       
        var exportDone = isExportCurrent();
        // When pendingProcessing is true because new files were added after Board Pack generation, keep Convert accessible for conversion progress tracking, lock Pack and 
        //Export until processing completes, and remove the Convert and Pack completion ticks to reflect the pending work state.
        var pendingProcessing = !!state.hasNewPendingFiles;
        // While pending, only Upload (0) and Convert (1) are
        // reachable from the stepper. Pack (2) and Export (3)
        // sit at or above the cap and are forced to disabled.
        var pendingCap = 1;
        STEPS.forEach(function (id, i) {
            var el = document.getElementById('step-' + id);
            if (!el) { return; }
            var reachable = i <= Math.max(activeIndex, completedIndex)
                || (i === STEPS.indexOf('export') && exportDone);
            //The Export step must NOT be clickable from the stepper.
            if (i === STEPS.indexOf('export') && state.packDirty && i !== activeIndex) {
                reachable = false;
            }
            // When new files are pending processing, keep Convert accessible for monitoring conversion progress, disable and lock Pack and Export in the stepper, and require the user to complete processing via "Process the selected files" before continuing through the workflow.
            if (pendingProcessing && i > pendingCap && i !== activeIndex) {
                reachable = false;
            }
            el.classList.toggle('disabled', !reachable);
            if (reachable) {
                el.removeAttribute('aria-disabled');
            } else {
                el.setAttribute('aria-disabled', 'true');
            }
        });
        // Paint active/completed steps + connecting lines.
        STEPS.forEach(function (id, i) {
            var el = document.getElementById('step-' + id);
            if (!el) { return; }
            var circle = el.querySelector('.workflow-circle');
            el.classList.remove('active', 'completed');
            var isActive = i === activeIndex;
            // Tick this step if the work for it is finished and
            // it isn't currently active. Export is ticked as soon
            // as the user has visited it; the rest use
            // completedIndex.
            // While pendingProcessing is true we drop the ticks
            // on Convert and Pack: the workflow is no longer
            // "complete" for those steps because the new files
            // have not been processed. The user will see the
            // ticks come back as soon as convertAll() finishes
            // (clears hasNewPendingFiles) and the normal
            // completionIndex() path resumes.
            var isCompleted;
            if (i === STEPS.indexOf('export')) {
                isCompleted = exportDone && !isActive;
            } else if (pendingProcessing) {
                isCompleted = false;
            } else {
                isCompleted = !isActive && i < completedIndex;
            }
            if (isCompleted) {
                el.classList.add('completed');
                if (circle) { circle.textContent = '\u2713'; }
            } else {
                if (circle) { circle.textContent = String(i + 1); }
            }
            if (isActive) {
                el.classList.add('active');
            }
        });
        var lines = ['upload', 'convert', 'pack'];
        lines.forEach(function (id) {
            var lineEl = document.getElementById('line-' + id);
            if (!lineEl) { return; }
            var lineIndex = STEPS.indexOf(id);
            // A connector line is green once the step it leads
            // to has been completed. e.g. upload->convert turns
            // green the moment all docs are converted
            // (completedIndex >= 2).
            // While new files are pending processing the
            // connector lines for convert + pack stay neutral:
            // the work for those steps is NOT yet complete until
            // the new files have been processed.
            var lineCompleted = !pendingProcessing && lineIndex < completedIndex;
            lineEl.classList.toggle('completed', lineCompleted);
            lineEl.classList.remove('filled', 'pending');
        });

        // The count mirrors the number of GREEN ticks (steps
        // the user has finished, excluding the active one).
        // The previous implementation used `completedIndex + 1`,
        // which added the active step itself and produced a
        // count that was always one too high (e.g. "2 of 4" on
        // a fresh Upload even before any document was added).
        // While new files are pending, Convert and Pack do not
        // contribute to the count (their ticks are suppressed
        // above) so the running total drops to match the visual.
        var count = 0;
        STEPS.forEach(function (id, i) {
            if (i === activeIndex) { return; }
            if (i === STEPS.indexOf('export')) {
                if (exportDone) { count++; }
            } else if (!pendingProcessing && i < completedIndex) {
                count++;
            }
        });
        // On the final step, swap the running "X of 4"
        // progress copy for an end-state message so the
        // user knows everything is done and the next move
        // is to download. The stepper visual stays the same
        // (3 green ticks + 1 active blue circle).
        var countEl = document.getElementById('workflow-count');
        if (countEl) {
            if (activeMode === 'export' && count >= 3) {
                countEl.textContent = 'All steps complete \u2014 ready to download';
            } else {
                countEl.textContent = (count) + ' of 4 steps complete';
            }
        }

        // Workflow header context
        var ctx = document.getElementById('smart-doc-header-context');
        if (ctx) {
            var ctxText = ({
                'upload': 'Upload Word, Excel or PowerPoint documents to assemble a Board Pack',
                'convert': 'Convert Office documents to PDF before merging',
                'pack': 'Add the Bookmark and Watermark to the Final Board Pack PDF',
                'export': 'Download and preview the final Board Pack deliverables'
            })[activeMode] || '';
            if (ctxText) { ctx.textContent = ctxText; }
        }

        // Refresh packet list (left panel)
        renderPacketList();
        // Render centre panel
        var centre = document.getElementById('centre-panel');
        if (!centre) { return; }
        centre.setAttribute('data-mode', activeMode);
        var renderer = ({
            'upload': renderUpload,
            'convert': renderConvert,
            'pack': renderPack,
            'export': renderExport
        })[activeMode] || renderUpload;
        try {
            renderer(centre);
        } catch (e) {
            centre.innerHTML = '<div class="bp-empty-state"><div class="bp-empty-state-icon">!</div>' +
                '<h3>We could not render this step</h3><p>' + escapeHtml(e.message || '') + '</p></div>';
        }
    }

    function completionIndex() {
        // Maps current progress to a "furthest completed step" index:
        //   0  Upload not done  (no docs uploaded)
        //   1  Upload done      (at least one doc uploaded, Convert accessible)
        //   2  Convert done     (ALL docs converted, Pack accessible)
        //   3  Pack done        (board pack PDF generated, Export accessible)
        //
        // BUG FIX: the previous implementation used some(converted) for
        // level-1 which is true even when ALL docs are converted, so the
        // allConverted branch (level 2) was never reachable.  The correct
        // order is: check allConverted first (most advanced), then fall
        // back to "any docs exist" (level 1).
        if (state.boardPackGenerated) { return 3; }
        if (!state.documents || state.documents.length === 0) { return 0; }
        var allConverted = state.documents.every(function (d) {
            return (d.status || '').toLowerCase() === 'converted';
        });
        if (allConverted) { return 2; }
        // At least one document uploaded but not all converted yet.
        return 1;
    }

    // Map a completionIndex() value to the deepest workflow
    // step the user has valid state for. Mirrors the Claim
    // Intake resumeMode() helper so that when the user
    // revisits the Upload step via the left-side stepper, the
    // primary CTA jumps them back to where they left off
    // instead of forcing them through Convert again.
    //   0 -> 'convert' (just got files, still need to convert)
    //   1 -> 'convert' (files uploaded, conversion incomplete)
    //   2 -> 'pack'    (all files converted, pack not run yet)
    //   3 -> 'export'  (board pack already generated)
    function resumeModeForBoardPack(completed) {
        if (completed >= 3) { return 'export'; }
        if (completed === 2) { return 'pack'; }
        return 'convert';
    }

    function renderPacketList() {
        var list = document.getElementById('packetPanelList');
        if (!list) { return; }
        if (!state.documents || state.documents.length === 0) {
            list.innerHTML = '<div class="packet-panel-empty">Upload Word, Excel or PowerPoint documents to start.</div>';
            return;
        }
        // The Preview button is only useful once a converted PDF
        // actually exists. Hide it on the Upload and Convert steps
        // so the side rail mirrors the Claim-Intake pattern where
        // pre-render affordances are surfaced only when they are
        // meaningful. On Pack / Export every document already has
        // a converted PDF, so Preview comes back.
        var activeMode = (state.activeMode || 'upload').toLowerCase();
        var showPreview = activeMode === 'pack' || activeMode === 'export';
        var rows = state.documents
            .slice()
            .sort(function (a, b) { return (a.mergeOrder || 0) - (b.mergeOrder || 0); })
            .map(function (doc, i) {
                var status = (doc.status || 'Waiting').toLowerCase();
                var kindClass = ({
                    Word: 'bp-packet-row-thumb--word',
                    Excel: 'bp-packet-row-thumb--excel',
                    PowerPoint: 'bp-packet-row-thumb--ppt'
                })[doc.fileType] || '';
                var typeLabel = ({
                    Word: 'Word',
                    Excel: 'Excel',
                    PowerPoint: 'PPT'
                })[doc.fileType] || 'DOC';
                // Preview button uses the same `data-pdf-preview-url` /
                // `data-pdf-preview-title` pattern as the Claim Intake
                // package step so the delegated document-level handler
                // can open the modal without a per-button click
                // binding. Using `secondary-btn` keeps the look in sync
                // with the claim-intake preview buttons.
                var previewButton = (showPreview && doc.convertedPreviewUrl)
                    ? '    <button type="button" class="secondary-btn bp-packet-row-preview" data-pdf-preview-url="' + escapeHtml(doc.convertedPreviewUrl) + '" data-pdf-preview-title="' + escapeHtml(doc.fileName || 'Preview') + '" title="Preview converted PDF">Preview</button>'
                    : '';
                var actionsClass = showPreview
                    ? 'bp-row-actions'
                    : 'bp-row-actions bp-row-actions--minimal';
                return '' +
                    '<div class="packet-panel-item bp-packet-row is-' + status + '" role="listitem" data-doc-id="' + doc.id + '">' +
                    '  <div class="packet-panel-item-icon bp-packet-row-thumb ' + kindClass + '" aria-hidden="true">' +
                    '    <span class="packet-panel-item-glyph">' + typeLabel + '</span>' +
                    '  </div>' +
                    '  <div class="packet-panel-item-body bp-packet-row-meta">' +
                    '    <div class="packet-panel-item-name bp-packet-row-name" title="' + escapeHtml(doc.fileName) + '">' + escapeHtml(doc.fileName) + '</div>' +
                    '  </div>' +
                    '  <div class="' + actionsClass + '">' +
                         previewButton +
                    '    <button type="button" class="bp-packet-row-remove" data-action="remove" data-doc-id="' + doc.id + '" aria-label="Remove from packet" title="Remove from packet">' +
                    '      <svg class="bp-packet-row-remove-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
                    '        <path d="M5 5.5v6m3-6v6m3-6v6M3 4h10M6 4V2.5h4V4m-6.5 0 .6 9.5h7.8L12.5 4" />' +
                    '      </svg>' +
                    '    </button>' +
                    '  </div>' +
                    '</div>';
            }).join('');
        list.innerHTML = rows;
    }

    // -- views -----------------------------------------------------------------

    function renderUpload(centre) {
        // Upload view mirrors the Claim Intake "Choose" view:
        //   * .center-header     -> demo title + landing intro
        //   * .choose-panel      -> vertical stack of
        //       - .choose-scenario-panel ("SCENARIO OBJECTIVE"
        //         + headline + body + the primary CTA), and
        //       - .packet-contents-panel (the scrollable
        //         packet table)
        // The shared layout classes (.center-header,
        // .choose-panel, .choose-scenario-panel,
        // .packet-contents-panel, .packet-contents-table,
        // .primary-btn, .section-title, .landing-intro) are
        // defined by claim-intake.css, which the Board Pack
        // page now loads first. board-pack.css adds the
        // `bp-packet-state-badge--*` variants that map the
        // Office conversion status onto the same badge shape
        // used by the Claim Intake "OCR required" / "Searchable"
        // states.
        var docs = state.documents || [];
        var hasDoc = docs.length > 0;
        var canContinue = hasDoc;

        //Show "Continue where you left off" and navigate to the furthest completed step when no new files are added; if new files are added after reaching Export, 
        //show "Process the Selected Files" and return to Convert so only the newly added or failed documents are processed while preserving existing converted files.
        // hasNewPendingFiles is the canonical signal for "new
        // files are waiting". We use it (rather than just
        // hasUnconverted) so the label flips back to "Continue
        // where you left off" once the new files have been
        // processed - the resume mode reverts to the deepest
        // valid step the user had already finished.
        var completed = completionIndex();
        var hasUnconverted = docs.some(function (d) {
            var s = (d.status || '').toLowerCase();
            return s === 'waiting' || s === 'failed';
        });
        var resumeStep = resumeModeForBoardPack(completed);
        // Force the user back through Convert when new or failed documents are present after the Board Pack has already been generated, otherwise the new files would be
        // silently skipped and the packet contents would not match the previously generated deliverables.
        if ((state.hasNewPendingFiles || hasUnconverted) && resumeStep !== 'convert') {
            resumeStep = 'convert';
        }
        // When the Board Pack has been generated but the user
        // has changed a Pack-side setting since then, Export
        // is no longer trustworthy - the deliverables are
        // stale. The "Continue where you left off" CTA must
        // drop the user back on Pack (not Export) so they can
        // rebuild the deck. Without this, clicking the CTA
        // would route to Export and trigger the packDirty
        // guard in setMode(), which is the wrong user
        // experience - they asked to resume, not jump to a
        // blocked step.
        if (state.packDirty && resumeStep === 'export') {
            resumeStep = 'pack';
        }
        // "Process the selected files" is the label whenever the
        // user is being asked to drive the workflow forward from
        // a Convert-style intermediate state. That includes both
        // the existing hasUnconverted case (fresh upload that
        // never made it to Pack) and the new
        // hasNewPendingFiles case (Board Pack was already built
        // and the user just added more files).
        var isResume = !state.hasNewPendingFiles && !hasUnconverted && resumeStep !== 'convert';
        var continueLabel = isResume
            ? 'Continue where you left off'
            : 'Process Board Pack Documents';
        var continueHref = '?mode=' + resumeStep;
        var hint;
        if (!hasDoc) {
            hint = 'Use "Add files" in the side panel to upload Word, Excel or PowerPoint documents. The button stays disabled until at least one file is in the packet.';
        } else if (state.hasNewPendingFiles) {
            hint = 'New files were added after the Board Pack was generated. The button will process only the newly added documents and keep the existing converted PDFs in place.';
        } else if (hasUnconverted) {
            hint = 'The files listed below are waiting to be converted. Clicking this button will process only those documents.';
        } else {
            hint = 'Continue when you have finished assembling the packet, or keep adding files from the side panel.';
        }

        var rowsHtml = renderPacketContentsRows(docs);

        centre.innerHTML = ''
            + '<div class="bp-upload-header">'
            +   '<div class="bp-upload-file-flow" aria-hidden="true">'
            +     '<svg class="bp-upload-file-art" width="260" height="120" viewBox="0 0 260 120" fill="none" focusable="false">'
            +       '<g transform="rotate(-7 27 31)"><rect x="10" y="10" width="34" height="42" rx="4" stroke="#2563EB" stroke-width="2"/><path d="M32 10V18H44" stroke="#2563EB" stroke-width="2"/><rect x="4" y="22" width="21" height="19" rx="4" fill="#2563EB"/><text x="14.5" y="36" font-size="13" font-weight="bold" text-anchor="middle" fill="white">W</text></g>'
            +       '<g><rect x="75" y="10" width="34" height="42" rx="4" stroke="#22C55E" stroke-width="2"/><path d="M97 10V18H109" stroke="#22C55E" stroke-width="2"/><rect x="69" y="22" width="21" height="19" rx="4" fill="#22C55E"/><text x="79.5" y="36" font-size="13" font-weight="bold" text-anchor="middle" fill="white">X</text></g>'
            +       '<g><rect x="42" y="65" width="34" height="42" rx="4" stroke="#F97316" stroke-width="2"/><path d="M64 65V73H76" stroke="#F97316" stroke-width="2"/><rect x="36" y="77" width="27" height="19" rx="4" fill="#F97316"/><text x="49.5" y="90.5" font-size="9" font-family="Arial" font-weight="bold" text-anchor="middle" fill="white">PPT</text></g>'
            +       '<line x1="126" y1="68" x2="168" y2="68" stroke="#2563EB" stroke-width="3" stroke-linecap="round"/><path d="M158 59L170 68L158 77" stroke="#2563EB" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
            +       '<g transform="translate(-31 -15) scale(1.15)"><rect x="190" y="47" width="34" height="42" rx="4" stroke="#EF4444" stroke-width="2"/><path d="M212 47V55H224" stroke="#EF4444" stroke-width="2"/><rect x="184" y="59" width="27" height="19" rx="4" fill="#EF4444"/><text x="197.5" y="72.5" font-size="8" font-family="Arial" font-weight="bold" text-anchor="middle" fill="white">PDF</text></g>'
            +     '</svg>'
            +   '</div>'
            +   '<div class="bp-upload-header-copy">'
            +     '<h1>Ready to create your Board Pack</h1>'
            +     '<p>Convert and merge your documents into one PDF.</p>'
            +     '<button id="bpContinueConvert" type="button" class="primary-btn bp-upload-cta"'
            +            (canContinue ? '' : ' disabled aria-disabled="true"')
            +            ' data-href="' + escapeHtml(continueHref) + '">'
            +       escapeHtml(continueLabel) + ' <span aria-hidden="true">&#8594;</span>'
            +     '</button>'
            +     '<span class="bp-upload-hint">' + escapeHtml(hint) + '</span>'
            +   '</div>'
            + '</div>'
            + '<div class="bp-upload-contents packet-contents-panel">'
            +   '<div class="packet-contents-title">Packet contents</div>'
            +   '<div class="packet-contents-scroll">'
            +     '<table class="packet-contents-table">'
            +       '<thead><tr><th>FILE NAME</th><th>TYPE</th><th>SIZE</th><th>STATUS</th></tr></thead>'
            +       '<tbody id="bpPacketContentsTableBody">' + rowsHtml + '</tbody>'
            +     '</table>'
            +   '</div>'
            + '</div>';

        var cont = document.getElementById('bpContinueConvert');
        if (cont) {
            cont.addEventListener('click', function () {
                if (!canContinue) { return; }
                setMode(resumeStep);
                if (resumeStep === 'convert') {
                    setTimeout(function () {
                        window.boardPack.convertAll().catch(function (err) {
                            alert(err.message || 'One or more documents failed to convert.');
                        });
                    }, 0);
                }
            });
        }
    }

    function renderUploadLegacy(centre) {
        centre.innerHTML = ''
            + '<div class="choose-panel">'
            +   '<section class="choose-scenario-panel">'
            +     '<div class="section-title section-title--eyebrow section-title--eyebrow-scenario">'
            +       '<span class="section-title-eyebrow-icon" aria-hidden="true">'
            +         '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
            +           '<circle cx="8" cy="8" r="5.25"/>'
            +           '<circle cx="8" cy="8" r="2"/>'
            +           '<path d="M8 0.75v1.5M8 13.75v1.5M0.75 8h1.5M13.75 8h1.5"/>'
            +         '</svg>'
            +       '</span>'
            +       '<span>SCENARIO OBJECTIVE</span>'
            +     '</div>'
            +     '<h1>Turn the uploaded Office documents into a single, bookmarked Board Pack PDF.</h1>'
            +     '<p class="choose-scenario-body">'
            +       'Select Word, Excel and PowerPoint files from the packet on the left to begin the workflow. Each document is converted to a faithful PDF with Syncfusion\'s Office renderer, then assembled in the order you choose. Watermarks, bookmarks and password protection can be applied during the Pack step before the final Board Pack is generated.'
            +     '</p>'
            +     '<div class="choose-scenario-cta">'
            +       '<button id="bpContinueConvert" type="button" class="primary-btn choose-scenario-cta-btn"'
            +              (canContinue ? '' : ' disabled aria-disabled="true"')
            +              ' data-href="' + escapeHtml(continueHref) + '">'
            +         escapeHtml(continueLabel)
            +       '</button>'
            +       '<span class="choose-scenario-hint">'
            +         escapeHtml(hint)
            +       '</span>'
            +     '</div>'
            +   '</section>'
            +   '<div class="packet-contents-panel">'
            +     '<div class="packet-contents-title">Packet contents</div>'
            +     '<div class="packet-contents-scroll">'
            +       '<table class="packet-contents-table">'
            +         '<thead>'
            +           '<tr>'
            +             '<th>FILE NAME</th>'
            +             '<th>TYPE</th>'
            +             '<th>SIZE</th>'
            +             '<th>STATUS</th>'
            +           '</tr>'
            +         '</thead>'
            +         '<tbody id="bpPacketContentsTableBody">'
            +           rowsHtml
            +         '</tbody>'
            +       '</table>'
            +     '</div>'
            +   '</div>'
            + '</div>';

        var cont = document.getElementById('bpContinueConvert');
        if (cont) {
            cont.addEventListener('click', function () {
                if (!canContinue) { return; }
                // Advance to the deepest step the user has valid
                // state for, honoring the same resume pattern as
                // Claim Intake. Only auto-kick conversion when we
                // are actually resuming into the Convert step -
                // otherwise we would unnecessarily re-convert
                // files that have already been processed.
                setMode(resumeStep);
                if (resumeStep === 'convert') {
                    setTimeout(function () {
                        window.boardPack.convertAll().catch(function (err) {
                            alert(err.message || 'One or more documents failed to convert.');
                        });
                    }, 0);
                }
            });
        }
    }

    // Renders the rows of the "Packet contents" table for the
    // Upload view. Mirrors claimIntake.js
    // renderPacketContentsRows in the same shape as the table
    // header (FILE / TYPE / SIZE / STATE).
    function renderPacketContentsRows(documents) {
        if (!documents || documents.length === 0) {
            return '<tr><td colspan="5">No files in the packet yet. Use "Add files" in the side panel to upload Word, Excel or PowerPoint documents.</td></tr>';
        }
        var html = '';
        for (var i = 0; i < documents.length; i++) {
            var d = documents[i];
            var typeLabel = d.fileType || 'File';
            var size = d.fileSize > 0 ? formatBytes(d.fileSize) : '\u2014';
            html += ''
                + '<tr>'
                +   '<td>' + escapeHtml(d.fileName || '') + '</td>'
                +   '<td>' + escapeHtml(typeLabel) + '</td>'
                +   '<td>' + escapeHtml(size) + '</td>'
                +   '<td>' + renderStateBadgeHtml(d.status) + '</td>'
                + '</tr>';
        }
        return html;
    }

    // Board Pack status -> badge label + CSS variant. Mirrors
    // claimIntake.js getStateBadgeHtml() in shape but maps to
    // the BOARD-PACK-SPECIFIC conversion statuses set by
    // BoardPackOfficeConverter:
    //   Waiting     -> Waiting        (grey)
    //   Converting  -> Converting     (blue)
    //   Converted   -> Converted      (green)
    //   Failed      -> Failed         (red)
    function renderStateBadgeHtml(status) {
        var s = (status || 'Waiting').toString().toLowerCase();
        var label, variant;
        if (s === 'converted') { label = 'Converted'; variant = 'converted'; }
        else if (s === 'converting') { label = 'Converting'; variant = 'converting'; }
        else if (s === 'failed') { label = 'Failed'; variant = 'failed'; }
        else { label = 'Waiting'; variant = 'waiting'; }
        return '<span class="bp-packet-state-badge bp-packet-state-badge--' + variant + '">' + escapeHtml(label) + '</span>';
    }

    function renderConvert(centre) {
        var docs = state.documents || [];
        var allConverted = docs.length > 0 && docs.every(function (d) {
            return (d.status || '').toLowerCase() === 'converted';
        });
        var hasWaiting = docs.some(function (d) {
            var s = (d.status || '').toLowerCase();
            return s === 'waiting' || s === 'failed';
        });
        var isConverting = docs.some(function (d) {
            return (d.status || '').toLowerCase() === 'converting';
        });
        var hasFailures = docs.some(function (d) {
            return (d.status || '').toLowerCase() === 'failed';
        });

        // Per the new flow, the Convert step no longer exposes a
        // "Convert all" button - clicking "Continue" in the Upload
        // step kicks off conversion automatically, and the user only
        // needs this toolbar's "Continue to Pack" button to advance
        // once every document is Converted. The button is pinned to
        // the right corner of the toolbar (.bp-centre-toolbar uses
        // justify-content: space-between, so the toolbar title block
        // lives on the left and the single CTA on the right).
        var header = '<div class="bp-centre-toolbar">' +
            '<div><h2>Convert Office documents to PDF</h2>' +
            '<p class="bp-centre-toolbar-sub">' +
                    'Each document is run through the matching Syncfusion renderer: DocIO for Word, XlsIO for Excel, and Presentation for PowerPoint. The Pack step is enabled when every document shows as Converted.' +
                '</p></div>' +
            '<div class="bp-action-row">' +
                '<button type="button" class="bp-cta-primary" id="bpContinuePack"' + (!allConverted || isConverting ? ' disabled' : '') + '>Continue to Pack &rarr;</button>' +
            '</div>' +
            '</div>';

        centre.innerHTML = header + '<div class="bp-convert-grid">' + docs.map(function (doc) {
            var status = (doc.status || 'Waiting').toLowerCase();
            // Progress bar: 0% waiting, animating 40% converting, 100% converted, 0% failed (red bar shown via CSS)
            var pct = status === 'converted' ? 100 : (status === 'converting' ? 45 : 0);
            var iconClass = ({
                Word: 'bp-convert-card-icon--word',
                Excel: 'bp-convert-card-icon--excel',
                PowerPoint: 'bp-convert-card-icon--ppt'
            })[doc.fileType] || '';
            // Icon badge label: render the friendly file-type name
            // (Word / Excel / PPT) instead of the 3-letter
            // abbreviation so the badge reads naturally. Anything
            // outside the known set falls back to a 3-letter
            // uppercase abbreviation of the source type.
            var labelMap = {
                Word: 'Word',
                Excel: 'Excel',
                PowerPoint: 'PPT'
            };
            var badgeLabel = labelMap[doc.fileType]
                || (doc.fileType ? doc.fileType.substring(0, 3).toUpperCase() : 'DOC');
            var pagesLabel = (status === 'converted' && doc.convertedPageCount > 0)
                ? escapeHtml(String(doc.convertedPageCount)) + ' page' + (doc.convertedPageCount === 1 ? '' : 's')
                : '&nbsp;';
            var errorBlock = (status === 'failed' && doc.errorMessage)
                ? '<div class="bp-error-callout">' + escapeHtml(doc.errorMessage) + '</div>'
                : '';
            var progressClass = 'bp-convert-card-progress-fill' + (status === 'converting' ? ' is-animating' : '') + (status === 'failed' ? ' is-failed' : '');
            var progressPct = status === 'failed' ? 100 : pct;
            // Per-card Preview button. Only meaningful once a converted
            // PDF actually exists; before that, the button is rendered
            // disabled so the card layout is stable. The
            // `data-pdf-preview-url` / `data-pdf-preview-title` markers
            // are the SAME pattern the Export page's "Preview PDF" cards
            // use, so the delegated document-level click handler in
            // wirePdfPreviewModalClose() opens the modal without any
            // extra wiring here.
            var previewUrl = doc.convertedPreviewUrl || '';
            var previewDisabled = !previewUrl;
            var previewButton = '<div class="bp-convert-card-preview-wrap">' +
                '<button type="button" class="secondary-btn bp-convert-card-preview" ' +
                'data-pdf-preview-url="' + escapeHtml(previewUrl) + '" ' +
                'data-pdf-preview-title="' + escapeHtml(doc.fileName || 'Preview') + '" ' +
                (previewDisabled ? 'disabled aria-disabled="true"' : '') +
                ' title="' + (previewDisabled ? 'Preview is available once conversion completes.' : 'Preview converted PDF') + '">' +
                'Preview' +
                '</button>' +
                '</div>';
            return '<div class="bp-convert-card is-' + status + '" data-doc-id="' + doc.id + '">' +
                '<div class="bp-convert-card-head">' +
                '  <div class="bp-convert-card-icon ' + iconClass + '">' + escapeHtml(badgeLabel) + '</div>' +
                '  <div class="bp-convert-card-meta">' +
                '    <div class="bp-convert-card-name" title="' + escapeHtml(doc.fileName) + '">' + escapeHtml(doc.fileName) + '</div>' +
                '    <div class="bp-convert-card-type">' + escapeHtml(doc.fileType || '') + ' &rarr; PDF</div>' +
                '  </div>' +
                '  <div class="bp-convert-card-badge bp-status-' + status + '">' + escapeHtml(doc.status || 'Waiting') + '</div>' +
                '</div>' +
                '<div class="bp-convert-card-progress"><div class="' + progressClass + '" style="width:' + progressPct + '%"></div></div>' +
                '<div class="bp-convert-card-footer">' +
                '  <span>' + pagesLabel + '</span>' +
                '</div>' +
                previewButton +
                errorBlock +
                '</div>';
        }).join('') + '</div>';

        // Wire up buttons (fresh references after innerHTML replacement)
        var contPackBtn = document.getElementById('bpContinuePack');
        if (contPackBtn) {
            contPackBtn.addEventListener('click', function () {
                if (contPackBtn.disabled) { return; }
                pulseButton(contPackBtn);
                setTimeout(function () { setMode('pack'); }, 350);
            });
        }

        // No bpConvertAll button is rendered any more - the Convert
        // step is entered with conversion already in progress
        // (kicked off by the Upload step's Continue button). The
        // per-card Preview button uses the same
        // `data-pdf-preview-url` delegated handler as the Export
        // page, so no per-button click wiring is required here.

        var retryBtn = document.getElementById('bpRetryFailed');
        if (retryBtn) {
            retryBtn.addEventListener('click', function () {
                if (retryBtn.disabled) { return; }
                retryBtn.disabled = true;
                window.boardPack.convertAll()
                    .catch(function (err) {
                        alert(err.message || 'Retry failed.');
                    });
            });
        }
    }

    function renderPack(centre) {
        var docs = (state.documents || []).filter(function (d) { return (d.status || '').toLowerCase() === 'converted'; });
        docs.sort(function (a, b) { return (a.mergeOrder || 0) - (b.mergeOrder || 0); });

        var typeMeta = {
            Word:      { label: 'Word',      className: 'bp-doc-icon--word',  badge: 'DOC' },
            Excel:     { label: 'Excel',     className: 'bp-doc-icon--excel', badge: 'XLS' },
            PowerPoint:{ label: 'PowerPoint',className: 'bp-doc-icon--ppt',   badge: 'PPT' }
        };

        // The Build button is disabled when a Board Pack has
        // already been generated AND the user has not changed
        // any Pack-side setting since then. The packet is in
        // sync with the last Pack run, so re-running Build
        // would produce the exact same PDF/ZIP/manifest the
        // user already has access to on the Export step.
        // Changing any Pack-side setting flips packDirty back
        // to true (see markPackDirty) and re-enables the
        // button so the user can rebuild the deck.
        var exportCurrent = isExportCurrent();
        var runPackAttrs = exportCurrent
            ? ' disabled aria-disabled="true" title="Board Pack is up to date. Change a Pack setting to rebuild."'
            : ' title="Build the Board Pack PDF, source ZIP and audit manifest"';
        var runPackLabel = 'Export';

        var header = '<div class="bp-centre-toolbar">' +
            '<div class="bp-centre-toolbar-main">' +
                '<h2>Add Bookmark and Watermark</h2>' +
                '<p class="bp-centre-toolbar-sub">Configure the global settings, then drag the sections into the order you want. Each section gets its own PDF bookmark before the deck is merged.</p>' +
            '</div>' +
            '<div class="bp-action-row">' +
                '<span class="bp-toolbar-stat"><span class="bp-toolbar-stat-value">' + docs.length + '</span><span class="bp-toolbar-stat-label">section' + (docs.length === 1 ? '' : 's') + '</span></span>' +
                '<button type="button" class="bp-cta-primary is-success' + (exportCurrent ? ' is-current' : '') + '" id="bpRunPack"' + runPackAttrs + '>' + runPackLabel + '</button>' +
            '</div>' +
            '</div>' +
            // When the previously exported Board Pack is still in
            // sync, surface an info banner so the user knows WHY
            // the Build button is disabled instead of wondering
            // whether the demo is broken. The banner disappears as
            // soon as a Pack-side change flips packDirty back to
            // true. The banner sits OUTSIDE the toolbar so the
            // disabled button keeps its own column width and the
            // banner can span the full centre-panel width.
            (exportCurrent
                ? '<div class="bp-export-current-banner" role="status">' +
                    '<span class="bp-export-current-banner-glyph" aria-hidden="true">&#x2713;</span>' +
                    '<span class="bp-export-current-banner-text">Board Pack is up to date. The current PDF, source ZIP and audit manifest are available on the Export step. Change a Pack setting to rebuild the deck.</span>' +
                  '</div>'
                : '');

        var reorderRows = docs.map(function (doc, i) {
            var meta = typeMeta[doc.fileType] || { label: doc.fileType || 'File', className: 'bp-doc-icon--generic', badge: 'DOC' };
            var pagesLabel = (doc.convertedPageCount || 0) + ' page' + ((doc.convertedPageCount || 0) === 1 ? '' : 's');
            return '<div class="bp-reorder-row" draggable="true" data-doc-id="' + doc.id + '" data-index="' + i + '">' +
                '<button type="button" class="bp-reorder-row-handle" aria-label="Drag to reorder" title="Drag to reorder">' +
                    '<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="7" cy="5" r="1.4"/><circle cx="13" cy="5" r="1.4"/><circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/><circle cx="7" cy="15" r="1.4"/><circle cx="13" cy="15" r="1.4"/></svg>' +
                '</button>' +
                '<div class="bp-doc-icon ' + meta.className + '" aria-hidden="true">' + meta.badge + '</div>' +
                '<div class="bp-reorder-row-meta">' +
                    '<div class="bp-reorder-row-name" title="' + escapeHtml(doc.fileName) + '">' + escapeHtml(doc.fileName) + '</div>' +
                    '<div class="bp-reorder-row-sub"><span>' + escapeHtml(meta.label) + '</span><span class="bp-reorder-row-divider" aria-hidden="true"></span><span>' + pagesLabel + '</span></div>' +
                '</div>' +
                '<div class="bp-reorder-row-index" aria-label="Section ' + (i + 1) + '">' + (i + 1) + '</div>' +
                '</div>';
        }).join('');

        var bookmarkList = docs.map(function (doc, i) {
            var meta = typeMeta[doc.fileType] || { label: doc.fileType || 'File', className: 'bp-doc-icon--generic', badge: 'DOC' };
            return '<div class="bp-bookmark-row">' +
                '<span class="bp-bookmark-row-index" aria-label="Section ' + (i + 1) + '">' + (i + 1) + '</span>' +
                '<div class="bp-doc-icon ' + meta.className + '" aria-hidden="true">' + meta.badge + '</div>' +
                '<div class="bp-bookmark-row-meta">' +
                    '<div class="bp-bookmark-row-name" title="' + escapeHtml(doc.fileName) + '">' + escapeHtml(doc.fileName) + '</div>' +
                    '<div class="bp-bookmark-row-sub">' + escapeHtml(meta.label) + ' bookmark</div>' +
                '</div>' +
                '<input type="text" class="bp-bookmark-input" data-doc-id="' + doc.id + '" value="' + escapeHtml(doc.bookmarkTitle || doc.fileName) + '" maxlength="80" placeholder="Bookmark title" />' +
                '</div>';
        }).join('');

        // Single packet-wide watermark editor. Previously this
        // surface rendered one row per document (N toggles, N
        // text inputs, N colour pickers) which forced the user
        // to repeat the same change N times. The new editor
        // exposes ONE toggle, ONE text input (default
        // "Confidential") and ONE colour picker; the watermark
        // is then applied to every page of the merged PDF by
        // BoardPackGenerator.ApplyCommonWatermark.
        var wm = state.commonWatermark || { enabled: false, text: 'Confidential', color: '#1d4ed8' };
        // `disabled` keeps the text + colour inputs from being
        // focusable / editable while the watermark toggle is off.
        // The card's `is-on` class hides the whole controls
        // block (see board-pack.css), so the disabled attribute
        // is the belt-and-braces guard for keyboard users.
        var wmControlsAttrs = wm.enabled ? '' : ' disabled aria-disabled="true"';
        var watermarkCard = '<div class="bp-watermark-card ' + (wm.enabled ? 'is-on' : '') + '" id="bpWatermarkCard">' +
            '<div class="bp-watermark-heading">' +
                '<div class="bp-watermark-heading-text">' +
                    '<h4>Watermark</h4>' +
                    '<p class="bp-watermark-heading-sub">Draw a single watermark on every page of the merged PDF.</p>' +
                '</div>' +
                '<button type="button" class="bp-toggle ' + (wm.enabled ? 'is-on' : '') + '" id="bpWatermarkToggle" aria-label="Toggle watermark for the final Board Pack" aria-pressed="' + (!!wm.enabled) + '"></button>' +
            '</div>' +
            '<div class="bp-watermark-controls">' +
                '<div class="bp-watermark-field">' +
                    '<label for="bpWatermarkText" class="bp-watermark-field-label">Watermark text</label>' +
                    '<input type="text" class="bp-watermark-text" id="bpWatermarkText" value="' + escapeHtml(wm.text || 'Confidential') + '" placeholder="Confidential" maxlength="80"' + wmControlsAttrs + ' />' +
                '</div>' +
                '<div class="bp-watermark-field bp-watermark-field--narrow">' +
                    '<label for="bpWatermarkColor" class="bp-watermark-field-label">Colour</label>' +
                    '<label class="bp-watermark-color-label" title="Watermark colour">' +
                        '<span class="bp-watermark-color-swatch" style="background:' + escapeHtml(wm.color || '#1d4ed8') + '"></span>' +
                        '<span class="bp-watermark-color-icon" aria-hidden="true">' +
                            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                                '<path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.6-3.2l-.4-.4a2 2 0 0 1 1.4-3.4H17a4 4 0 0 0 4-4 9 9 0 0 0-9-7Z"/>' +
                                '<circle cx="7.5" cy="11" r="1.2" fill="currentColor" stroke="none"/>' +
                                '<circle cx="11" cy="7" r="1.2" fill="currentColor" stroke="none"/>' +
                                '<circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/>' +
                            '</svg>' +
                        '</span>' +
                        '<span class="bp-watermark-color-hex">' + escapeHtml((wm.color || '#1d4ed8').toUpperCase()) + '</span>' +
                        '<input type="color" class="bp-watermark-color" id="bpWatermarkColor" value="' + escapeHtml(wm.color || '#1d4ed8') + '" aria-label="Watermark colour picker"' + wmControlsAttrs + ' />' +
                    '</label>' +
                '</div>' +
            '</div>' +
            // Mirror the password card: when the toggle is off,
            // surface a friendly info callout (instead of an
            // empty controls block) so the user understands the
            // watermark simply isn't applied. When the toggle is
            // on, render the editor instead.
            (wm.enabled
                ? ''
                : '<div class="bp-watermark-callout"><span class="bp-info-callout"><span class="bp-info-callout-glyph" aria-hidden="true">i</span><span>No watermark applied. Enable the toggle to draw a watermark on every page of the final PDF.</span></span></div>') +
            '</div>';

        var passwordCard = '<div class="bp-password-card ' + (state.passwordProtect ? 'is-on' : '') + '" id="bpPasswordCard">' +
            '<div class="bp-watermark-heading">' +
                '<div class="bp-watermark-heading-text">' +
                    '<h4>Password protection</h4>' +
                    '<p class="bp-watermark-heading-sub">Require a password to open the final PDF (AES-256).</p>' +
                '</div>' +
                '<button type="button" class="bp-toggle ' + (state.passwordProtect ? 'is-on' : '') + '" id="bpPasswordToggle" aria-label="Toggle password protection" aria-pressed="' + state.passwordProtect + '"></button>' +
            '</div>' +
            '<div class="bp-password-body">' +
            (state.passwordProtect
                ? '<div class="bp-password-fields">' +
                    '<label for="bpPasswordInput" class="bp-watermark-field-label">Password</label>' +
                    '<input type="password" id="bpPasswordInput" value="' + escapeHtml(state.password || '') + '" placeholder="Enter a password" autocomplete="new-password" />' +
                    (state.passwordFeedback ? '<p class="bp-password-feedback is-' + escapeHtml(state.passwordFeedbackType || 'info') + '" role="status">' + escapeHtml(state.passwordFeedback) + '</p>' : '') +
                    '</div>'
                : '<div class="bp-info-callout"><span class="bp-info-callout-glyph" aria-hidden="true">i</span><span>No password set. The final PDF will open without password.</span></div>') +
            '</div>' +
            '</div>';

        centre.innerHTML = header +
            '<section class="bp-section" aria-labelledby="bpSectionSettingsTitle">' +
                '<header class="bp-section-header">' +
                    '<div>' +
                        '<h3 class="bp-section-title" id="bpSectionSettingsTitle">' +
                            '<span class="bp-section-title-icon" aria-hidden="true">' +
                                '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
                                    '<path d="M3 4.5h10M3 8h10M3 11.5h10"/>' +
                                    '<circle cx="5" cy="4.5" r="1.4" fill="#1d4ed8" stroke="none"/>' +
                                    '<circle cx="11" cy="8" r="1.4" fill="#1d4ed8" stroke="none"/>' +
                                    '<circle cx="6" cy="11.5" r="1.4" fill="#1d4ed8" stroke="none"/>' +
                                '</svg>' +
                            '</span>' +
                            '<span>Document settings</span>' +
                        '</h3>' +
                    '</div>' +
                '</header>' +
                '<div class="bp-pack-options">' +
                    '<div class="bp-pack-options-col">' + passwordCard + '</div>' +
                    '<div class="bp-pack-options-col">' +
                        '<div class="bp-watermark-list">' + watermarkCard + '</div>' +
                    '</div>' +
                '</div>' +
            '</section>' +
            '<div class="bp-pack-twopane">' +
                '<section class="bp-section" aria-labelledby="bpSectionOrderTitle">' +
                    '<header class="bp-section-header">' +
                        '<div>' +
                            '<h3 class="bp-section-title" id="bpSectionOrderTitle">' +
                                '<span class="bp-section-title-icon" aria-hidden="true">' +
                                    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
                                        '<path d="M4 3h8M4 8h8M4 13h8"/>' +
                                        '<path d="M2.5 5.5 4 4l1.5 1.5"/>' +
                                        '<path d="M13.5 6.5 12 8l-1.5-1.5"/>' +
                                    '</svg>' +
                                '</span>' +
                                '<span>Merge order</span>' +
                            '</h3>' +
                            '<p class="bp-section-sub">Drag the handle on a row to reorder how the sections appear in the Board Pack.</p>' +
                        '</div>' +
                        '<span class="bp-section-pill">' + docs.length + ' section' + (docs.length === 1 ? '' : 's') + '</span>' +
                    '</header>' +
                    '<div class="bp-pack-panel">' +
                        (reorderRows
                            ? '<div class="bp-reorder-list" id="bpReorderList">' + reorderRows + '</div>'
                            : '<div class="bp-empty-state"><div class="bp-empty-state-icon">!</div>No converted documents. Return to the Convert step.</div>') +
                    '</div>' +
                '</section>' +
                '<section class="bp-section" aria-labelledby="bpSectionBookmarksTitle">' +
                    '<header class="bp-section-header">' +
                        '<div>' +
                            '<h3 class="bp-section-title" id="bpSectionBookmarksTitle">' +
                                '<span class="bp-section-title-icon" aria-hidden="true">' +
                                    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
                                        '<path d="M4 2.5h8a1 1 0 0 1 1 1V14l-5-3-5 3V3.5a1 1 0 0 1 1-1Z"/>' +
                                    '</svg>' +
                                '</span>' +
                                '<span>Bookmarks</span>' +
                            '</h3>' +
                            '<p class="bp-section-sub">Each section gets one PDF bookmark. Adjust the bookmark title as needed.</p>' +
                        '</div>' +
                        '<span class="bp-section-pill bp-section-pill--muted">Auto-mapped</span>' +
                    '</header>' +
                    '<div class="bp-pack-panel">' +
                        '<div class="bp-bookmark-editor">' +
                            (bookmarkList || '<div class="bp-empty-state"><div class="bp-empty-state-icon">!</div>Upload documents first.</div>') +
                        '</div>' +
                    '</div>' +
                '</section>' +
            '</div>';

        var reorderList = document.getElementById('bpReorderList');
        if (reorderList) { attachDragHandlers(reorderList, docs); }

        document.querySelectorAll('.bp-bookmark-input').forEach(function (input) {
            input.addEventListener('change', function () {
                var id = input.getAttribute('data-doc-id');
                var title = (input.value || '').trim();
                window.boardPack.updateBookmark(id, { title: title, autoBookmark: true })
                    .catch(function (err) { alert(err.message || 'Could not save bookmark.'); });
            });
        });

        document.querySelectorAll('[data-watermark-toggle]').forEach(function (button) {
            button.addEventListener('click', function () {
                var id = button.getAttribute('data-watermark-toggle');
                var enabled = !button.classList.contains('is-on');
                window.boardPack.updateWatermark(id, { enabled: enabled })
                    .catch(function (err) { alert(err.message || 'Could not update watermark.'); });
            });
        });
        // Single common watermark editor wiring. The toggle,
        // text input and colour picker all hit
        // /api/board-pack/watermark (no document id) so the
        // server stores the configuration on
        // BoardPackWorkspace.CommonWatermark and the generator
        // draws it on every page of the merged PDF.
        var wmToggle = document.getElementById('bpWatermarkToggle');
        if (wmToggle) {
            wmToggle.addEventListener('click', function () {
                var next = !wmToggle.classList.contains('is-on');
                // Optimistically flip the card's `is-on` state
                // and the disabled attribute on the text + colour
                // inputs so the controls hide (and become
                // uneditable) immediately, before the server round
                // trip completes. The subsequent render() from
                // refreshFromServer() will re-write the same state
                // from the authoritative server response.
                var card = document.getElementById('bpWatermarkCard');
                if (card) {
                    card.classList.toggle('is-on', next);
                }
                var wmTextEl = document.getElementById('bpWatermarkText');
                var wmColorEl = document.getElementById('bpWatermarkColor');
                if (next) {
                    if (wmTextEl) { wmTextEl.removeAttribute('disabled'); wmTextEl.removeAttribute('aria-disabled'); }
                    if (wmColorEl) { wmColorEl.removeAttribute('disabled'); wmColorEl.removeAttribute('aria-disabled'); }
                } else {
                    if (wmTextEl) { wmTextEl.setAttribute('disabled', 'disabled'); wmTextEl.setAttribute('aria-disabled', 'true'); }
                    if (wmColorEl) { wmColorEl.setAttribute('disabled', 'disabled'); wmColorEl.setAttribute('aria-disabled', 'true'); }
                }
                // Show / hide the "no watermark applied" info
                // callout that mirrors the password card's empty
                // state. The controls are hidden by the CSS rule
                // in board-pack.css (`.bp-watermark-card:not(.is-on)
                // .bp-watermark-controls { display: none; }`),
                // so we just need to toggle the callout.
                var callout = card ? card.querySelector('.bp-watermark-callout') : null;
                if (callout) { callout.style.display = next ? 'none' : ''; }
                window.boardPack.updateCommonWatermark({ enabled: next })
                    .catch(function (err) { alert(err.message || 'Could not update watermark.'); });
            });
        }
        var wmText = document.getElementById('bpWatermarkText');
        if (wmText) {
            wmText.addEventListener('change', function () {
                var text = (wmText.value || '').trim() || 'Confidential';
                window.boardPack.updateCommonWatermark({ text: text })
                    .catch(function (err) { alert(err.message || 'Could not update watermark text.'); });
            });
        }
        var wmColor = document.getElementById('bpWatermarkColor');
        if (wmColor) {
            wmColor.addEventListener('input', function () {
                // Mirror the picker value onto the swatch + hex
                // readout so the user sees the chosen colour
                // immediately as they drag through the spectrum.
                var swatch = document.querySelector('.bp-watermark-color-swatch');
                if (swatch) { swatch.style.background = wmColor.value; }
                var hex = document.querySelector('.bp-watermark-color-hex');
                if (hex) { hex.textContent = (wmColor.value || '').toUpperCase(); }
            });
            wmColor.addEventListener('change', function () {
                window.boardPack.updateCommonWatermark({ color: wmColor.value })
                    .catch(function (err) { alert(err.message || 'Could not update watermark colour.'); });
            });
        }

        var toggle = document.getElementById('bpPasswordToggle');
        if (toggle) {
            toggle.addEventListener('click', function () {
                var next = !toggle.classList.contains('is-on');
                window.boardPack.updateSecurity({ passwordProtect: next })
                    .catch(function (err) { alert(err.message || 'Could not update password settings.'); });
            });
        }
        var pw = document.getElementById('bpPasswordInput');
        function pushPasswordUpdate() {
            if (!pw) { return; }
            // The change listener is attached to the *current*
            // input element. Every render() replaces
            // centre.innerHTML, which detaches the old input from
            // the DOM. Browsers still fire `change` on the
            // detached element when the value was modified while
            // it had focus, so a single Enter press was triggering
            // the save TWICE (once from keydown, once from the
            // late change event) and a second save could race
            // with the first GET /workspace response. Bail out if
            // the input is no longer in the document so only the
            // new (re-attached) input can drive the next save.
            if (!document.body.contains(pw)) { return; }
            var password = (pw.value || '').trim();
            state.password = password;
            if (!password) {
                state.passwordFeedback = 'Enter a password to save it.';
                state.passwordFeedbackType = 'error';
                render();
                return;
            }
            state.passwordFeedback = 'Saving password...';
            state.passwordFeedbackType = 'info';
            render();
            window.boardPack.updateSecurity({
                passwordProtect: true,
                password: password
            }).then(function () {
                state.password = password;
                state.passwordFeedback = 'Password saved. The final PDF will be protected with this password.';
                state.passwordFeedbackType = 'success';
                render();
            }).catch(function (err) {
                state.passwordFeedback = err.message || 'Could not save password.';
                state.passwordFeedbackType = 'error';
                render();
            });
        }
        if (pw) { pw.addEventListener('change', pushPasswordUpdate); }
        function submitPasswordOnEnter(event) {
            if (event.key !== 'Enter') { return; }
            event.preventDefault();
            pushPasswordUpdate();
        }
        if (pw) { pw.addEventListener('keydown', submitPasswordOnEnter); }

        var runPack = document.getElementById('bpRunPack');
        if (runPack) {
            runPack.addEventListener('click', function () {
                if (runPack.disabled) { return; }
                pulseButton(runPack);
                // Pre-flight: if the password toggle is on but the
                // input is empty (or whitespace), the generator
                // would silently skip encryption. Block the click,
                // focus the input, and surface a feedback message
                // so the user knows exactly what to fix.
                if (state.passwordProtect) {
                    var pwInput = document.getElementById('bpPasswordInput');
                    var pwValue = pwInput ? (pwInput.value || '').trim() : (state.password || '');
                    if (!pwValue) {
                        state.passwordFeedback = 'Enter a password before building. The PDF cannot be protected with an empty password.';
                        state.passwordFeedbackType = 'error';
                        render();
                        if (pwInput) { pwInput.focus(); }
                        return;
                    }
                    // Flush the latest password to the server
                    // BEFORE running the generator so the saved
                    // snapshot - not the local state - is what
                    // /api/board-pack/pack reads. The change
                    // event on the input would normally do this
                    // but a user who only pressed Build (without
                    // tabbing out of the input) would skip the
                    // change event entirely.
                    runPack.setAttribute('disabled', 'disabled');
                    runPack.textContent = 'Saving…';
                    window.boardPack.updateSecurity({
                        passwordProtect: true,
                        password: pwValue
                    })
                    .then(function () { return window.boardPack.packNow(); })
                    .then(function () { setMode('export'); })
                    .catch(function (err) { alert(err.message || 'Pack failed.'); })
                    .then(function () {
                        runPack.removeAttribute('disabled');
                        // Restore the canonical "Export" label
                        // so the user does not see a stale
                        // "Saving…" / "Building…" string if they
                        // stay on the Pack view after a Pack run.
                        runPack.textContent = 'Export';
                    });
                    return;
                }
                runPack.setAttribute('disabled', 'disabled');
                runPack.textContent = 'Building…';
                window.boardPack.packNow()
                    .then(function () { setMode('export'); })
                    .catch(function (err) { alert(err.message || 'Pack failed.'); })
                    .then(function () {
                        runPack.removeAttribute('disabled');
                        // Restore the canonical "Export" label.
                        runPack.textContent = 'Export';
                    });
            });
        }
    }

    function attachDragHandlers(list, docs) {
        var dragId = null;
        var touchDrag = null;

        function clearDragState() {
            list.querySelectorAll('.bp-reorder-row').forEach(function (r) {
                r.classList.remove('dragging', 'drop-target-above', 'drop-target-below');
            });
            dragId = null;
            touchDrag = null;
        }

        function reorderToRow(row, clientY) {
            if (!dragId || !row) { return; }
            var rect = row.getBoundingClientRect();
            var above = (clientY - rect.top) < rect.height / 2;
            var ids = state.documents
                .slice()
                .sort(function (a, b) { return (a.mergeOrder || 0) - (b.mergeOrder || 0); })
                .map(function (d) { return d.id; });
            var targetId = row.getAttribute('data-doc-id');
            if (!targetId || !ids.length) { return; }
            var fromIdx = ids.indexOf(dragId);
            var toIdx = ids.indexOf(targetId);
            if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) { return; }
            ids.splice(fromIdx, 1);
            var adjust = above ? toIdx : toIdx + 1;
            var useIdx = fromIdx < adjust ? adjust - 1 : adjust;
            if (useIdx < 0) { useIdx = 0; }
            if (useIdx > ids.length) { useIdx = ids.length; }
            ids.splice(useIdx, 0, dragId);
            window.boardPack.reorderDocuments(ids);
        }

        list.querySelectorAll('.bp-reorder-row').forEach(function (row) {
            row.addEventListener('dragstart', function (e) {
                dragId = row.getAttribute('data-doc-id');
                row.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* */ }
            });
            row.addEventListener('dragend', function () {
                clearDragState();
            });
            row.addEventListener('dragover', function (e) {
                if (!dragId) { return; }
                e.preventDefault();
                var rect = row.getBoundingClientRect();
                var above = (e.clientY - rect.top) < rect.height / 2;
                row.classList.toggle('drop-target-above', above);
                row.classList.toggle('drop-target-below', !above);
            });
            row.addEventListener('dragleave', function () {
                row.classList.remove('drop-target-above', 'drop-target-below');
            });
            row.addEventListener('drop', function (e) {
                if (!dragId) { return; }
                e.preventDefault();
                reorderToRow(row, e.clientY);
            });

            var handle = row.querySelector('.bp-reorder-row-handle');
            if (handle) {
                handle.addEventListener('pointerdown', function (e) {
                    if (e.pointerType !== 'touch') { return; }
                    e.preventDefault();
                    dragId = row.getAttribute('data-doc-id');
                    touchDrag = { pointerId: e.pointerId };
                    row.classList.add('dragging');
                    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* pointer capture is best-effort */ }
                });
                handle.addEventListener('pointermove', function (e) {
                    if (!touchDrag || e.pointerId !== touchDrag.pointerId) { return; }
                    e.preventDefault();
                    var target = document.elementFromPoint(e.clientX, e.clientY);
                    var targetRow = target && target.closest('.bp-reorder-row');
                    list.querySelectorAll('.bp-reorder-row').forEach(function (r) {
                        r.classList.remove('drop-target-above', 'drop-target-below');
                    });
                    if (targetRow && list.contains(targetRow)) {
                        var targetRect = targetRow.getBoundingClientRect();
                        var targetAbove = (e.clientY - targetRect.top) < targetRect.height / 2;
                        targetRow.classList.toggle('drop-target-above', targetAbove);
                        targetRow.classList.toggle('drop-target-below', !targetAbove);
                    }
                });
                handle.addEventListener('pointerup', function (e) {
                    if (!touchDrag || e.pointerId !== touchDrag.pointerId) { return; }
                    e.preventDefault();
                    var target = document.elementFromPoint(e.clientX, e.clientY);
                    var targetRow = target && target.closest('.bp-reorder-row');
                    if (targetRow && list.contains(targetRow)) {
                        reorderToRow(targetRow, e.clientY);
                    }
                    clearDragState();
                });
                handle.addEventListener('pointercancel', clearDragState);
            }
        });
    }

    function renderExport(centre) {
        var totalPages = (state.documents || [])
            .filter(function (d) { return (d.status || '').toLowerCase() === 'converted'; })
            .reduce(function (sum, d) { return sum + (d.convertedPageCount || 0); }, 0);
        var summary = '<div class="bp-centre-toolbar">' +
            '<div><h2>Final Board Pack</h2>' +
                '<p class="bp-centre-toolbar-sub">Preview the merged PDF, download the original source docs, and review the audit manifest.</p></div>' +
            '</div>';

        centre.innerHTML = summary +
            '<div class="bp-export-summary">' +
                '<div class="bp-export-summary-cell"><div class="bp-export-summary-value">' + (state.documents || []).length + '</div><div class="bp-export-summary-label">Source documents</div></div>' +
                '<div class="bp-export-summary-cell"><div class="bp-export-summary-value">' + totalPages + '</div><div class="bp-export-summary-label">Total pages</div></div>' +
                '<div class="bp-export-summary-cell"><div class="bp-export-summary-value">' + ((state.passwordProtect) ? 'Enabled' : 'Disabled') + '</div><div class="bp-export-summary-label">Password</div></div>' +
            '</div>' +
            '<div class="bp-export-grid">' +
                '<div class="bp-export-cards">' +
                    '<div class="bp-export-card">' +
                        '  <div class="bp-export-card-head"><div class="bp-export-card-icon">PDF</div></div>' +
                        '  <div class="bp-export-card-title">Final Board Pack PDF</div>' +
                        '  <div class="bp-export-card-sub">Merged PDF with bookmarks and watermarks.</div>' +
                        '  <div class="bp-export-card-actions">' +
                        '    <button class="bp-cta-primary" id="bpDownloadPdfCard" ' + (state.boardPackGenerated ? '' : 'disabled') + '>Download</button>' +
                        '    <button type="button" class="secondary-btn bpPreviewPdfCard" data-pdf-preview-url="' + escapeHtml(state.boardPackPreviewUrl || '') + '" data-pdf-preview-title="Board Pack PDF" ' + (state.boardPackGenerated ? '' : 'disabled') + '>Preview</button>' +
                        '  </div>' +
                        '</div>' +
                    '<div class="bp-export-card">' +
                        '  <div class="bp-export-card-head"><div class="bp-export-card-icon is-zip">ZIP</div></div>' +
                        '  <div class="bp-export-card-title">Source Documents</div>' +
                        '  <div class="bp-export-card-sub">ZIP of the original Office uploads.</div>' +
                        '  <div class="bp-export-card-actions">' +
                        '    <button class="bp-cta-primary" id="bpDownloadZip" ' + (state.sourcesGenerated ? '' : 'disabled') + '>Download</button>' +
                        '  </div>' +
                        '</div>' +
                    '<div class="bp-export-card">' +
                        '  <div class="bp-export-card-head"><div class="bp-export-card-icon is-manifest">JSON</div></div>' +
                        '  <div class="bp-export-card-title">Audit Manifest</div>' +
                        '  <div class="bp-export-card-sub">Reviewed JSON of every artifact the run produced.</div>' +
                        '  <div class="bp-export-card-actions">' +
                        '    <button class="bp-cta-primary" id="bpDownloadManifest" ' + (state.manifestGenerated ? '' : 'disabled') + '>Download</button>' +
                        '    <button type="button" id="bpPreviewManifest" class="secondary-btn bpPreviewManifest" ' + (state.manifestGenerated ? '' : 'disabled') + '>Preview</button>' +
                        '  </div>' +
                        '</div>' +
                '</div>' +
            '</div>';

        // Wire Download buttons. The Preview buttons use the
        // claim-intake `data-pdf-preview-url` / `data-pdf-preview-title`
        // pattern so the delegated document-level click handler in
        // wirePdfPreviewModalClose() picks them up consistently with
        // the packet list previews on the Pack step.
        var pairs = [
            ['bpDownloadPdf', 'board-pack'],
            ['bpDownloadPdfCard', 'board-pack']
        ];
        pairs.forEach(function (pair) {
            var downloadId = pair[0];
            var kind = pair[1];
            var dl = document.getElementById(downloadId);
            if (dl && kind) {
                dl.addEventListener('click', function () {
                    if (dl.disabled) { return; }
                    pulseButton(dl);
                    downloadBoardPack(kind);
                });
            }
        });
        var dlZip = document.getElementById('bpDownloadZip');
        if (dlZip) {
            dlZip.addEventListener('click', function () {
                if (dlZip.disabled) { return; }
                pulseButton(dlZip);
                downloadBoardPack('source-zip');
            });
        }
        var downloadManifest = document.getElementById('bpDownloadManifest');
        if (downloadManifest) {
            downloadManifest.addEventListener('click', function () {
                if (downloadManifest.disabled) { return; }
                pulseButton(downloadManifest);
                downloadBoardPack('manifest');
            });
        }
        var previewManifest = document.getElementById('bpPreviewManifest');
        if (previewManifest) {
            previewManifest.addEventListener('click', function () {
                window.boardPack.openManifestPreview()
                    .catch(function (err) { alert(err.message || 'Could not load manifest.'); });
            });
        }
    }

    // -- PDF preview modal -----------------------------------------------------
    // Mirrors the package-step preview in claimIntake.js. The previous
    // version used `window.ej.pdfviewer.PdfViewer.Inject(host, {...})`,
    // which is not a valid Syncfusion EJ2 API and silently failed (the
    // modal opened, but the host stayed empty so the file never rendered).
    // The claim-intake package step uses `new PdfViewer({...}).appendTo(host)`
    // with a tracked viewer so re-opens destroy the previous instance and
    // Escape + backdrop close both work.
    var currentPreviewViewer = null;
    function openPdfPreview(url, options) {
        if (!url) { return; }
        var opts = options || {};
        var modal = document.getElementById('pdfPreviewModal');
        var host = document.getElementById('pdfPreviewHost');
        var titleEl = document.getElementById('pdfPreviewTitle');
        if (!modal || !host) { return; }
        if (titleEl) { titleEl.textContent = 'Preview'; }
        // Open first so the host has a measurable size - the EJ2 viewer
        // reads the host's clientWidth / clientHeight when it appends;
        // mounting while the host is inside a display:none container
        // yields a 0x0 viewer.
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        // Tear down any previous preview viewer so re-opening the modal
        // for a different artefact does not stack viewers on top of
        // each other.
        if (currentPreviewViewer) {
            try { currentPreviewViewer.destroy(); } catch (e) { /* ignore */ }
            currentPreviewViewer = null;
        }
        host.innerHTML = '';
        if (!(window.ej && window.ej.pdfviewer && window.ej.pdfviewer.PdfViewer)) {
            console.warn('Syncfusion PDF Viewer class not available yet.');
            return;
        }
        // Build an absolute URL the same way claimIntake does. The
        // server returns preview URLs as path-only strings (e.g.
        // "/uploads/board-pack/{key}/pdf/{file}.pdf") but the EJ2
        // viewer is happier with an absolute URL - it makes the
        // request unambiguous regardless of the iframe's base href
        // and avoids the "Invalid PDF file type or PDF file not
        // found" error when the viewer resolves the path against an
        // unexpected base.
        var originUrl = window.location.origin;
        var absoluteUrl = url;
        if (url.charAt(0) === '/') {
            var appBase = (window.appBasePath || '').replace(/\/$/, '');
            if (!appBase || appBase === '/') {
                absoluteUrl = originUrl + url;
            } else if (url.indexOf(appBase + '/') === 0) {
                // URL already includes the path base (e.g. when the
                // server runs behind /demos); strip it so the
                // resulting absolute URL doesn't double the base.
                absoluteUrl = originUrl + url.substring(appBase.length);
            } else {
                absoluteUrl = originUrl + appBase + url;
            }
        }
        var resourceUrl = originUrl + (window.appBasePath || '') + '/pdfviewer';
        // The Export step previews the merged Board Pack, where the
        // bookmarks are the primary navigation aid. We pin the
        // bookmark panel open on initial load so the user can see
        // the per-document outline (one entry per uploaded document,
        // opening to that document's first page) immediately,
        // without having to click the bookmark toggle in the
        // sidebar. The Syncfusion PdfViewer exposes this through
        // `isBookmarkPanelOpen` (defaults to false). We do NOT set
        // it for previews of single converted PDFs on the Pack
        // step - those are per-document previews and the bookmark
        // panel there would only show the source renderer's own
        // outline (e.g. one entry per Excel sheet), which is
        // visual noise.
        var openBookmarkPanel = !!opts.openBookmarkPanel;
        try {
            var viewer = new window.ej.pdfviewer.PdfViewer({
                documentPath: absoluteUrl,
                resourceUrl: resourceUrl,
                enableClientSideRendering: true,
                height: '100%',
                width: '100%',
                isBookmarkPanelOpen: openBookmarkPanel
            });
            viewer.appendTo(host);
            currentPreviewViewer = viewer;
        } catch (e) {
            console.error('Preview PdfViewer mount failed', e);
        }
    }

    function closePdfPreviewModal() {
        var modal = document.getElementById('pdfPreviewModal');
        if (!modal) { return; }
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        if (currentPreviewViewer) {
            try { currentPreviewViewer.destroy(); } catch (e) { /* ignore */ }
            currentPreviewViewer = null;
        }
        var host = document.getElementById('pdfPreviewHost');
        if (host) { host.innerHTML = ''; }
    }

    function wirePdfPreviewModalClose() {
        // Delegate close clicks to the document so the backdrop and
        // the X button both work without re-binding. The
        // [data-pdf-preview-close] marker is the single signal.
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (t && t.closest && t.closest('[data-pdf-preview-close]')) {
                closePdfPreviewModal();
            }
        });
        // Escape closes the modal when it is open. The listener is
        // always live but is a no-op when the modal is hidden, so it
        // does not interfere with Escape on other inputs.
        document.addEventListener('keydown', function (e) {
            if (e && e.key === 'Escape') {
                var modal = document.getElementById('pdfPreviewModal');
                if (modal && modal.classList.contains('is-open')) {
                    closePdfPreviewModal();
                }
            }
        });
    }
    function openModal(id) {
        var modal = document.getElementById(id);
        if (!modal) { return; }
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
    }
    function closeModal(id) {
        var modal = document.getElementById(id);
        if (!modal) { return; }
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
    }

    // -- mode setting ----------------------------------------------------------
    function setMode(mode) {
        var normalized = (mode || 'upload').toLowerCase();
        if (STEPS.indexOf(normalized) === -1) { normalized = 'upload'; }
        //Prevent navigation to the Export step when the Board Pack has unsaved Pack-side changes and require regeneration via bpRunPack before proceeding.
        // We silently bounce to Pack with no alert - the
        // stepper already marks Export as .disabled in
        // render(), and the only path that can reach this
        // branch is a URL deep-link or a programmatic setMode
        // call. The Pack step's "Export" button is the single
        // call to action for rebuilding the deck.
        if (normalized === 'export' && state.packDirty) {
            state.activeMode = 'pack';
            state.exportVisited = false;
            save();
            emit('mode-changed', 'pack');
            render();
            refreshFromServer(true);
            return;
        }
        //Prevent navigation to Pack / Export while the user has
        // new unprocessed files. The previously generated Board
        // Pack is partially outdated until the new files are
        // converted (and rebuilt into the pack on the next Pack
        // run), so the user must clear the pending state first.
        // Convert is INTENTIONALLY allowed while pending: that
        // is the most useful view for watching the new files
        // get processed, and it is exactly where the
        // "Process the selected files" CTA from the Upload
        // step drops the user. The stepper itself already marks
        // Pack and Export as .disabled in render(), so the user
        // can't click them; this guard catches the remaining
        // paths (URL deep-links, programmatic setMode, keyboard
        // Enter on a focused stepper circle that bypasses the
        // click handler). We silently bounce back to Upload
        // with no alert - the disabled visual state of the
        // stepper circles already tells the user why the
        // navigation did not happen.
        if (state.hasNewPendingFiles && (normalized === 'pack' || normalized === 'export')) {
            state.activeMode = 'upload';
            save();
            emit('mode-changed', 'upload');
            render();
            refreshFromServer(true);
            return;
        }
        state.activeMode = normalized;
        // The Export step is no longer ticked on "visit" alone -
        // it is ticked by isExportCurrent(), which requires
        // state.boardPackGenerated && !state.packDirty. Setting
        // exportVisited is preserved for backwards compatibility
        // with persisted localStorage snapshots from older
        // sessions (the schema includes the field) and so the
        // markPackDirty() helper can reset it on any Pack-side
        // change. Without the reset, a future read of an older
        // snapshot could leave a stale "true" lying around that
        // some downstream code might consult.
        if (normalized === 'export') {
            state.exportVisited = true;
        }
        save();
        emit('mode-changed', normalized);
        render();
        // When the user returns to a step (e.g. Pack from Export
        // after making a setting change), pull the authoritative
        // workspace snapshot from the server so the toggle pills,
        // text inputs and preview URLs mirror what the generator
        // will actually consume on the next Build. The previous
        // implementation only updated `sessionId`, so a toggle
        // flipped in another tab / window could persist server-
        // side without the visible UI knowing about it.
        refreshFromServer(true);
    }

    function reset() {
        wipe();
        return bpFetch(window.appUrl('/api/board-pack/reset'), {
            method: 'POST'
        })
            .then(safeJson)
            .then(function () {
                return refreshFromServer();
            })
            .then(function () {
                return addDefaultDocuments();
            });
    }

    function convertAllPublic() { return convertAll(); }
    function packPublic() { return packNow(); }
    function updateWatermarkPublic(id, cfg) { return updateWatermark(id, cfg); }
    function updateCommonWatermarkPublic(cfg) { return updateCommonWatermark(cfg); }
    function updateBookmarkPublic(id, cfg) { return updateBookmark(id, cfg); }
    function updateSecurityPublic(cfg) { return updateSecurity(cfg); }
    function reorderDocumentsPublic(ids) { return reorderDocuments(ids); }
    function removeDocumentPublic(id) { return removeDocument(id); }
    function openManifestPreviewPublic() { return openManifestPreview(); }

    // -- per-mode pre-checks ---------------------------------------------------
    function isReachableForMode(mode) {
        var idx = STEPS.indexOf(mode);
        if (idx <= 0) { return true; }
        if (!state.documents || state.documents.length === 0) { return false; }
        if (mode === 'convert' || mode === 'pack' || mode === 'export') {
            // For Convert we need at least one document uploaded.
            return state.documents.length > 0;
        }
        return true;
    }

    // -- packet-list delegated handlers -----------------------------------------
    document.addEventListener('click', function (ev) {
        var target = ev.target;
        if (!target || !(target instanceof Element)) { return; }
        var actionBtn = target.closest('[data-action="remove"]');
        if (actionBtn) {
            var id = actionBtn.getAttribute('data-doc-id');
            if (!id) { return; }
            window.boardPack.removeDocument(id).catch(function (err) {
                alert(err.message || 'Could not remove document.');
            });
            return;
        }
        // Preview buttons (packet row + board pack toolbar + export
        // cards) all carry `data-pdf-preview-url` /
        // `data-pdf-preview-title` attributes. The handler reads
        // both and hands off to openPdfPreview(), which mirrors the
        // Claim Intake package-step modal. Replaces the previous
        // `data-action="preview"` row handler that depended on a
        // docId lookup and the broken `PdfViewer.Inject` API.
        var previewBtn = target.closest('[data-pdf-preview-url]');
        if (previewBtn) {
            var pvUrl = previewBtn.getAttribute('data-pdf-preview-url') || '';
            if (!pvUrl) { return; }
            if (previewBtn.disabled) { return; }
            // The Export step's `bpPreviewPdfCard` button opens
            // the merged Board Pack. We want the bookmark panel
            // open by default so the user sees the per-document
            // outline immediately. Other preview buttons (per-
            // document converted PDF, manifest, etc.) do not need
            // the bookmark panel pinned open, so we keep the
            // viewer in its default closed-bookmark state for
            // those.
            var isExportBoardPack = !!previewBtn.classList && previewBtn.classList.contains('bpPreviewPdfCard');
            openPdfPreview(pvUrl, { openBookmarkPanel: isExportBoardPack });
            return;
        }
        var closeJson = target.closest('[data-json-preview-close]');
        if (closeJson) {
            closeModal('jsonPreviewModal');
            return;
        }
    });

    // Wire the PDF preview modal close behaviour (backdrop click,
    // X button, Escape key) - same wiring the Claim Intake package
    // step uses.
    wirePdfPreviewModalClose();

    // -- initial bootstrap ------------------------------------------------------
    //
    // The boot path is:
    //   1. Load any persisted state from localStorage. If the
    //      schemaVersion on disk does not match SCHEMA_VERSION
    //      the cached snapshot is dropped, so a stale localStorage
    //      entry from a previous deployment cannot leak into the
    //      first paint.
    //   2. Publish `window.boardPack` so the inline stepper
    //      handlers in BoardPack.cshtml (which may fire as soon
    //      as DOMContentLoaded completes) see a fully-formed
    //      state owner.
    //   3. Render SYNCHRONOUSLY before the first server response
    //      lands. For users with a valid v2 localStorage snapshot
    //      this paints their previous state immediately, instead
    //      of showing the static Razor copy for the few hundred
    //      milliseconds it takes the server to respond. The
    //      server snapshot then takes over as the source of
    //      truth on the next render() call.
    //   4. Pull the authoritative workspace snapshot from the
    //      server, then upload the default demo templates
    //      (Executive Board Report / Financial Performance
    //      Dashboard / Board Performance Presentation) the
    //      very first time the user lands on the page, so a
    //      fresh session has a useful packet to convert.
    load();
    var api = {
        state: state,
        setMode: setMode,
        addDocument: addDocument,
        removeDocument: removeDocumentPublic,
        pickUploadedFile: pickUploadedFile,
        reset: reset,
        convertAll: convertAllPublic,
        packNow: packPublic,
        updateWatermark: updateWatermarkPublic,
        updateCommonWatermark: updateCommonWatermarkPublic,
        updateBookmark: updateBookmarkPublic,
        updateSecurity: updateSecurityPublic,
        reorderDocuments: reorderDocumentsPublic,
        openManifestPreview: openManifestPreviewPublic,
        on: on,
        emit: emit
    };
    Object.defineProperty(api, 'state', { get: function () { return state; } });
    window.boardPack = api;

    // Synchronous first render: paints the stepper, packet list
    // and centre panel from the (possibly empty) local state
    // BEFORE the first server response lands. This keeps the
    // initial paint coherent — no half-rendered header, no flash
    // of landing copy from a different mode, no empty `<table>`
    // flashing into a populated one — for users who already have
    // a valid localStorage snapshot. The server snapshot then
    // takes over as the source of truth.
    try { render(); } catch (e) { /* render() will retry from refreshFromServer */ }

    refreshFromServer().then(function () {
        return addDefaultDocuments();
    }).then(function () {
        // Re-render after the default template upload chain
        // finishes so the packet list reflects the full set
        // of documents in one shot rather than animating in
        // one card at a time.
        try { render(); } catch (e) { /* ignore */ }
    }).catch(function (error) {
        console.warn('Default Board Pack documents could not be loaded.', error);
    });
})();