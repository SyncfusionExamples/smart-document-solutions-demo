// ============================================================================
// claimIntake.js
//
// Client-side state owner for the Claim Intake demo. Replaces the
// previous design where every workflow step mutated HttpContext.Session
// and the page re-rendered on every request. The server is now a dumb
// pipeline runner; the browser owns the packet (files + extraction
// + redaction + active mode) entirely.
//
// State model (see also the spec at .codestudio/workflows/current/
// artifacts/spec.md, sections 5, 6, 7):
//
//   localStorage["claimIntake.packet.v1"]    -> JSON.stringify(packet)
//   sessionStorage["claimIntake.active.x"]  -> last extraction JSON
//                                              for the active document
//   IndexedDB "claimIntakeFileCache"        -> recovery cache of
//                                              uploaded PDF bytes,
//                                              keyed by previewUrl
//
// Public surface (window.claimIntake):
//   state, save(), load(), wipe(),
//   addDocument(doc), removeDocument(id),
//   setActiveDocument(id), setMode(mode),
//   setExtraction(previewUrl, extraction),
//   setRedactionItems(ids),
//   applyCorrection(field, value),
//   render(), on(event, fn) / emit(event, payload)
//   ui: { escapeHtml, formatBytes, getFileTypeLabel,
//         getFileTypeAbbreviation, getStateBadgeHtml,
//         getProgressStepsHtml, computeProgress }
//
// The render() function is the centre-panel renderer: it reads
// state.activeMode + the active document and rewrites the DOM
// under <div id="centre-panel">. The packet list, the stepper,
// and the workflow header are all rendered from the same state
// so a state mutation always produces a single coherent UI.
// ============================================================================
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------
    var STORAGE_KEY = 'claimIntake.packet.v1';
    var SCHEMA_VERSION = 1;
    // Leave 0.5 MB of headroom under the 5 MB localStorage cap so a
    // future write (e.g. a SetItem by the Syncfusion PDF viewer for
    // its own book-keeping) does not throw on us.
    var LOCAL_STORAGE_SOFT_CAP = 4.5 * 1024 * 1024;
    var ACTIVE_STORAGE_KEY = 'claimIntake.active.extraction';
    var IDB_NAME = 'claimIntakeFileCache';
    var IDB_STORE = 'files';
    var IDB_VERSION = 1;

    // Workflow modes the UI understands. The empty string means
    // "Choose" (no document picked yet).
    var MODES = ['', 'choose', 'view', 'review', 'redact', 'final'];

    // ------------------------------------------------------------------
    // In-memory state
    // ------------------------------------------------------------------
    var listeners = Object.create(null);
    var state = emptyPacket();
    var idbPromise = null;
    // When true, emit() skips the centre-panel re-render. Used
    // by the Run -> Review transition to stop the centre panel
    // from briefly re-painting the View page (Run button
    // reappearing, PDF viewer re-mounting) between the moment
    // extraction completes and the moment the mode flips to
    // 'review'.
    var suppressCentrePanelRender = false;
    // Cache of the server's default template list. Populated
    // lazily on the first apiGetTemplates() call and refreshed
    // every time a fetch completes. Used by both the centre
    // panel "Packet contents" table and the left sidebar so
    // the two stay in sync and so the table can be rendered
    // synchronously inside renderChoose().
    var cachedTemplates = [];
    var templatesPromise = null;
    // Session lifetime in milliseconds, fetched from
    // GET /api/claim-intake/policy on first load so the
    // localStorage sliding expiry stays in lock-step with the
    // server's ci_session cookie and FileDistributedCache TTL.
    // Defaults to 2h, refreshed to whatever the server returns.
    var SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
    var policyPromise = null;
    // ------------------------------------------------------------------
    // Empty packet factory
    // ------------------------------------------------------------------
    function emptyPacket() {
        return {
            schemaVersion: SCHEMA_VERSION,
            // populated by save() on every write. The default here
            // covers the case where load() falls back to an empty
            // packet (no key, expired key, or malformed payload)
            // so the very first save() does not write a packet
            // without expiresAt and immediately drop it on the
            // next load.
            expiresAt: Date.now() + SESSION_LIFETIME_MS,
            activePreviewUrl: '',
            activeFileName: '',
            activeMode: '',
            documents: [],
            selectedItemIds: [],
            corrections: {}
        };
    }

    // ------------------------------------------------------------------
    // Safe JSON parser for fetch responses.
    //
    // On a live (HTTPS) deployment the request may not reach the
    // .NET backend at all - the reverse proxy can return a
    // 502/503 HTML page, a redirect page, or a CORS preflight
    // failure. The native r.json() throws "Unexpected end of JSON
    // input" the moment it sees a 0-byte or non-JSON body, which
    // we used to surface as a raw alert the user could not
    // act on. safeJson() always resolves to a { ok, status, body,
    // payload } envelope so the caller can branch on whether
    // the body was actually JSON and the request was actually
    // successful.
    // ------------------------------------------------------------------
    function safeJson(r) {
        var status = r.status;
        var ct = r.headers.get('content-type') || '';
        var looksJson = ct.indexOf('application/json') >= 0 || ct.indexOf('+json') >= 0;
        return r.text().then(function (text) {
            if (text && looksJson) {
                try { return { ok: r.ok, status: status, body: text, payload: JSON.parse(text) }; }
                catch (e) { return { ok: false, status: status, body: text, payload: null, parseError: e.message }; }
            }
            if (text) {
                var snippet = text.length > 240 ? (text.substring(0, 240) + '...') : text;
                return { ok: false, status: status, body: text, payload: null, nonJson: true, snippet: snippet };
            }
            return { ok: false, status: status, body: '', payload: null, empty: true };
        });
    }


    // ------------------------------------------------------------------
    // 

    // Build a user-facing error message from a safeJson() envelope.
    // When the server returned a non-2xx or non-JSON response we
    // surface enough context that the user (or support) can see
    // *why* the call failed, instead of the cryptic "Failed to
    // execute 'json'" alert. The server's own JSON message takes
    // priority when available.
    function failureMessage(env, fallback) {
        if (env && env.payload && env.payload.message) { return env.payload.message; }
        if (env && env.nonJson) { return fallback + ' (server returned ' + env.status + ' with a non-JSON body: ' + env.snippet + ')'; }
        if (env && env.empty) { return fallback + ' (server returned ' + env.status + ' with an empty body - the live endpoint may be missing or blocked by a proxy)'; }
        if (env && env.status) { return fallback + ' (server returned ' + env.status + ').'; }
        return fallback;

    }

    // ------------------------------------------------------------------
    // Migration banner detection (spec §9)
    //
    // The old server kept per-session state in HttpContext.Session
    // and the per-session cookie "ci_session". After this refactor
    // the cookie is still set (the file store still uses it) but
    // it no longer carries workflow state. If the new client
    // cannot find its localStorage key on a page that has the
    // ci_session cookie, we show a one-time migration banner so
    // the user knows their work is gone.
    // ------------------------------------------------------------------
    function detectLegacySession() {
        try {
            var has = false;
            for (var i = 0; i < window.document.cookie.split(';').length; i++) {
                var part = window.document.cookie.split(';')[i];
                if (part && part.indexOf('ci_session') !== -1) {
                    has = true;
                    break;
                }
            }
            return has && !localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return false;
        }
    }
    // ------------------------------------------------------------------
    // Session policy (lifetime) loader.
    //
    // Asks the server for the configured session lifetime on first
    // call, caches the promise, and stores the result on
    // SESSION_LIFETIME_MS. The save() function uses the cached
    // value to stamp `expiresAt` on every packet write so the
    // localStorage key self-expires after the configured idle
    // window (default 2h), matching the ci_session cookie and
    // FileDistributedCache TTL on the server side.
    // ------------------------------------------------------------------
    function loadSessionPolicy() {
        if (policyPromise) {
            return policyPromise;
        }
        policyPromise = fetch(window.appUrl('/api/claim-intake/policy'), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin'
        })
            .then(function (r) {
                if (!r || !r.ok) { throw new Error('policy fetch failed'); }
                return r.json();
            })
            .then(function (payload) {
                var ms = payload && typeof payload.sessionLifetimeMs === 'number'
                    ? payload.sessionLifetimeMs
                    : (2 * 60 * 60 * 1000);
                if (ms > 0) {
                    SESSION_LIFETIME_MS = ms;
                }
                return SESSION_LIFETIME_MS;
            })
            .catch(function () {
                // Leave the default if the endpoint is unreachable.
                return SESSION_LIFETIME_MS;
            });
        return policyPromise;
    }

    // ------------------------------------------------------------------
    // IndexedDB file cache (recovery only - the PDF viewer still
    // fetches from the server in the normal path).
    // ------------------------------------------------------------------
    function openIdb() {
        if (idbPromise) {
            return idbPromise;
        }
        if (!window.indexedDB) {
            idbPromise = Promise.resolve(null);
            return idbPromise;
        }
        idbPromise = new Promise(function (resolve) {
            try {
                var req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) {
                        db.createObjectStore(IDB_STORE);
                    }
                };
                req.onsuccess = function () { resolve(req.result); };
                req.onerror = function () { resolve(null); };
            } catch (e) {
                resolve(null);
            }
        });
        return idbPromise;
    }

    function idbPut(previewUrl, blob) {
        return openIdb().then(function (db) {
            if (!db) { return; }
            try {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(blob, previewUrl);
            } catch (e) { /* ignore */ }
        });
    }

    function idbGet(previewUrl) {
        return openIdb().then(function (db) {
            if (!db) { return null; }
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(IDB_STORE, 'readonly');
                    var req = tx.objectStore(IDB_STORE).get(previewUrl);
                    req.onsuccess = function () { resolve(req.result || null); };
                    req.onerror = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    function idbClear() {
        return openIdb().then(function (db) {
            if (!db) { return; }
            try {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).clear();
            } catch (e) { /* ignore */ }
        });
    }

    // ------------------------------------------------------------------
    // Persistence
    // ------------------------------------------------------------------
    function save() {
        // Sliding 2h expiry (config-driven via SESSION_LIFETIME_MS).
        // load() checks `expiresAt` against Date.now() and bumps
        // us back to an empty packet on the next page load when
        // it has elapsed, so abandoned workflows self-clear in
        // step with the server-side ci_session cookie and
        // FileDistributedCache TTL.
        state.expiresAt = Date.now() + SESSION_LIFETIME_MS;
        var json;
        try {
            json = JSON.stringify(state);
        } catch (e) {
            return false;
        }

        // LRU eviction: if the serialised packet is over the soft
        // cap, drop oldest non-active documents from the front of
        // the documents array until we fit. The active document is
        // never dropped (spec §5.2).
        if (json.length > LOCAL_STORAGE_SOFT_CAP) {
            var active = state.activePreviewUrl;
            var droppedAny = false;
            while (json.length > LOCAL_STORAGE_SOFT_CAP && state.documents.length > 0) {
                // Find first doc that is not the active one.
                var dropIndex = -1;
                for (var i = 0; i < state.documents.length; i++) {
                    if (state.documents[i].previewUrl !== active) {
                        dropIndex = i;
                        break;
                    }
                }
                if (dropIndex < 0) {
                    // Only the active document remains and it is
                    // still over the cap. Stop and let the setItem
                    // throw so the caller can show the banner.
                    break;
                }
                state.documents.splice(dropIndex, 1);
                droppedAny = true;
                try { json = JSON.stringify(state); }
                catch (e) { break; }
            }
            if (droppedAny) {
                emit('eviction', { count: droppedAny });
            }
        }

        try {
            localStorage.setItem(STORAGE_KEY, json);
            return true;
        } catch (e) {
            // QuotaExceededError - the active document is too big
            // for localStorage on its own. Surface a banner.
            emit('quota-exceeded', { size: json.length });
            return false;
        }
    }

    function load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                state = emptyPacket();
                return state;
            }
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                state = emptyPacket();
                return state;
            }
            // Sliding 2h expiry. An absent expiresAt means the
            // packet predates the policy change - drop it so a
            // user upgrading to this build does not see a
            // never-expiring packet from before the cap was
            // introduced.
            if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
                try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
                state = emptyPacket();
                return state;
            }
            // Defensive: if the shape is wrong, drop it.
            state = {
                schemaVersion: SCHEMA_VERSION,
                expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : (Date.now() + SESSION_LIFETIME_MS),
                activePreviewUrl: typeof parsed.activePreviewUrl === 'string' ? parsed.activePreviewUrl : '',
                activeFileName: typeof parsed.activeFileName === 'string' ? parsed.activeFileName : '',
                activeMode: MODES.indexOf(parsed.activeMode) >= 0 ? parsed.activeMode : '',
                documents: Array.isArray(parsed.documents) ? parsed.documents.filter(function (d) {
                    return d && typeof d.previewUrl === 'string' && typeof d.fileName === 'string';
                }) : [],
                selectedItemIds: Array.isArray(parsed.selectedItemIds) ? parsed.selectedItemIds.filter(function (x) { return typeof x === 'string'; }) : [],
                corrections: parsed.corrections && typeof parsed.corrections === 'object' ? parsed.corrections : {}
            };
            return state;
        } catch (e) {
            state = emptyPacket();
            return state;
        }
    }

    function wipe() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
        try { sessionStorage.removeItem(ACTIVE_STORAGE_KEY); } catch (e) { /* ignore */ }
        idbClear();
        state = emptyPacket();
        emit('wipe', {});
    }

    // ------------------------------------------------------------------
    // Active document extraction cache (sessionStorage)
    // ------------------------------------------------------------------
    function saveActiveExtraction(previewUrl, extraction) {
        try {
            if (!extraction) {
                sessionStorage.removeItem(ACTIVE_STORAGE_KEY);
                return;
            }
            sessionStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify({
                previewUrl: previewUrl,
                extraction: extraction
            }));
        } catch (e) {
            // Quota - drop it. The in-memory copy on state.documents[i]
            // is still the source of truth.
        }
    }

    function loadActiveExtraction() {
        try {
            var raw = sessionStorage.getItem(ACTIVE_STORAGE_KEY);
            if (!raw) { return null; }
            return JSON.parse(raw);
        } catch (e) { return null; }
    }

    // ------------------------------------------------------------------
    // State mutators
    // ------------------------------------------------------------------
    function findDocIndex(previewUrl) {
        for (var i = 0; i < state.documents.length; i++) {
            if (state.documents[i].previewUrl === previewUrl) {
                return i;
            }
        }
        return -1;
    }

    function activeDocument() {
        if (!state.activePreviewUrl) { return null; }
        var idx = findDocIndex(state.activePreviewUrl);
        return idx >= 0 ? state.documents[idx] : null;
    }

    function addDocument(doc) {
        if (!doc || !doc.previewUrl) { return null; }
        // Same previewUrl => replace.
        var existing = findDocIndex(doc.previewUrl);
        if (existing >= 0) {
            state.documents[existing] = mergeDoc(state.documents[existing], doc);
        } else {
            state.documents.push(normaliseDoc(doc));
        }
        save();
        emit('documents-changed', { documents: state.documents.slice() });
        return state.documents[state.documents.length - 1];
    }

    function removeDocument(idOrUrl) {
        var idx = findDocIndex(idOrUrl);
        if (idx < 0) { return; }
        var removed = state.documents.splice(idx, 1)[0];
        if (state.activePreviewUrl === removed.previewUrl) {
            state.activePreviewUrl = '';
            state.activeFileName = '';
            state.activeMode = '';
        }
        save();
        emit('documents-changed', { documents: state.documents.slice() });
    }

    function setActiveDocument(idOrUrl) {
        var doc = null;
        for (var i = 0; i < state.documents.length; i++) {
            if (state.documents[i].previewUrl === idOrUrl || state.documents[i].id === idOrUrl) {
                doc = state.documents[i];
                break;
            }
        }
        if (!doc) { return; }
        state.activePreviewUrl = doc.previewUrl;
        state.activeFileName = doc.fileName;
        // Do NOT change activeMode here - the caller decides
        // whether to jump to view, resume, etc.
        save();
        emit('active-changed', { document: doc });
    }

    function setMode(mode) {
        if (MODES.indexOf(mode) < 0) { return; }
        state.activeMode = mode;
        save();
        emit('mode-changed', { mode: mode });
    }

    function setExtraction(previewUrl, extraction) {
        var idx = findDocIndex(previewUrl);
        if (idx < 0) { return; }
        state.documents[idx].extraction = extraction || null;
        if (extraction) {
            state.documents[idx].state = 'Searchable';
        }
        save();
        // Mirror to sessionStorage so a page refresh on the Review
        // step can rehydrate the table without a round-trip.
        if (previewUrl === state.activePreviewUrl) {
            saveActiveExtraction(previewUrl, extraction);
        }
        emit('documents-changed', { documents: state.documents.slice() });
    }

    function setRedactionItems(ids) {
        state.selectedItemIds = Array.isArray(ids) ? ids.slice() : [];
        save();
        emit('redaction-changed', { ids: state.selectedItemIds.slice() });
    }

    function applyCorrection(field, value) {
        if (!field) { return; }
        state.corrections[field] = value;
        save();
        emit('correction-changed', { field: field, value: value });
    }

    function setRedactedPreviewUrl(previewUrl, redactedUrl, processedUrl) {
        var idx = findDocIndex(previewUrl);
        if (idx < 0) { return; }
        state.documents[idx].redactedPreviewUrl = redactedUrl || '';
        if (processedUrl) {
            state.documents[idx].searchablePreviewUrl = processedUrl;
        }
        state.documents[idx].reviewApproved = true;
        save();
        // Warm the HTTP cache + IndexedDB for the Final-page
        // artefacts as soon as we know their URLs, so the
        // Preview button on the Final page opens the modal
        // near-instantly. The user is currently on the
        // Redaction step and has not yet navigated to Final,
        // so we have a few seconds of background time before
        // the preview button is even visible.
        preloadPdfBytes(redactedUrl);
        if (processedUrl) { preloadPdfBytes(processedUrl); }
        emit('documents-changed', { documents: state.documents.slice() });
    }

    // Dedicated setter for the searchable PDF preview URL.
    //
    // Mirrors setRedactedPreviewUrl() so the searchable and
    // redacted artefacts follow the exact same client-side
    // contract. The searchable URL flows from THREE places
    // and the dedicated setter is the single chokepoint
    // that keeps them in sync:
    //
    //   1) The background apiSearchable() call fired after
    //      extraction completes.
    //   2) The /redact response's processedPreviewUrl field
    //      (via setRedactedPreviewUrl above).
    //   3) The /processed-pdf manual button.
    //
    // The URL stored here is a web-relative path that
    // already includes the deployment PathBase (the server
    // built it with AppUrl()). The Final-step renderer
    // composes it with `window.location.origin`, so the
    // PathBase MUST stay in the stored value - do not
    // strip it here. The server-side fix in /redact
    // (passing the input through unchanged rather than
    // re-applying AppUrl) is what prevents a double-prefix
    // from ever reaching this setter.
    function setSearchablePreviewUrl(previewUrl, searchableUrl) {
        var idx = findDocIndex(previewUrl);
        if (idx < 0) { return; }
        if (!searchableUrl || typeof searchableUrl !== 'string') { return; }
        state.documents[idx].searchablePreviewUrl = searchableUrl;
        save();
        // Warm the cache for the Final page's Preview button.
        preloadPdfBytes(searchableUrl);
        emit('documents-changed', { documents: state.documents.slice() });
    }

    // ------------------------------------------------------------------
    // Module-level state: the currently mounted Syncfusion PDF
    // viewer (if any). Tracked here so mountPdfViewer can destroy
    // the previous instance before creating a new one, instead of
    // letting the EJ2 controls accumulate inside the same host.
    // ------------------------------------------------------------------
    var currentPdfViewer = null;

    // ------------------------------------------------------------------
    // Doc helpers
    // ------------------------------------------------------------------
    function normaliseDoc(doc) {
        return {
            id: doc.id || generateId(),
            fileName: doc.fileName || '',
            displayName: doc.displayName || stripExt(doc.fileName || ''),
            previewUrl: doc.previewUrl,
            fileType: doc.fileType || 'PDF',
            fileSize: typeof doc.fileSize === 'number' ? doc.fileSize : 0,
            pageCount: typeof doc.pageCount === 'number' ? doc.pageCount : 0,
            addedAt: typeof doc.addedAt === 'number' ? doc.addedAt : Date.now(),
            state: doc.state || 'OcrRequired',
            isUserUploaded: !!doc.isUserUploaded,
            searchablePreviewUrl: doc.searchablePreviewUrl || '',
            redactedPreviewUrl: doc.redactedPreviewUrl || '',
            reviewApproved: !!doc.reviewApproved,
            extraction: doc.extraction || null,
            lastViewedPage: doc.lastViewedPage || 0
        };
    }

    function mergeDoc(a, b) {
        // Merge an existing materialised doc (a) with a fresh
        // descriptor (b) that came in from a sidebar click or
        // a server round-trip. The "rich" workflow state on
        // (a) - the state badge, the extraction result, the
        // redaction outputs, the review approval flag - must
        // NEVER be clobbered by an incoming (b) that has not
        // been processed yet. pickTemplate() in particular
        // always returns state: 'OcrRequired' and no
        // extraction, so the previous "b.state || a.state"
        // rule silently reset a fully processed doc back to
        // "OCR required" the moment the user clicked it
        // again. The fix is to prefer (a) for any field that
        // represents progress, and only fall back to (b) when
        // (a) is missing that field.
        return {
            id: a.id || b.id || generateId(),
            fileName: b.fileName || a.fileName,
            displayName: b.displayName || a.displayName,
            previewUrl: b.previewUrl || a.previewUrl,
            fileType: b.fileType || a.fileType,
            fileSize: b.fileSize || a.fileSize,
            pageCount: b.pageCount || a.pageCount,
            addedAt: a.addedAt || Date.now(),
            // Workflow progress: keep (a) when it has any
            // value. Only adopt (b).state when (a) has no
            // state recorded yet (e.g. first materialisation).
            state: a.state || b.state || 'OcrRequired',
            isUserUploaded: a.isUserUploaded || b.isUserUploaded,
            searchablePreviewUrl: a.searchablePreviewUrl || b.searchablePreviewUrl || '',
            redactedPreviewUrl: a.redactedPreviewUrl || b.redactedPreviewUrl || '',
            reviewApproved: a.reviewApproved || b.reviewApproved,
            extraction: a.extraction || b.extraction || null,
            lastViewedPage: a.lastViewedPage || 0
        };
    }

    function generateId() {
        if (window.crypto && window.crypto.randomUUID) {
            return window.crypto.randomUUID();
        }
        return 'doc-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    function stripExt(name) {
        if (!name) { return ''; }
        var i = name.lastIndexOf('.');
        return i > 0 ? name.slice(0, i) : name;
    }

    // ------------------------------------------------------------------
    // Progress + resume-mode computation (was done server-side before)
    // ------------------------------------------------------------------
    function computeProgress(doc) {
        if (!doc) {
            return { hasChosen: false, hasViewed: false, hasExtraction: false,
                     hasReviewApproved: false, hasRedacted: false, hasFinal: false };
        }
        var hasExtraction = !!(doc.extraction && (doc.extraction.rows || []).length > 0);
        var hasRedacted = !!doc.redactedPreviewUrl;
        return {
            hasChosen: true,
            hasViewed: true,
            hasExtraction: hasExtraction,
            hasReviewApproved: !!doc.reviewApproved,
            hasRedacted: hasRedacted,
            hasFinal: hasRedacted
        };
    }

    function resumeMode(doc) {
        if (!doc) { return ''; }
        if (doc.redactedPreviewUrl) { return 'final'; }
        if (doc.reviewApproved) { return 'redact'; }
        if (doc.extraction && ((doc.extraction.rows || []).length > 0)) { return 'review'; }
        return 'view';
    }

    // ------------------------------------------------------------------
    // Server round-trips
    // ------------------------------------------------------------------
    function apiGetTemplates() {
        // De-duplicate concurrent calls so the first /templates
        // request is shared by every consumer (sidebar,
        // centre-panel table, etc.) until it resolves.
        if (templatesPromise) { return templatesPromise; }
        templatesPromise = fetch(window.appUrl('/api/claim-intake/templates'), {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        }).then(function (r) { return safeJson(r); }).then(function (env) {
            if (!env.ok || !env.payload) {
                throw new Error('Unable to load templates (status ' + env.status + (env.empty ? ', empty body' : (env.nonJson ? ', non-JSON response' : '')) + ').');
            }
            var list = (env.payload && Array.isArray(env.payload.templates)) ? env.payload.templates : [];
            cachedTemplates = list;
            return env.payload;
        });
        return templatesPromise;
    }

    function apiUpload(file) {
        var form = new FormData();
        form.append('document', file);
        return fetch(window.appUrl('/api/claim-intake/upload'), {
            method: 'POST',
            body: form
        }).then(function (r) { return safeJson(r); });
    }

    // Pull the session key out of /uploads/<key>/<file>.
    function sessionKeyFromPreviewUrl(previewUrl) {
        if (!previewUrl || typeof previewUrl !== 'string') { return null; }
        var match = previewUrl.replace(/\\/g, '/').match(/\/uploads\/([A-Za-z0-9_-]{16,128})\//);
        return match ? match[1] : null;
    }

    function apiUploadDefaultTemplate(template) {
        // For default templates we ask the server to materialise
        // a per-session copy via /upload-by-template so the PDF
        // viewer can fetch it from the per-session folder like
        // a real upload.
        return fetch(window.appUrl('/api/claim-intake/upload-by-template'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName: template.fileName })
        }).then(function (r) { return safeJson(r); });
    }

    function apiExtract(previewUrl, sessionKey) {
        // Pin the session key so the server can recover the
        // file when the ci_session cookie is missing.
        var payload = { previewUrl: previewUrl };
        if (!sessionKey) { sessionKey = sessionKeyFromPreviewUrl(previewUrl); }
        if (sessionKey) { payload.sessionKey = sessionKey; }
        return fetch(window.appUrl('/api/claim-intake/extract'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return safeJson(r); });
    }

    function apiSearchable(previewUrl, sessionKey) {
        var payload = { previewUrl: previewUrl };
        if (!sessionKey) { sessionKey = sessionKeyFromPreviewUrl(previewUrl); }
        if (sessionKey) { payload.sessionKey = sessionKey; }
        return fetch(window.appUrl('/api/claim-intake/searchable-pdf'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return safeJson(r); });
    }

    function apiRedact(payload, sessionKey) {
        // payload is the redaction DTO. Tack sessionKey on.
        var body = Object.assign({}, payload || {});
        if (!sessionKey && body.previewUrl) {
            sessionKey = sessionKeyFromPreviewUrl(body.previewUrl);
        }
        if (sessionKey && !body.sessionKey) { body.sessionKey = sessionKey; }
        return fetch(window.appUrl('/api/claim-intake/redact'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) { return safeJson(r); });
    }

    function apiProcessedPdf(previewUrl, sessionKey) {
        var payload = { previewUrl: previewUrl };
        if (!sessionKey) { sessionKey = sessionKeyFromPreviewUrl(previewUrl); }
        if (sessionKey) { payload.sessionKey = sessionKey; }
        return fetch(window.appUrl('/api/claim-intake/processed-pdf'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return safeJson(r); });
    }

    function apiWipe() {
        return fetch(window.appUrl('/api/claim-intake/wipe'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        }).then(function (r) { return safeJson(r); });
    }

    // Soft reset: ask the server to delete only the
    // generated/ subfolder (searchable + redacted PDFs).
    // The original uploads and materialised templates stay
    // on disk so the client's packet list (which references
    // them by previewUrl) keeps working.
    function apiResetProgress() {
        return fetch(window.appUrl('/api/claim-intake/reset-progress'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        }).then(function (r) { return safeJson(r); });
    }

    // ------------------------------------------------------------------
    // Picking a template (default or user upload)
    // ------------------------------------------------------------------

    // Warm the browser HTTP cache (and IndexedDB) for a PDF
    // previewUrl so the Syncfusion EJ2 viewer can fetch it
    // near-instantly when the user reaches the View step. On
    // a live deployment, the network round-trip to the
    // /preview endpoint is the dominant cost of opening a
    // document; firing this fetch in the background at pick
    // time lets the browser cache hit the moment the viewer
    // mounts. Best-effort: any failure is swallowed because
    // the viewer falls back to a normal fetch anyway.
    //
    // The function also stores the bytes in IndexedDB
    // (claimIntakeFileCache), which is the second tier of
    // the cache: subsequent visits within the same browser
    // - or after a hard refresh that evicted the HTTP
    // cache - will be served from IDB without any network
    // round-trip at all.
    function preloadPdfBytes(previewUrl) {
        if (!previewUrl || typeof previewUrl !== 'string') { return; }
        var url = window.location.origin + previewUrl;
        try {
            fetch(url, { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
                .then(function (buf) {
                    if (buf) {
                        var blob = new Blob([buf], { type: 'application/pdf' });
                        return idbPut(previewUrl, blob);
                    }
                })
                .catch(function () { /* best-effort */ });
        } catch (e) { /* best-effort */ }
    }

    function pickTemplate(template) {
        // Default template: ask the server to materialise a copy.
        return apiUploadDefaultTemplate(template).then(function (result) {
            if (!result.ok || !result.payload || !result.payload.success) {
                throw new Error(failureMessage(result, 'Unable to materialise template.'));
            }
            // Preload the PDF bytes in the background so the
            // View page opens quickly. Wrapped in a finally-
            // like pattern: the caller (makePacketClick)
            // doesn't see this promise, so a preload failure
            // cannot block the user's navigation.
            preloadPdfBytes(result.payload.previewUrl);
            // Pin the session key for subsequent calls.
            var sessionKey = result.payload.sessionKey || sessionKeyFromPreviewUrl(result.payload.previewUrl);
            return {
                fileName: result.payload.fileName,
                displayName: template.displayName || template.fileName,
                previewUrl: result.payload.previewUrl,
                sessionKey: sessionKey || '',
                fileType: 'PDF',
                fileSize: result.payload.fileSize || template.fileSize || 0,
                pageCount: result.payload.pageCount || template.pageCount || 0,
                isUserUploaded: false,
                state: 'OcrRequired'
            };
        });
    }

    function pickUploadedFile(file) {
        return apiUpload(file).then(function (result) {
            if (!result.ok || !result.payload || !result.payload.previewUrl) {
                throw new Error(failureMessage(result, 'Unable to upload file.'));
            }
            // Preload the PDF bytes in the background.
            preloadPdfBytes(result.payload.previewUrl);
            var sessionKey = result.payload.sessionKey || sessionKeyFromPreviewUrl(result.payload.previewUrl);
            return {
                fileName: result.payload.fileName,
                displayName: result.payload.fileName,
                previewUrl: result.payload.previewUrl,
                sessionKey: sessionKey || '',
                fileType: result.payload.fileType || 'PDF',
                fileSize: result.payload.fileSize || 0,
                pageCount: result.payload.pageCount || 0,
                isUserUploaded: true,
                state: 'OcrRequired'
            };
        });
    }

    // ------------------------------------------------------------------
    // UI helpers (were inline in Index.cshtml - moved here so the
    // partial views and the new render() can share them).
    // ------------------------------------------------------------------
    var ui = {
        escapeHtml: function (value) {
            if (value === null || value === undefined) { return ''; }
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },

        formatBytes: function (value) {
            if (!value || value <= 0) { return '0 KB'; }
            var units = ['B', 'KB', 'MB', 'GB'];
            var index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
            var size = value / Math.pow(1024, index);
            return (index === 0 ? size.toFixed(0) : size.toFixed(1)) + ' ' + units[index];
        },

        getFileTypeLabel: function (fileName) {
            if (!fileName) { return 'File'; }
            var lower = String(fileName).toLowerCase();
            if (lower.endsWith('.pdf')) return 'PDF';
            if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'Word';
            if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.gif')) return 'Image';
            if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'Excel';
            return 'File';
        },

        getFileTypeAbbreviation: function (fileType) {
            if (!fileType) { return 'FL'; }
            if (fileType === 'PDF') return 'PDF';
            if (fileType === 'Word') return 'DOC';
            if (fileType === 'Image') return 'IMG';
            if (fileType === 'Excel') return 'XLS';
            return fileType.substring(0, 2).toUpperCase();
        },

        getStateBadgeHtml: function (state) {
            var normalized = (state || '').toString();
            if (normalized === 'Searchable' || normalized.toLowerCase() === 'searchable') {
                return '<span class="packet-state-badge packet-state-badge--searchable">Searchable</span>';
            }
            return '<span class="packet-state-badge packet-state-badge--ocr">OCR required</span>';
        },

        getProgressStepsHtml: function (progress) {
            progress = progress || {};
            var hasExtraction = !!progress.hasExtraction;
            var hasReviewApproved = !!progress.hasReviewApproved;
            var hasRedacted = !!progress.hasRedacted;
            var hasFinal = !!progress.hasFinal;
            var steps = [
                { name: 'Choose', done: true },
                { name: 'View', done: true },
                { name: 'Extract', done: hasExtraction },
                { name: 'Review', done: hasReviewApproved || hasExtraction },
                { name: 'Redact', done: hasRedacted },
                { name: 'Final', done: hasFinal }
            ];
            return '<div class="packet-progress-steps" aria-hidden="true">'
                + steps.map(function (s) {
                    return '<span class="packet-progress-chip ' + (s.done ? 'is-done' : 'is-empty') + '" title="' + s.name + '"></span>';
                }).join('')
                + '</div>';
        },

        computeProgress: computeProgress
    };

    // ------------------------------------------------------------------
    // Event bus
    // ------------------------------------------------------------------
    function on(event, fn) {
        if (!listeners[event]) { listeners[event] = []; }
        listeners[event].push(fn);
        return function off() {
            listeners[event] = (listeners[event] || []).filter(function (x) { return x !== fn; });
        };
    }

    function emit(event, payload) {
        var fns = listeners[event] || [];
        for (var i = 0; i < fns.length; i++) {
            try { fns[i](payload); } catch (e) { console.error('listener error', e); }
        }
        // Re-render the centre panel on state changes that
        // change its structure. The redaction/correction events
        // do NOT trigger a re-render: the change handler itself
        // only mutates state, and re-rendering would rebuild
        // the checkboxes, which fires another change, which
        // re-emits - infinite loop. The display already
        // reflects the change in place.
        //
        // We also skip the centre-panel re-render while we are
        // in the middle of the Run -> Review transition. The
        // extraction step mutates the active document and
        // emits 'documents-changed' from inside the Run
        // handler; if we let that re-render go through, it
        // would re-paint the View page (Run button reappearing,
        // PDF viewer re-mounted) for a frame before the mode
        // flip to 'review' lands. The transition handler
        // already paints the final Review page via the
        // 'mode-changed' emit that follows, so suppressing
        // the intermediate re-render keeps the UI stable.
        var renderableEvents = {
            'documents-changed': true,
            'active-changed': true,
            'mode-changed': true,
            'wipe': true
        };
        if (renderableEvents[event] && !suppressCentrePanelRender) {
            try { render(); } catch (e) { console.error('render error', e); }
        }
    }

    // ------------------------------------------------------------------
    // Centre-panel renderer
    //
    // Owns the <div id="centre-panel"> element. Re-renders on
    // every state change. The packet list (sidebar) is rendered
    // by renderPacketList(); the stepper and header are rendered
    // by renderWorkflow(); those run in separate listeners so
    // they only repaint when their inputs actually change.
    // ------------------------------------------------------------------
    function render() {
        var host = document.getElementById('centre-panel');
        if (!host) { return; }
        var mode = state.activeMode || '';
        var doc = activeDocument();
        // The user clicks "Workspace home" or a stepper back
        // to mode = 'choose' - render the Choose view (with
        // the resume CTA) regardless of whether a document
        // is active. This is the home/dashboard view.
        if (mode === 'choose') {
            host.setAttribute('data-mode', 'choose');
            host.innerHTML = renderChoose({ documents: state.documents });
            wireChooseButtons(host);
            return;
        }
        if (!doc) {
            host.setAttribute('data-mode', 'choose');
            host.innerHTML = renderChoose({ documents: state.documents });
            wireChooseButtons(host);
            return;
        }
        host.setAttribute('data-mode', mode);
        if (mode === 'view' || mode === '') {
            host.innerHTML = renderView(doc);
            wireViewButtons(host);
            // Mount the Syncfusion PDF viewer into the host
            // div after the DOM is settled. The viewer class
            // is loaded from ejs-scripts at the end of body,
            // so it is always available here.
            mountPdfViewer(host);
        } else if (mode === 'review') {
            host.innerHTML = renderReview(doc);
            wireReviewButtons(host);
        } else if (mode === 'redact') {
            host.innerHTML = renderRedact(doc);
            wireRedactButtons(host);
        } else if (mode === 'final') {
            host.innerHTML = renderFinal(doc);
            wireFinalButtons(host);
        } else {
            host.innerHTML = renderView(doc);
            wireViewButtons(host);
            mountPdfViewer(host);
        }
    }

    // ------------------------------------------------------------------
    // Choose view (no active document)
    // ------------------------------------------------------------------
    function renderChoose(ctx) {
        var hasDocument = ctx.documents && ctx.documents.length > 0;
        var activeResume = '';
        var active = activeDocument();
        if (active) {
            activeResume = resumeMode(active);
        }
        var canContinue = hasDocument && activeResume;
        var continueUrl = canContinue ? (window.appUrl('/?mode=' + activeResume) || ('?mode=' + activeResume)) : '';
        var continueLabel = (activeResume === 'view' || activeResume === '' || activeResume === 'choose')
            ? 'Process the selected file'
            : 'Continue where you left off';
        var hint = hasDocument
            ? 'Click a file to continue.'
            : 'Pick a file from the packet to begin. The button stays disabled until a file is selected.';
        // Build the packet-contents table rows from BOTH the
        // server's default templates and the materialised docs
        // in state. Using the cached templates synchronously
        // guarantees the table is complete on first render -
        // we no longer rely on the async refresh to add the
        // ghost rows. If the templates cache has not been
        // populated yet (very first paint before the
        // /templates fetch resolves), we fall back to the
        // materialised docs so the user still sees what they
        // have.
        var rows = buildPacketContentsRows(cachedTemplates, ctx.documents);
        if (rows.length === 0) {
            rows = ctx.documents || [];
        }
        var rowsHtml = renderPacketContentsRows(rows);
        return ''
            + '<div class="center-header">'
            +   '<div>'
            +     '<p class="section-title">Claim Intake Demo</p>'
            +     '<h1></h1>'
            +     '<p class="landing-intro">'
            +       'Experience a smart claims processing solution that converts unstructured claim documents into structured, business-ready data. '
            +       'Extract, review, and refine information, then use AI-powered sensitive data detection to identify and redact confidential content before packaging the final output.'
            +     '</p>'
            +   '</div>'
            + '</div>'
            + '<div class="choose-panel">'
            +   '<section class="choose-scenario-panel">'
            +     '<div class="section-title">SCENARIO OBJECTIVE</div>'
            +     '<h1>Turn the chosen document into a reviewed, redacted, case-ready output.</h1>'
            +     '<p class="choose-scenario-body">'
            +       'Select any file from the packet on the left to begin the workflow. The document is loaded into the PDF Viewer, processed for data extraction, and queued for review, redaction, and packaging. AI-powered sensitive data detection identifies confidential information for secure redaction, while the progress bar at the top of the page provides real-time visibility into each stage of the process.'
            +     '</p>'
            +     '<div class="choose-scenario-cta">'
            +       '<button id="continueWorkflowBtn" type="button" class="primary-btn choose-scenario-cta-btn"'
            +              (canContinue ? '' : ' disabled aria-disabled="true"')
            +              ' data-href="' + ui.escapeHtml(continueUrl) + '">'
            +         ui.escapeHtml(continueLabel)
            +       '</button>'
            +       '<span class="choose-scenario-hint">'
            +         ui.escapeHtml(hint)
            +       '</span>'
            +     '</div>'
            +   '</section>'
            +   '<div class="packet-contents-panel">'
            +     '<div class="packet-contents-title">Packet contents</div>'
            +     '<div class="packet-contents-scroll">'
            +       '<table class="packet-contents-table">'
            +         '<thead>'
            +           '<tr>'
            +             '<th>FILE</th>'
            +             '<th>TYPE</th>'
            +             '<th>PAGES</th>'
            +             '<th>SIZE</th>'
            +             '<th>STATE</th>'
            +           '</tr>'
            +         '</thead>'
            +         '<tbody id="packetContentsTableBody">'
            +           rowsHtml
            +         '</tbody>'
            +       '</table>'
            +     '</div>'
            +   '</div>'
            + '</div>';
    }

    function renderPacketContentsRows(documents) {
        if (!documents || documents.length === 0) {
            return '<tr><td colspan="5">No files in the packet yet. Use "Add files" to upload your own, or pick a template on the left.</td></tr>';
        }
        var html = '';
        for (var i = 0; i < documents.length; i++) {
            var d = documents[i];
            var typeLabel = d.fileType || ui.getFileTypeLabel(d.fileName || '');
            var pages = d.pageCount > 0 ? String(d.pageCount) : '1';
            var size = d.fileSize > 0 ? ui.formatBytes(d.fileSize) : '\u2014';
            html += ''
                + '<tr>'
                +   '<td>' + ui.escapeHtml(d.fileName || '') + '</td>'
                +   '<td>' + ui.escapeHtml(typeLabel) + '</td>'
                +   '<td>' + ui.escapeHtml(pages) + '</td>'
                +   '<td>' + ui.escapeHtml(size) + '</td>'
                +   '<td>' + ui.getStateBadgeHtml(d.state) + '</td>'
                + '</tr>';
        }
        return html;
    }

    // Build the merged "Packet contents" row set in a single
    // canonical order: server-known default templates first
    // (in the order the server returned them), then any
    // materialised doc that does not match a known template
    // (typically user uploads) appended at the end. For each
    // template, if a materialised copy exists in state.documents
    // the materialised copy is used (so its real state, size,
    // and page count win); otherwise a ghost row is rendered
    // with state = 'OcrRequired'. This is the single source of
    // truth used by both renderChoose() (synchronous) and
    // refreshPacketContentsTable() (after the templates fetch
    // resolves), so the two paths can never disagree.
    function buildPacketContentsRows(templates, docs) {
        templates = Array.isArray(templates) ? templates : [];
        docs = Array.isArray(docs) ? docs : [];
        var rows = [];
        var matchedDocNames = {};
        for (var t = 0; t < templates.length; t++) {
            var tpl = templates[t];
            var materialised = null;
            for (var d = 0; d < docs.length; d++) {
                if (docs[d].fileName === tpl.fileName) {
                    materialised = docs[d];
                    matchedDocNames[tpl.fileName] = true;
                    break;
                }
            }
            if (materialised) {
                rows.push({
                    fileName: materialised.fileName,
                    fileType: materialised.fileType,
                    pageCount: materialised.pageCount,
                    fileSize: materialised.fileSize,
                    state: materialised.state || 'OcrRequired'
                });
            } else {
                rows.push({
                    fileName: tpl.fileName,
                    fileType: tpl.fileType || 'PDF',
                    pageCount: tpl.pageCount || 0,
                    fileSize: tpl.fileSize || 0,
                    state: 'OcrRequired'
                });
            }
        }
        for (var o = 0; o < docs.length; o++) {
            if (!matchedDocNames[docs[o].fileName]) {
                rows.push({
                    fileName: docs[o].fileName,
                    fileType: docs[o].fileType,
                    pageCount: docs[o].pageCount,
                    fileSize: docs[o].fileSize,
                    state: docs[o].state || 'OcrRequired'
                });
            }
        }
        return rows;
    }

    // Refreshes the centre-panel "Packet contents" table by
    // merging the server-known default templates with the
    // materialised documents in state.documents. The fetch
    // also refreshes the cached template list, so subsequent
    // synchronous renderChoose() calls see the latest data.
    // The function early-returns when the table is not
    // mounted (i.e. the user is not on the Choose view) so
    // it is safe to call unconditionally on every state
    // change.
    function refreshPacketContentsTable() {
        var body = document.getElementById('packetContentsTableBody');
        if (!body) { return; }
        var docs = state.documents.slice();
        apiGetTemplates().then(function () {
            // Bail out if the user has navigated away from
            // the Choose view while the fetch was in flight.
            if (!document.getElementById('packetContentsTableBody')) { return; }
            var rows = buildPacketContentsRows(cachedTemplates, docs);
            body.innerHTML = renderPacketContentsRows(rows);
        }).catch(function () {
            // On error, fall back to whatever is already in
            // state (or the templates we cached before the
            // failure) so the user still sees their files.
            if (document.getElementById('packetContentsTableBody')) {
                var rows = buildPacketContentsRows(cachedTemplates, docs);
                if (rows.length === 0) { rows = docs; }
                body.innerHTML = renderPacketContentsRows(rows);
            }
        });
    }

    function wireChooseButtons(host) {
        var btn = host.querySelector('#continueWorkflowBtn');
        if (!btn) { return; }
        btn.addEventListener('click', function () {
            if (btn.disabled) { return; }
            var target = btn.getAttribute('data-href') || '';
            if (!target) {
                setMode('view');
                return;
            }
            // Internal navigation: same tab, just flip the mode.
            if (target.indexOf('?mode=') >= 0 || target.indexOf('&mode=') >= 0) {
                var m = /[?&]mode=([^&]+)/.exec(target);
                if (m) { setMode(m[1]); return; }
            }
            window.location.replace(target);
        });
    }

    // ------------------------------------------------------------------
    // View step
    // ------------------------------------------------------------------
    function renderView(doc) {
        var originUrl = window.location.origin;
        var documentUrl = doc.previewUrl ? (originUrl + doc.previewUrl) : '';
        var resourceUrl = originUrl + (window.appBasePath || '') + '/pdfviewer';
        // The Syncfusion PDF viewer mounts into a host div via
        // JS API rather than the <ejs-pdfviewer> tag - the tag
        // approach races with the auto-init pipeline and yields
        // a broken chrome. The JS API is reliable.
        return ''
            + '<div class="viewer-wrap full-viewer-wrap">'
            +   '<div id="pdfviewerHost" class="pdf-viewer-host"></div>'
            + '</div>'
            + '<div class="view-callout" role="region" aria-label="Run extraction">'
            +   '<div class="view-callout-text">'
            +     'Run OCR and structured extraction to populate fields.'
            +   '</div>'
            +   '<button id="runBtn" type="button" class="primary-btn">Run OCR & Extraction</button>'
            + '</div>';
    }

    function mountPdfViewer(host) {
        var target = host.querySelector('#pdfviewerHost');
        if (!target) { return; }
        // Destroy any previously mounted viewer. The EJ2
        // viewer is heavyweight (toolbar, canvas, page cache)
        // and cannot be left behind - otherwise the next
        // mount produces duplicate chrome and double-loaded
        // pages.
        if (currentPdfViewer) {
            try { currentPdfViewer.destroy(); } catch (e) { /* ignore */ }
            currentPdfViewer = null;
        }
        // Wipe the host DOM so no orphan viewer chrome
        // remains. This is the strongest possible reset.
        target.innerHTML = '';
        if (!(window.ej && window.ej.pdfviewer && window.ej.pdfviewer.PdfViewer)) {
            console.warn('Syncfusion PDF Viewer class not available yet.');
            return;
        }
        var doc = activeDocument();
        if (!doc || !doc.previewUrl) { return; }
        var originUrl = window.location.origin;
        var documentUrl = originUrl + doc.previewUrl;
        var resourceUrl = originUrl + (window.appBasePath || '') + '/pdfviewer';
        try {
            var centre = host; // host === #centre-panel
            var wrapper = centre.querySelector('.full-viewer-wrap');
            var px = 0;
            if (wrapper) {
                // Force a layout flush so wrapper.offsetHeight
                // reflects the real flex column height rather
                // than a stale 0.
                // eslint-disable-next-line no-unused-expressions
                wrapper.offsetHeight;
                px = wrapper.clientHeight;
                if (!px || px < 300) {
                    // Walk up until we find a node with a real
                    // height; fall back to viewport-derived
                    // estimate so mount never sees clientHeight
                    // == 0.
                    var probe = wrapper.parentElement;
                    while (probe && px < 300) {
                        var h = probe.clientHeight;
                        if (h && h >= 300) { px = h; break; }
                        probe = probe.parentElement;
                    }
                    if (!px || px < 300) {
                        px = Math.max(300, (window.innerHeight || 700) - 220);
                    }
                }
                wrapper.style.minHeight = px + 'px';
            }
            // Lock the host to that exact height for the
            // appendTo() measurement - it will be released
            // after EJ2 has settled.
            if (!target.style.height || target.clientHeight === 0) {
                target.style.height = px + 'px';
            }
        } catch (eLayout) { /* best-effort - EJ2 will fall back to its own defaults */ }
        try {
            var viewer = new window.ej.pdfviewer.PdfViewer({
                documentPath: documentUrl,
                resourceUrl: resourceUrl,
                enableClientSideRendering: true,
                height: '100%',
                width: '100%'
            });
            viewer.appendTo(target);
            currentPdfViewer = viewer;
            // NOTE: do not call viewer.load(documentUrl, '') here -
            // the documentPath constructor option already wires
            // the initial load. Calling load() twice causes a
            // duplicate ajax request whose error path trips the
            // notification popup and produces a TypeError on
            // appendChild.
            var settleOnce = function () {
                if (!currentPdfViewer || currentPdfViewer !== viewer) { return; }
                try {
                    var mgn = currentPdfViewer.magnificationModule;
                    if (mgn && typeof mgn.responsivePages === 'function') {
                        mgn.responsivePages();
                    }
                    if (mgn && typeof mgn.zoomTo === 'function' && typeof mgn.getZoomFactor === 'function') {
                        try {
                            var pd = document.querySelector('.pdf-viewer-host .e-pv-page-div');
                            if (pd) {
                                var pRect = pd.getBoundingClientRect();
                                var host = document.querySelector('.pdf-viewer-host');
                                var hRect = host ? host.getBoundingClientRect() : null;
                                // Anything with a healthy
                                // >180px-tall page-div inside a
                                // >400px-tall host is what we
                                // call "good enough" - leave
                                // EJ2 alone. Below that
                                // threshold we ask EJ2 to
                                // recompute the fit factor and
                                // apply it once.
                                if (hRect && pRect.height < Math.max(180, hRect.height * 0.5)) {
                                    var targetZoom = (typeof mgn.calculateFitZoomFactor === 'function' && typeof mgn.fitToWidth === 'function')
                                        ? (function () {
                                            try {
                                                mgn.fitToWidth();
                                                return mgn.getZoomFactor();
                                            } catch (eCalc) { return 0.92; }
                                        })()
                                        : 0.92;
                                    try { mgn.zoomTo(targetZoom, false); } catch (eZ2) { /* ignore */ }
                                    try { mgn.zoomTo(mgn.getZoomFactor(), true); } catch (eZ3) { /* ignore */ }
                                }
                            }
                        } catch (eGuard) { /* ignore */ }
                    }
                } catch (eSettle) { /* ignore */ }
            };
            // Hook the public load-success event so we re-measure as soon as the PDF page has actually been decoded by pdfium. This is
            // more reliable than timeouts because the documentPath fetch + canvas paint sequence varies wildly between fresh launch and
            // after-redaction revisits.
            try {
                viewer.loadSuccess = function () {
                    try {
                        // Release the pixel-height pre-set
                        // now that EJ2 has rendered, so the
                        // flex chain takes over for ongoing
                        // resizes.
                        var w = target.parentElement;
                        if (w) { w.style.minHeight = ''; }
                        target.style.height = '';
                    } catch (eRel) { /* ignore */ }
                    if (typeof window.requestAnimationFrame === 'function') {
                        window.requestAnimationFrame(function () {
                            settleOnce();
                            window.requestAnimationFrame(function () {
                                settleOnce();
                                window.requestAnimationFrame(function () { settleOnce(); });
                            });
                        });
                    } else {
                        window.setTimeout(settleOnce, 50);
                    }
                };
            } catch (eHook) { /* ignore */ }
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(function () { settleOnce(); });
            }
            if (typeof window.setTimeout === 'function') {
                window.setTimeout(settleOnce, 250);
                window.setTimeout(settleOnce, 600);
            }
        } catch (e) {
            console.error('PdfViewer mount failed', e);
            try { target.style.height = ''; if (target.parentElement) target.parentElement.style.minHeight = ''; } catch (eRollback) { /* ignore */ }
        }
    }

    function wireViewButtons(host) {
        var runBtn = host.querySelector('#runBtn');
        if (runBtn) {
            runBtn.addEventListener('click', function () { onRunClicked(runBtn); });
        }
    }

    // ------------------------------------------------------------------
    // Review step
    // ------------------------------------------------------------------
    function renderReview(doc) {
        var rows = (doc.extraction && doc.extraction.rows) || [];
        var fieldRows = rows.filter(function (r) { return !r.isTable; });
        var tableRows = rows.filter(function (r) { return r.isTable; });
        var hasRows = fieldRows.length > 0;

        var lowConfSummary = hasRows
            ? '<div class="review-confidence-summary" aria-label="Low confidence summary">'
            + '<span class="review-confidence-chip">Below 0.75</span>'
                + '</div>'
            : '';
        var html = ''
            + '<div class="center-header">'
            +   '<div><p class="section-title">Claim Intake Demo</p>'
            +   '<h1>Review extracted claim data</h1>'
            +   lowConfSummary
            +   '</div>'
            + '</div>';

        if (!hasRows) {
            html += ''
                + '<div class="viewer-placeholder">'
                +   '<h2>No extracted data yet</h2>'
                +   '<p>Return to the viewer and run extraction first.</p>'
                + '</div>';
            return html;
        }

        // Detect unpaired rows (mirror the old logic).
        var hasUnpaired = fieldRows.some(function (r) { return r.isUnpairedText; });
        var hasPaired = fieldRows.some(function (r) { return !r.isUnpairedText; });
        var hideFieldColumn = hasUnpaired && !hasPaired;

        html += '<div class="review-center-stack"><section class="review-fixed-panel"><div class="review-table-wrap">'
            + '<table class="review-table ' + (hideFieldColumn ? 'review-table--no-field' : '') + '">'
            + '<colgroup>'
            +   (hideFieldColumn ? '' : '<col class="review-col-field" />')
            +   '<col class="review-col-value" />'
            +   '<col class="review-col-confidence" />'
            + '</colgroup>'
            + '<thead><tr>'
            +   (hideFieldColumn ? '' : '<th>Field</th>')
            +   '<th>Extracted value</th>'
            +   '<th>Confidence</th>'
            + '</tr></thead>'
            + '<tbody>';

        for (var i = 0; i < fieldRows.length; i++) {
            var r = fieldRows[i];
            var displayedValue = state.corrections[r.field] || r.value;
            var lowConf = r.confidence < 0.75;
            var isUnpaired = r.isUnpairedText;
            html += '<tr class="' + (lowConf ? 'low-confidence' : '') + ' ' + (isUnpaired ? 'unpaired-text' : '') + '">'
                + (hideFieldColumn ? '' : '<td>' + ui.escapeHtml(r.field) + '</td>')
                + '<td class="value-cell">'
                +   '<span class="display-value">' + ui.escapeHtml(displayedValue) + '</span>'
                +   '<input class="edit-value-input" type="text" value="' + ui.escapeHtml(displayedValue) + '" style="display:none;" />'
                + '</td>'
                + '<td>'
                +   '<span class="confidence-badge ' + (lowConf ? 'warn' : 'ok') + '">' + Number(r.confidence).toFixed(2) + '</span>'
                + '</td>'
                + '</tr>';
        }

        html += '</tbody></table></div></section>';

        // Tables: show after the main review table.
        if (tableRows.length > 0) {
            html += '<div class="review-tables-section">';
            for (var t = 0; t < tableRows.length; t++) {
                html += '<div class="review-table-block">' + tableRows[t].value + '</div>';
            }
            html += '</div>';
        }

        // Footer with the Continue button styled as a green
        // .redact-confirmation callout. The user no longer
        // needs to explicitly approve - corrections recorded
        // in the local workspace propagate to all generated
        // outputs - so the audit-log text sits alongside the
        // Continue button in the same callout.
        var reviewApproved = !!doc.reviewApproved;
        html += ''
            + '<div id="redactConfirmation" class="redact-confirmation">'
            +   '<p class="confirmation-text">Corrections recorded in the session audit log and propagated to all generated outputs.</p>'
            +   '<button id="continueToRedactBtn" type="button" class="primary-btn">'
            +     'Continue to Redaction &rarr;'
            +   '</button>'
            + '</div>';

        // Low-confidence warning box.
        var requiresReview = fieldRows.some(function (r) { return r.confidence < 0.5; });
        if (requiresReview) {
            html = ''
                + '<div id="reviewRequiredBox" class="review-required-box">'
                +   '<h3 class="review-required-title">REVIEW REQUIRED</h3>'
                +   '<p class="review-required-text">Some extracted values are below the 0.5 confidence threshold. Please edit them above and continue to redaction when you are ready.</p>'
                + '</div>'
                + html;
        }

        html += '</div>';
        return html;
    }

    function wireReviewButtons(host) {
        // Edit/Save buttons (per row).
        var editBtns = host.querySelectorAll('.edit-btn');
        for (var i = 0; i < editBtns.length; i++) {
            editBtns[i].addEventListener('click', makeEditHandler(editBtns[i]));
        }
        var saveBtns = host.querySelectorAll('.save-btn');
        for (var j = 0; j < saveBtns.length; j++) {
            saveBtns[j].addEventListener('click', makeSaveHandler(saveBtns[j]));
        }
        var continueBtn = host.querySelector('#continueToRedactBtn');
        if (continueBtn) { continueBtn.addEventListener('click', onContinueToRedactClicked); }
    }

    function makeEditHandler(button) {
        return function () {
            var row = button.closest('tr');
            if (!row) { return; }
            row.querySelector('.display-value').style.display = 'none';
            row.querySelector('.edit-value-input').style.display = 'block';
            var save = row.querySelector('.save-btn');
            button.style.display = 'none';
            if (save) {
                save.style.display = 'inline-block';
                var input = row.querySelector('.edit-value-input');
                if (input) { input.focus(); input.select(); }
            }
        };
    }

    function makeSaveHandler(button) {
        return function () {
            var row = button.closest('tr');
            if (!row) { return; }
            var editBtn = row.querySelector('.edit-btn');
            var field = editBtn ? editBtn.getAttribute('data-field') : '';
            var input = row.querySelector('.edit-value-input');
            var value = input ? input.value : '';
            applyCorrection(field, value);
            var display = row.querySelector('.display-value');
            if (display) { display.textContent = value; display.style.display = 'inline'; }
            if (input) { input.style.display = 'none'; }
            if (editBtn) { editBtn.style.display = 'inline-block'; }
            button.style.display = 'none';
        };
    }

    // ------------------------------------------------------------------
    // Redact step
    // ------------------------------------------------------------------
    function renderRedact(doc) {
        var rows = (doc.extraction && doc.extraction.rows) || [];
        var redactable = rows.filter(function (r) { return !r.isTable && r.hasBounds && r.isSensitive; });

        var html = ''
            + '<div class="center-header">'
            +   '<div><p class="section-title">Claim Intake Demo</p>'
            +   '<h1>Redaction</h1></div>'
            + '</div>';

        if (redactable.length === 0) {
            html += ''
                + '<div class="viewer-placeholder">'
                +   '<h2>No sensitive data detected</h2>'
                +   '<p>The extracted values do not contain personally identifiable information (such as IDs, phone numbers, addresses, or monetary amounts), so there is nothing to redact.</p>'
                + '</div>';
            return html;
        }

        var selected = new Set(state.selectedItemIds);
        html += '<section class="redaction-panel"><div class="redaction-list">';
        for (var i = 0; i < redactable.length; i++) {
            var r = redactable[i];
            var checked = selected.size === 0 ? true : selected.has(r.field + '|' + r.value);
            html += ''
                + '<label class="redaction-item">'
                +   '<input class="redact-item-check" type="checkbox" ' + (checked ? 'checked ' : '')
                +     'data-field="' + ui.escapeHtml(r.field) + '" data-value="' + ui.escapeHtml(r.value) + '" />'
                +   '<div class="redaction-item-main">'
                +     '<div class="redaction-item-top">'
                +       '<strong>' + ui.escapeHtml(r.field) + '</strong>'
                +       '<span class="confidence-badge ' + (r.confidence < 0.75 ? 'warn' : 'ok') + '">'
                +         Number(r.confidence).toFixed(2)
                +       '</span>'
                +     '</div>'
                +     '<div class="redaction-item-value">' + ui.escapeHtml(r.value) + '</div>'
                +   '</div>'
                + '</label>';
        }
        html += '</div>'
            + '<div id="redactRequiredBox" class="review-required-box">'
            +   '<div>'
            +     '<h3 class="review-required-title">REDACTION REQUIRED</h3>'
            +     '<p class="review-required-text">Selected items will be permanently removed from the document.</p>'
            +   '</div>'
            +   '<button id="applyRedactionBtn" type="button" class="primary-btn">Apply Permanently</button>'
            + '</div>'
            + '</section>';
        return html;
    }

    function wireRedactButtons(host) {
        // Track checkboxes for the apply handler.
        var checks = host.querySelectorAll('.redact-item-check');
        for (var i = 0; i < checks.length; i++) {
            checks[i].addEventListener('change', updateSelectedItems);
        }
        updateSelectedItems();
        var apply = host.querySelector('#applyRedactionBtn');
        if (apply) { apply.addEventListener('click', onApplyRedactionClicked); }
    }

    function updateSelectedItems() {
        var items = [];
        var checks = document.querySelectorAll('.redact-item-check:checked');
        for (var i = 0; i < checks.length; i++) {
            items.push((checks[i].getAttribute('data-field') || '') + '|' + (checks[i].getAttribute('data-value') || ''));
        }
        setRedactionItems(items);
    }

    // ------------------------------------------------------------------
    // Final step
    // ------------------------------------------------------------------
    function renderFinal(doc) {
        var processedUrl = doc.searchablePreviewUrl ? (window.location.origin + doc.searchablePreviewUrl) : '';
        var redactedUrl = doc.redactedPreviewUrl ? (window.location.origin + doc.redactedPreviewUrl) : '';
        // The Preview + Download buttons live in their own
        // actions row so they stay side-by-side and
        // centre-aligned under the card description. The
        // Preview button is gated on the URL being present
        // (mirrors the Download button) so the user only
        // sees a Preview once the corresponding artefact
        // actually exists. The "Generate searchable PDF"
        // CTA is preserved for the case where the searchable
        // PDF has not been generated yet.
        var processedBlock = processedUrl
            ? '<div class="final-download-actions">'
            +   '<a class="primary-btn" href="' + ui.escapeHtml(processedUrl) + '" download="Searchable.pdf">Download</a>'
            +   '<button type="button" class="secondary-btn" data-pdf-preview-url="' + ui.escapeHtml(processedUrl) + '" data-pdf-preview-title="Searchable PDF">Preview</button>'
            + '</div>'
            : '<button id="generateProcessedPdfBtn" type="button" class="primary-btn">Generate searchable PDF</button>'
                + '<span id="generateProcessedPdfStatus" class="secondary-btn" style="display:none;margin-top:8px;align-items:center;justify-content:center;opacity:.7;cursor:default;">Generating...</span>';
        var redactedBlock = redactedUrl
            ? '<div class="final-download-actions">'
            +   '<a class="primary-btn" href="' + ui.escapeHtml(redactedUrl) + '" download="Redacted.pdf">Download</a>'
            +   '<button type="button" class="secondary-btn" data-pdf-preview-url="' + ui.escapeHtml(redactedUrl) + '" data-pdf-preview-title="Redacted PDF">Preview</button>'
            + '</div>'
            : '<span class="secondary-btn" style="display:inline-flex;align-items:center;justify-content:center;opacity:.6;cursor:not-allowed;">No redacted PDF yet</span>';
        return ''
            + '<div class="center-header">'
            +   '<div><p class="section-title">Claim Intake Demo</p>'
            +   '<h1>Package</h1></div>'
            + '</div>'
            + '<section class="final-panel">'
            +   '<div class="viewer-placeholder" style="margin-bottom: 14px;">'
            +     '<div>'
            +       '<h2>Package</h2>'
            +       '<p>Download or preview the searchable PDF and the redacted PDF generated by the workflow.</p>'
            +     '</div>'
            +   '</div>'
            +   '<div class="final-download-grid">'
            +     '<div class="final-download-card">'
            +       '<h3>Searchable PDF document</h3>'
            +       '<p>A searchable PDF enriched with extracted claim data and OCR results.</p>'
            +       processedBlock
            +     '</div>'
            +     '<div class="final-download-card">'
            +       '<h3>Redacted document</h3>'
            +       '<p>A compliance-ready PDF with sensitive information permanently removed for secure distribution.</p>'
            +       redactedBlock
            +     '</div>'
            +   '</div>'
            + '</section>';
    }

    function wireFinalButtons(host) {
        var btn = host.querySelector('#generateProcessedPdfBtn');
        if (btn) { btn.addEventListener('click', onGenerateProcessedPdfClicked); }
        // Wire the per-card Preview buttons. Each carries the
        // absolute URL and a human-readable title in data-*
        // attributes so the modal can render the right
        // document without needing to re-derive it.
        var previews = host.querySelectorAll('[data-pdf-preview-url]');
        for (var i = 0; i < previews.length; i++) {
            previews[i].addEventListener('click', makePdfPreviewHandler(previews[i]));
        }
    }

    function makePdfPreviewHandler(button) {
        return function () {
            var url = button.getAttribute('data-pdf-preview-url') || '';
            var title = button.getAttribute('data-pdf-preview-title') || 'Preview';
            if (!url) { return; }
            openPdfPreviewModal(url, title);
        };
    }

    // ------------------------------------------------------------------
    // PDF Preview modal
    //
    // Mounts a Syncfusion PdfViewer into the page-scoped
    // #pdfPreviewHost (defined in Index.cshtml) and shows
    // #pdfPreviewModal. Uses the SAME JS API + destroy()
    // dance as mountPdfViewer() so the modal viewer does
    // not collide with the in-page View-step viewer. The
    // destroy() on close is what keeps the page from
    // accumulating orphan EJ2 chrome if the user opens and
    // closes the modal repeatedly, or switches between
    // Searchable and Redacted previews without closing
    // between them.
    // ------------------------------------------------------------------
    var currentPreviewViewer = null;
    function openPdfPreviewModal(url, title) {
        if (!url) { return; }
        var modal = document.getElementById('pdfPreviewModal');
        var host = document.getElementById('pdfPreviewHost');
        var titleEl = document.getElementById('pdfPreviewTitle');
        if (!modal || !host) { return; }
        if (titleEl && title) { titleEl.textContent = title; }
        // Open first so the host has a measurable size -
        // the EJ2 viewer reads the host's clientWidth /
        // clientHeight when it appends; mounting while the
        // host is inside a display:none container yields a
        // 0x0 viewer.
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        // Tear down any previous preview viewer (re-opening
        // the modal for a different artefact must not stack
        // viewers on top of each other).
        if (currentPreviewViewer) {
            try { currentPreviewViewer.destroy(); } catch (e) { /* ignore */ }
            currentPreviewViewer = null;
        }
        host.innerHTML = '';
        if (!(window.ej && window.ej.pdfviewer && window.ej.pdfviewer.PdfViewer)) {
            console.warn('Syncfusion PDF Viewer class not available yet.');
            return;
        }
        var originUrl = window.location.origin;
        var resourceUrl = originUrl + (window.appBasePath || '') + '/pdfviewer';
        try {
            var viewer = new window.ej.pdfviewer.PdfViewer({
                documentPath: url,
                resourceUrl: resourceUrl,
                enableClientSideRendering: true,
                height: '100%',
                width: '100%'
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
        // Delegate close clicks to the document so the
        // backdrop and the X button both work without
        // re-binding. The [data-pdf-preview-close] marker
        // is the single signal.
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (t && t.closest && t.closest('[data-pdf-preview-close]')) {
                closePdfPreviewModal();
            }
        });
        // Escape closes the modal when it is open. The
        // listener is always live but is a no-op when the
        // modal is hidden, so it does not interfere with
        // Escape on other inputs.
        document.addEventListener('keydown', function (e) {
            if (e && e.key === 'Escape') {
                var modal = document.getElementById('pdfPreviewModal');
                if (modal && modal.classList.contains('is-open')) {
                    closePdfPreviewModal();
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Action handlers
    // ------------------------------------------------------------------
    function onRunClicked(runBtn) {
        if (runBtn.disabled) { return; }
        var doc = activeDocument();
        if (!doc) { return; }
        runBtn.disabled = true;
        runBtn.textContent = 'Running...';
        runBtn.classList.add('running');
        // Mark the rest of this handler as a Run -> Review
        // transition so any documents-changed re-render that
        // fires before the final mode flip is suppressed.
        // Without this, setExtraction() would re-paint the
        // View page (Run button reappears, PDF viewer
        // remounts/resizes) for ~1s while we wait for the
        // /searchable-pdf round-trip to finish.
        suppressCentrePanelRender = true;
        apiExtract(doc.previewUrl, doc.sessionKey).then(function (result) {
            if (!result.ok || !result.payload) {
                throw new Error(failureMessage(result, 'Extraction failed.'));
            }
            // Commit the extraction result directly onto the
            // active document and persist it. We deliberately
            // avoid going through setExtraction() because that
            // helper emits 'documents-changed' which would
            // trigger the centre-panel re-render we just
            // suppressed. The eventual setMode('review') call
            // below paints the Review page with the new
            // extraction already in place, so the user never
            // sees the View page again.
            var idx = findDocIndex(doc.previewUrl);
            if (idx >= 0) {
                state.documents[idx].extraction = result.payload.extraction || null;
                if (result.payload.extraction) {
                    state.documents[idx].state = 'Searchable';
                }
                save();
                if (doc.previewUrl === state.activePreviewUrl) {
                    saveActiveExtraction(doc.previewUrl, result.payload.extraction);
                }
            }
            // Tear down the Syncfusion viewer BEFORE we flip
            // the mode. The Review page does not need a PDF
            // viewer; the View page does. Destroying it here
            // (rather than letting mountPdfViewer() destroy
            // + remount it during a re-render) is what
            // removes the resize/shrink flicker. The final
            // render() driven by setMode('review') will not
            // re-mount the viewer because mode != 'view'.
            if (currentPdfViewer) {
                try { currentPdfViewer.destroy(); } catch (e) { /* ignore */ }
                currentPdfViewer = null;
            }
            // Flip to Review first. This emits 'mode-changed'
            // which calls render() and paints the Review page
            // immediately with the new extraction. The
            // suppressCentrePanelRender guard is still in
            // effect, but render() runs from emit() only when
            // the guard is false; the guard is cleared after
            // the explicit render() below so the centre panel
            // gets a single, clean paint.
            setMode('review');
            // Now that the mode has flipped, release the
            // suppression and do one final explicit render so
            // the centre panel is definitely on Review (the
            // emit() in setMode would otherwise be skipped).
            suppressCentrePanelRender = false;
            try { render(); } catch (e) { console.error('render error', e); }
            // Fire the searchable-PDF generation in the
            // background. The Final step's download link
            // already tolerates this URL being absent, and
            // the user has already moved to Review so the
            // latency is invisible. setSearchablePreviewUrl
            // is the dedicated setter for this field (same
            // shape as setRedactedPreviewUrl) and applies
            // sanitizePreviewUrl so we never store a
            // double-PathBase-prefixed URL on a live
            // deployment.
            apiSearchable(doc.previewUrl, doc.sessionKey).then(function (sResult) {
                if (sResult.ok && sResult.payload && sResult.payload.previewUrl) {
                    setSearchablePreviewUrl(doc.previewUrl, sResult.payload.previewUrl);
                }
            }).catch(function () { /* best-effort */ });
        }).catch(function (err) {
            suppressCentrePanelRender = false;
            alert(err.message || 'Unable to run extraction.');
            runBtn.disabled = false;
            runBtn.textContent = 'Run OCR & Extraction';
            runBtn.classList.remove('running');
        });
    }

    function onContinueToRedactClicked() {
        var doc = activeDocument();
        if (!doc) { return; }
        // The user no longer needs to explicitly approve -
        // corrections recorded in the local workspace
        // propagate to all generated outputs. Mark the
        // review as completed anyway so the redaction and
        // final resume modes work correctly.
        doc.reviewApproved = true;
        save();
        emit('documents-changed', { documents: state.documents.slice() });
        setMode('redact');
    }

    function onApplyRedactionClicked() {
        var doc = activeDocument();
        if (!doc) { return; }
        var items = [];
        var checks = document.querySelectorAll('.redact-item-check:checked');
        for (var i = 0; i < checks.length; i++) {
            items.push({
                field: checks[i].getAttribute('data-field') || '',
                value: checks[i].getAttribute('data-value') || ''
            });
        }
        if (items.length === 0) {
            alert('Select at least one item to redact.');
            return;
        }
        // Also send the (corrected) values from state.corrections
        // so the server bounds lookup matches the latest user
        // edit.
        var itemsForServer = items.map(function (it) {
            var corrected = state.corrections[it.field];
            return { field: it.field, value: corrected || it.value };
        });
        // The new /redact endpoint takes the extraction rows as
        // raw JSON strings so the server can resolve bounds
        // client-side. Send the cached rows straight through.
        var rows = (doc.extraction && doc.extraction.rows) || [];
        var rowsAsJson = rows.map(function (r) { return JSON.stringify(r); });
        var btn = document.getElementById('applyRedactionBtn');
        if (btn) { btn.disabled = true; }
        apiRedact({
            previewUrl: doc.previewUrl,
            searchablePreviewUrl: doc.searchablePreviewUrl || '',
            extractionRows: rowsAsJson,
            items: itemsForServer
        }, doc.sessionKey).then(function (result) {
            if (!result.ok || !result.payload || !result.payload.success) {
                throw new Error(failureMessage(result, 'Redaction failed.'));
            }
            setRedactedPreviewUrl(
                doc.previewUrl,
                result.payload.redactedPreviewUrl,
                result.payload.processedPreviewUrl || doc.searchablePreviewUrl
            );
            setMode('final');
        }).catch(function (err) {
            alert(err.message || 'Unable to apply redaction.');
            if (btn) { btn.disabled = false; }
        });
    }

    function onGenerateProcessedPdfClicked() {
        var doc = activeDocument();
        if (!doc) { return; }
        var btn = document.getElementById('generateProcessedPdfBtn');
        var status = document.getElementById('generateProcessedPdfStatus');
        if (btn) { btn.disabled = true; }
        if (status) { status.style.display = 'inline-flex'; }
        apiProcessedPdf(doc.previewUrl, doc.sessionKey).then(function (result) {
            if (!result.ok || !result.payload || !result.payload.previewUrl) {
                throw new Error(failureMessage(result, 'Generation failed.'));
            }
            // Route through the dedicated setter so the
            // stored URL is sanitized the same way as the
            // background apiSearchable path. Without this
            // the manual button could leave a
            // double-PathBase-prefixed URL on the document
            // and the Final-step Preview/Download would
            // 404.
            setSearchablePreviewUrl(doc.previewUrl, result.payload.previewUrl);
        }).catch(function (err) {
            alert(err.message || 'Unable to generate the searchable PDF.');
            if (btn) { btn.disabled = false; }
        }).then(function () {
            if (status) { status.style.display = 'none'; }
        });
    }

    // ------------------------------------------------------------------
    // Packet list renderer (left sidebar)
    // ------------------------------------------------------------------
    function renderPacketList() {
        var list = document.getElementById('packetPanelList');
        if (!list) { return; }
        var docs = state.documents.slice();
        // Also include the three default templates from the server
        // so the user can pick one even before they have
        // materialised it. We fetch them lazily and cache.
        apiGetTemplates().then(function (payload) {
            var templates = (payload && Array.isArray(payload.templates)) ? payload.templates : [];
            // Build a map of materialised docs by their template
            // fileName. The server returns the same fileName
            // for both the template and its materialised copy
            // (only the on-disk path gains a hash suffix), so
            // equality is the simple, reliable signal.
            var byTemplateName = {};
            var orphans = [];
            for (var d = 0; d < docs.length; d++) {
                var dName = docs[d].fileName;
                var matched = false;
                for (var tt = 0; tt < templates.length; tt++) {
                    if (templates[tt].fileName === dName) { matched = true; break; }
                }
                if (matched) { byTemplateName[dName] = docs[d]; }
                else { orphans.push(docs[d]); }
            }
            // Walk the templates in the order the server
            // returned them. For each template: if a
            // materialised copy exists, render the copy in
            // place; otherwise render the template ghost. This
            // keeps the packet order stable - a file does not
            // jump position when the user clicks it.
            var html = '';
            for (var t = 0; t < templates.length; t++) {
                var tpl = templates[t];
                var materialised = byTemplateName[tpl.fileName];
                if (materialised) {
                    html += renderPacketItem({
                        fileName: materialised.fileName,
                        displayName: materialised.displayName || materialised.fileName,
                        fileType: materialised.fileType,
                        fileSize: materialised.fileSize,
                        pageCount: materialised.pageCount,
                        previewUrl: materialised.previewUrl,
                        progress: computeProgress(materialised),
                        isActive: materialised.previewUrl === state.activePreviewUrl
                    });
                } else {
                    html += renderPacketItem({
                        fileName: tpl.fileName,
                        displayName: tpl.displayName || tpl.fileName,
                        fileType: tpl.fileType || 'PDF',
                        fileSize: tpl.fileSize || 0,
                        pageCount: tpl.pageCount || 0,
                        previewUrl: '',
                        isTemplate: true,
                        progress: { hasChosen: false, hasViewed: false, hasExtraction: false, hasReviewApproved: false, hasRedacted: false, hasFinal: false }
                    });
                }
            }
            // Any materialised doc that does not match a
            // server-known template (e.g. user upload) is
            // appended at the end so the user can still see
            // and switch to it.
            for (var o = 0; o < orphans.length; o++) {
                var oDoc = orphans[o];
                html += renderPacketItem({
                    fileName: oDoc.fileName,
                    displayName: oDoc.displayName || oDoc.fileName,
                    fileType: oDoc.fileType,
                    fileSize: oDoc.fileSize,
                    pageCount: oDoc.pageCount,
                    previewUrl: oDoc.previewUrl,
                    progress: computeProgress(oDoc),
                    isActive: oDoc.previewUrl === state.activePreviewUrl
                });
            }
            if (!html) {
                html = '<div class="packet-panel-empty">No documents in the packet yet. Add one with the "Add files" link above.</div>';
            }
            list.innerHTML = html;
            wirePacketItems(list);
        }).catch(function () {
            list.innerHTML = '<div class="packet-panel-empty">Unable to load documents. Please refresh the page.</div>';
        });
    }

    function currentSessionKey() {
        try {
            var parts = (document.cookie || '').split(';');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i].trim();
                if (p.indexOf('ci_session=') === 0) {
                    return decodeURIComponent(p.substring('ci_session='.length));
                }
            }
        } catch (e) { /* ignore */ }
        return '';
    }

    function renderPacketItem(item) {
        var isActive = !!item.isActive;
        var currentMode = (state.activeMode || '').toLowerCase();
        var isLocked = !isActive && currentMode !== 'choose' && currentMode !== '';
        var resume = resumeModeFromProgress(item.progress);
        return ''
            + '<button type="button" role="listitem" '
            +   'class="packet-panel-item ' + (isActive ? 'is-active' : '') + (isLocked ? ' is-locked' : '') + '" '
            +   'data-file-name="' + ui.escapeHtml(item.fileName) + '" '
            +   'data-display-name="' + ui.escapeHtml(item.displayName) + '" '
            +   'data-template="' + (item.isTemplate ? '1' : '0') + '" '
            +   'data-preview-url="' + ui.escapeHtml(item.previewUrl) + '" '
            +   'data-resume-mode="' + ui.escapeHtml(resume) + '"'
            +   (isLocked ? ' aria-disabled="true" data-locked="1" title="Return to the Workspace home to switch files."' : '')
            + '>'
            +   '<div class="packet-panel-item-icon" aria-hidden="true">'
            +     '<span class="packet-panel-item-glyph">' + ui.escapeHtml(ui.getFileTypeAbbreviation(item.fileType)) + '</span>'
            +   '</div>'
            +   '<div class="packet-panel-item-body">'
            +     '<div class="packet-panel-item-name">' + ui.escapeHtml(item.fileName) + '</div>'
            +     '<div class="packet-panel-item-meta">'
            +       '<span class="packet-panel-item-type">' + ui.escapeHtml(item.fileType) + '</span>'
            +     '</div>'
            +   '</div>'
            + '</button>';
    }

    function resumeModeFromProgress(p) {
        if (!p) { return ''; }
        if (p.hasFinal || p.hasRedacted) { return 'final'; }
        if (p.hasReviewApproved) { return 'redact'; }
        if (p.hasExtraction) { return 'review'; }
        if (p.hasViewed || p.hasChosen) { return 'view'; }
        return '';
    }

    function wirePacketItems(list) {
        var items = list.querySelectorAll('.packet-panel-item');
        for (var i = 0; i < items.length; i++) {
            // Clicking a packet item just selects it. The
            // user then clicks "Process the selected file"
            // (or "Continue where you left off") on the
            // Choose view to actually open the document.
            items[i].addEventListener('click', makePacketClick(items[i]));
        }
    }

    function makePacketClick(button) {
        return function (event) {
            if (button.getAttribute('data-locked') === '1') { event.preventDefault(); return; }
            var fileName = button.getAttribute('data-file-name') || '';
            var displayName = button.getAttribute('data-display-name') || fileName;
            var isTemplate = button.getAttribute('data-template') === '1';
            var previewUrl = button.getAttribute('data-preview-url') || '';
            // Lock the list while the round-trip is in flight.
            var list = document.getElementById('packetPanelList');
            if (list) {
                var btns = list.querySelectorAll('.packet-panel-item');
                for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; }
            }
            var p;
            if (isTemplate || !previewUrl) {
                p = pickTemplate({ fileName: fileName, displayName: displayName, fileType: 'PDF' });
            } else {
                // Already in the packet - reuse the existing
                // doc's rich state (extraction, badge, redaction
                // outputs) rather than synthesising a fresh
                // descriptor that would force mergeDoc() to
                // reset everything to "OCR required".
                var existing = null;
                for (var d = 0; d < state.documents.length; d++) {
                    if (state.documents[d].previewUrl === previewUrl) {
                        existing = state.documents[d];
                        break;
                    }
                }
                if (existing) {
                    p = Promise.resolve({
                        fileName: existing.fileName,
                        displayName: existing.displayName || existing.fileName,
                        previewUrl: existing.previewUrl,
                        fileType: existing.fileType || 'PDF',
                        fileSize: existing.fileSize || 0,
                        pageCount: existing.pageCount || 0,
                        isUserUploaded: !!existing.isUserUploaded,
                        state: existing.state,
                        extraction: existing.extraction,
                        searchablePreviewUrl: existing.searchablePreviewUrl,
                        redactedPreviewUrl: existing.redactedPreviewUrl,
                        reviewApproved: !!existing.reviewApproved
                    });
                } else {
                    // Defensive fallback: the sidebar has a
                    // previewUrl but state.documents does not.
                    // Synthesise a minimal descriptor and let
                    // addDocument normalise it.
                    p = Promise.resolve({
                        fileName: fileName,
                        displayName: displayName,
                        previewUrl: previewUrl,
                        fileType: 'PDF',
                        fileSize: 0,
                        pageCount: 0,
                        isUserUploaded: false,
                        state: 'OcrRequired'
                    });
                }
            }
            p.then(function (doc) {
                addDocument(doc);
                setActiveDocument(doc.previewUrl);
                // Drop the user back on the Choose view so
                // they can see the scenario context and the
                // "Process the selected file" CTA. The
                // resume mode is what they'll jump to when
                // they click the button.
                if (list) {
                    var btns2 = list.querySelectorAll('.packet-panel-item');
                    for (var j = 0; j < btns2.length; j++) { btns2[j].disabled = false; }
                }
                setMode('choose');
            }).catch(function (err) {
                alert(err.message || 'Unable to choose that file.');
                if (list) {
                    var btns3 = list.querySelectorAll('.packet-panel-item');
                    for (var k = 0; k < btns3.length; k++) { btns3[k].disabled = false; }
                }
            });
        };
    }

    // ------------------------------------------------------------------
    // Sidebar review-mode renderer
    //
    // The left sidebar lists one button per workflow mode
    // (Workspace home, Document viewer, Extraction review,
    // Redaction studio, Output center). The static markup
    // in Index.cshtml ships all of them clickable, but the
    // stepper rules dictate that some modes must only be
    // reachable from specific pages. We mirror those rules
    // here so the sidebar matches the stepper: on the Review
    // page the Redaction Studio and Output Center buttons are
    // disabled and un-clickable, the only way to leave Review
    // is the in-page "Continue to Redaction" button.
    //
    // The rule that gates a sidebar item is read from its
    // data-needs-* attribute. The two values we honour today
    // are:
    //   data-needs-doc         -> a document must be active
    //   data-needs-extraction  -> extraction must be done
    //   data-needs-review-approved -> user must have clicked
    //                                "Continue to Redaction"
    // ------------------------------------------------------------------
    function renderSidebarModes() {
        var doc = activeDocument();
        var p = computeProgress(doc);
        var items = document.querySelectorAll('.review-mode-item');
        for (var i = 0; i < items.length; i++) {
            var btn = items[i];
            var mode = btn.getAttribute('data-mode') || '';
            var enabled = isModeReachable(mode, doc, p);
            // Use a custom marker (not the native `disabled`
            // attribute) so the buttons keep their normal
            // visual state. The click handler in
            // Index.cshtml checks this marker to decide
            // whether to navigate.
            if (enabled) {
                btn.removeAttribute('data-blocked');
                btn.removeAttribute('title');
            } else {
                btn.setAttribute('data-blocked', '1');
                btn.setAttribute('title', modeGateReason(mode));
            }
        }
    }

    function isModeReachable(mode, doc, p) {
        if (mode === 'choose') { return true; }
        if (!doc) { return false; }
        if (mode === 'view') { return true; }
        if (mode === 'review') { return !!(p && p.hasExtraction); }
        // Redact and Final are gated on reviewApproved -
        // the user must explicitly advance past Review by
        // clicking "Continue to Redaction". hasExtraction
        // alone is not enough.
        if (mode === 'redact' || mode === 'final') { return !!(p && p.hasReviewApproved); }
        return false;
    }

    function modeGateReason(mode) {
        if (mode === 'redact' || mode === 'final') {
            // When the user is on the Review page, the most
            // likely reason these are locked is they have not
            // yet clicked "Continue to Redaction". That is the
            // message we want to surface so the user knows
            // there is one explicit advance step between
            // Review and Redact.
            return 'Click "Continue to Redaction" on the Review page first.';
        }
        if (mode === 'view' || mode === 'review') {
            return 'Run extraction first to unlock this step.';
        }
        return 'This step is not available right now.';
    }

    // ------------------------------------------------------------------
    // Header + stepper renderer
    // ------------------------------------------------------------------
    function renderHeader() {
        var ctx = document.getElementById('smart-doc-header-context');
        if (ctx) {
            var active = activeDocument();
            ctx.textContent = active ? active.fileName : 'Select a file from the packet to begin';
        }
    }

    function renderStepper() {
        var doc = activeDocument();
        var p = computeProgress(doc);
        var steps = ['choose', 'view', 'extract', 'review', 'redact', 'final'];
        // The stepper is driven by the current page / workflow
        // stage, NOT by the mere fact that a file has been
        // selected. The set of steps the user has *reached*
        // comes from the active mode (their current page) plus
        // any persisted extraction / review / redaction outputs
        // for the active document. Once they have progressed
        // past a step, that step is shown as completed; the
        // step they are on now is shown as active; everything
        // after stays as a numbered, un-completed placeholder.
        var mode = (state.activeMode || '').toLowerCase();
        var reachedIndex = -1; // index into `steps` of the highest reached step
        if (doc) {
            // A document is always considered to have "reached"
            // Choose (the user has just selected it). Whether
            // it has reached View and beyond is governed by
            // where they have been / what the server has
            // produced for the doc.
            reachedIndex = 0;
            if (mode === 'view' || mode === 'extract' || mode === 'review' || mode === 'redact' || mode === 'final'
                || p.hasExtraction || p.hasReviewApproved || p.hasRedacted || p.hasFinal) {
                reachedIndex = 1; // view
            }
            if (p.hasExtraction || mode === 'extract' || mode === 'review' || mode === 'redact' || mode === 'final') {
                reachedIndex = 2; // extract
            }
            if (p.hasExtraction || p.hasReviewApproved || mode === 'review' || mode === 'redact' || mode === 'final') {
                reachedIndex = 3; // review
            }
            if (p.hasRedacted || mode === 'redact' || mode === 'final') {
                reachedIndex = 4; // redact
            }
            if (p.hasFinal) {
                reachedIndex = 5; // final
            }
        }
        // The current active step is the page the user is on
        // (or Choose when no document / empty mode).
        var activeIndex;
        if (!doc) {
            activeIndex = 0; // Choose when nothing has been picked yet
        } else if (mode === 'view') {
            activeIndex = 1;
        } else if (mode === 'extract') {
            activeIndex = 2;
        } else if (mode === 'review') {
            activeIndex = 3;
        } else if (mode === 'redact') {
            activeIndex = 4;
        } else if (mode === 'final') {
            activeIndex = 5;
        } else {
            // No mode set yet (or the Choose page is showing)
            // - the active step is Choose itself, not View.
            activeIndex = 0;
        }
        var completed = 0;
        for (var i = 0; i < steps.length; i++) {
            var el = document.getElementById('step-' + steps[i]);
            if (!el) { continue; }
            var circle = el.querySelector('.workflow-circle');
            el.classList.remove('active', 'completed');
            // A step is "done" only when the user has reached
            // it (or any later step). A step is "active" when
            // it is the current page. Otherwise it stays in
            // its initial numbered, un-completed state.
            var done = doc && i <= reachedIndex && i !== activeIndex;
            var isActive = doc && i === activeIndex;
            if (done) {
                el.classList.add('completed');
                if (circle) { circle.textContent = '\u2713'; }
                completed++;
            } else {
                if (circle) { circle.textContent = String(i + 1); }
            }
            if (isActive) {
                el.classList.add('active');
            }
            // Clickable rules: a step is clickable when the
            // user has reached it (or any earlier step is
            // reachable). Choose is always clickable (workspace
            // home). View becomes clickable as soon as a
            // document has been picked (the user can navigate
            // back to it). Extract / Review become clickable
            // once extraction has produced data for the
            // document. Redact and Final (Package) only become
            // clickable after the user has explicitly advanced
            // past Review by clicking "Continue to Redaction"
            // (i.e. doc.reviewApproved === true). Without this
            // gate, the user could skip the explicit
            // confirmation step and jump straight to the
            // Redaction studio or Output center from the
            // Review page.
            var clickable = (steps[i] === 'choose')
                || (doc && steps[i] === 'view')
                || (doc && p.hasExtraction && (steps[i] === 'extract' || steps[i] === 'review'))
                || (doc && p.hasReviewApproved && (steps[i] === 'redact' || steps[i] === 'final'));
            if (clickable) {
                el.classList.add('clickable');
                el.classList.remove('disabled');
                el.setAttribute('aria-disabled', 'false');
                el.setAttribute('data-href', window.appUrl('/?mode=' + (steps[i] === 'choose' ? 'choose' : steps[i])));
            } else {
                el.classList.add('disabled');
                el.classList.remove('clickable');
                el.setAttribute('aria-disabled', 'true');
            }
        }
        var countEl = document.getElementById('workflow-count');
        if (countEl) { countEl.textContent = completed + ' of 6 steps complete'; }
    }

    // ------------------------------------------------------------------
    // Migration banner (spec §9)
    // ------------------------------------------------------------------
    function maybeShowMigrationBanner() {
        if (!detectLegacySession()) { return; }
        var banner = document.createElement('div');
        banner.className = 'quota-banner session-format-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = ''
            + '<div class="quota-banner-text">'
            +   '<strong>Session format changed.</strong> '
            +   'The demo now keeps your work in this browser. Please re-pick your file to continue.'
            + '</div>'
            + '<button type="button" class="quota-banner-close" aria-label="Dismiss">\u00d7</button>';
        document.body.appendChild(banner);
        banner.querySelector('.quota-banner-close').addEventListener('click', function () {
            if (banner.parentNode) { banner.parentNode.removeChild(banner); }
            // Wipe the leftover server session keys so the
            // banner does not reappear on refresh.
            try {
                document.cookie = 'ci_session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
            } catch (e) { /* ignore */ }
        });
        // Also wipe the per-session folder on disk so the user
        // does not see leftover files when they re-pick.
        apiWipe().catch(function () { /* best-effort */ });
    }

    // ------------------------------------------------------------------
    // Reset (called by the header button)
    //
    // Soft reset: keep every file in the packet (default
    // templates + user uploads) and only clear the
    // per-document progress - extraction, searchable PDF,
    // redacted PDF, review approval, last-viewed page, and
    // any field corrections / redaction selections.
    // Each document's progress fields are reset in place so
    // its id, fileName, previewUrl, fileType, fileSize,
    // pageCount, isUserUploaded, addedAt, and displayName
    // all survive. The active document is unhooked and the
    // UI is sent back to the Choose view.
    //
    // The server-side generated/ subfolder is wiped via
    // /api/claim-intake/reset-progress so the orphaned
    // searchable / redacted PDFs do not accumulate on disk
    // between runs. The ci_session cookie is NOT rotated,
    // so the preserved previewUrls still resolve to the
    // same per-session folder.
    // ------------------------------------------------------------------
    function reset() {
        var ok = window.confirm('Reset workflow progress? Files in the packet will be kept, but every document will return to its initial "OCR required" state.');
        if (!ok) { return; }

        // Tear down any mounted viewer BEFORE we clear the
        // documents. The Run handler already destroyed it on
        // the View -> Review transition, but a reset from
        // Review or Final needs the same treatment - the
        // EJ2 controls must not outlive the document that
        // owns them.
        if (currentPdfViewer) {
            try { currentPdfViewer.destroy(); } catch (e) { /* ignore */ }
            currentPdfViewer = null;
        }
        // Close the preview modal too, in case the user
        // opened it from the Final page and then hit Reset.
        try { closePdfPreviewModal(); } catch (e) { /* ignore */ }

        // Walk every document and strip ONLY the progress
        // fields. Everything else (id, fileName, previewUrl,
        // fileType, fileSize, pageCount, isUserUploaded,
        // addedAt, displayName) is preserved so the packet
        // list still shows the user's files in the same
        // order with the same badges and metadata.
        for (var i = 0; i < state.documents.length; i++) {
            var d = state.documents[i];
            d.state = 'OcrRequired';
            d.extraction = null;
            d.searchablePreviewUrl = '';
            d.redactedPreviewUrl = '';
            d.reviewApproved = false;
            d.lastViewedPage = 0;
        }
        // The corrections map and the redaction selection
        // apply to whichever doc was active when they were
        // recorded. After a reset there is no active doc and
        // no extraction to correct / redact, so both go.
        state.corrections = {};
        state.selectedItemIds = [];
        // Unhook the active document. After this point
        // state.activePreviewUrl === '' and the centre
        // panel renders the Choose view (no document
        // selected) - which is exactly what the user sees
        // the first time they open the demo.
        state.activePreviewUrl = '';
        state.activeFileName = '';
        state.activeMode = 'choose';

        // Best-effort server cleanup. We do NOT block the
        // UI on this - the client is already in the right
        // state, and a stale searchable/redacted PDF on
        // disk will simply never be linked from the UI
        // again (it has no corresponding state.documents
        // entry). The endpoint is idempotent and safe to
        // call repeatedly.
        apiResetProgress().catch(function () { /* best-effort */ });

        // Persist the cleared state. save() emits the
        // 'documents-changed' event which re-paints the
        // packet list, stepper, and header in one pass.
        // We also explicitly emit 'mode-changed' so the
        // centre panel flips to the Choose view and
        // renderPacketList() (which is mode-sensitive
        // for its lock/unlock state) re-renders.
        save();
        emit('documents-changed', { documents: state.documents.slice() });
        emit('mode-changed', { mode: 'choose' });
    }
    // Auto-select the first default template on a fresh launch.
    function autoPickFirstTemplate() {
        return apiGetTemplates().then(function (payload) {
            var list = (payload && Array.isArray(payload.templates)) ? payload.templates : [];
            if (list.length === 0) { return null; }
            // Bail if the user navigated or the packet
            // became non-empty while the templates fetch
            // was in flight - never trample existing state.
            if (state.documents.length > 0) { return null; }
            var tpl = list[0];
            return pickTemplate({
                fileName: tpl.fileName,
                displayName: tpl.displayName || tpl.fileName,
                fileType: tpl.fileType || 'PDF',
                fileSize: tpl.fileSize || 0,
                pageCount: tpl.pageCount || 0
            }).then(function (doc) {
                // Re-check state - the user could have
                // uploaded a file in the meantime.
                if (state.documents.length > 0) { return null; }
                var added = addDocument(doc);
                if (!added) { return null; }
                // Mark the document as the active selection
                // (drives the blue-border highlight in the
                // left packet panel) and pin the mode to
                // 'choose' so the centre panel keeps showing
                // the Workspace home with the "Process the
                // selected file" CTA rather than jumping
                // straight into the View step.
                setActiveDocument(added.previewUrl);
                setMode('choose');
                return added;
            });
        }).catch(function () {
            // If the templates fetch or materialise call
            // fails, fall through to the empty Choose view.
            // The user can still pick a template manually
            // once the network is back.
            return null;
        });
    }

    // ------------------------------------------------------------------
    // Boot
    // ------------------------------------------------------------------
    function boot() {
        load();
        // Fire-and-forget: refresh SESSION_LIFETIME_MS from the
        // server so subsequent save() calls stamp the right
        // expiresAt. The default (2h) is already correct until
        // this resolves, so an early save() is not at risk of
        // using a shorter lifetime than intended.
        loadSessionPolicy();
        // Honour the ?mode=... query string so deep links
        // (?mode=review, ?mode=final) restore the user to the
        // right step. The mode in the URL is a hint, not a
        // source of truth - the in-memory state still wins.
        try {
            var qs = window.location.search || '';
            var m = /[?&]mode=([^&]+)/.exec(qs);
            if (m) {
                var requested = decodeURIComponent(m[1]).toLowerCase();
                if (MODES.indexOf(requested) >= 0) {
                    state.activeMode = requested;
                }
            }
        } catch (e) { /* ignore */ }
        // The server-rendered HTML still pre-populates a few things
        // (the stepper, the header). We overwrite them now.
        renderHeader();
        renderStepper();
        renderSidebarModes();
        renderPacketList();
        render();
        // Wire the PDF preview modal's close affordances
        // once on boot. The modal host lives in
        // Index.cshtml and is page-scoped, so a single
        // delegation is enough - we never need to re-wire
        // it when the centre panel re-renders. Backdrop
        // click and Escape both close it; the close
        // button is data-attributed so any element with
        // [data-pdf-preview-close] acts as a dismisser.
        wirePdfPreviewModalClose();
        // Populate the centre-panel "Packet contents" table
        // on first launch so the default templates are
        // visible immediately, then keep it in sync on
        // every state change.
        refreshPacketContentsTable();
        maybeShowMigrationBanner();

        if (state.documents.length === 0) {
            autoPickFirstTemplate();
        }
        // Re-render packet list + stepper on every state change.
        on('documents-changed', function () { renderPacketList(); renderStepper(); renderHeader(); renderSidebarModes(); refreshPacketContentsTable(); });
        on('active-changed', function () { renderPacketList(); renderStepper(); renderHeader(); renderSidebarModes(); refreshPacketContentsTable(); });
        on('mode-changed', function () { renderPacketList(); renderStepper(); renderSidebarModes(); refreshPacketContentsTable(); });
        on('wipe', function () { refreshPacketContentsTable(); renderSidebarModes(); });
        on('redaction-changed', function () { /* no-op, render() already called */ });
        on('correction-changed', function () { /* no-op */ });
        on('eviction', function (payload) {
            showBanner('Some older files were removed to keep the workspace under storage. Active file kept.');
        });
        on('quota-exceeded', function () {
            showBanner('The active document is too large for browser storage. Re-run extraction or pick a smaller file.');
        });
    }

    function showBanner(text) {
        var banner = document.createElement('div');
        banner.className = 'quota-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = ''
            + '<div class="quota-banner-text">' + ui.escapeHtml(text) + '</div>'
            + '<button type="button" class="quota-banner-close" aria-label="Dismiss">\u00d7</button>';
        document.body.appendChild(banner);
        banner.querySelector('.quota-banner-close').addEventListener('click', function () {
            if (banner.parentNode) { banner.parentNode.removeChild(banner); }
        });
        setTimeout(function () {
            if (banner.parentNode) { banner.parentNode.removeChild(banner); }
        }, 6000);
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    var api = {
        // state
        get state() { return state; },
        // persistence
        save: save,
        load: load,
        wipe: wipe,
        // mutation
        addDocument: addDocument,
        removeDocument: removeDocument,
        setActiveDocument: setActiveDocument,
        setMode: setMode,
        setExtraction: setExtraction,
        setRedactionItems: setRedactionItems,
        applyCorrection: applyCorrection,
        setRedactedPreviewUrl: setRedactedPreviewUrl,
        setSearchablePreviewUrl: setSearchablePreviewUrl,
        // queries
        activeDocument: activeDocument,
        findDocIndex: findDocIndex,
        resumeMode: resumeMode,
        // server round-trips
        apiGetTemplates: apiGetTemplates,
        apiUpload: apiUpload,
        apiUploadDefaultTemplate: apiUploadDefaultTemplate,
        apiExtract: apiExtract,
        apiSearchable: apiSearchable,
        apiRedact: apiRedact,
        apiProcessedPdf: apiProcessedPdf,
        apiWipe: apiWipe,
        apiResetProgress: apiResetProgress,
        pickTemplate: pickTemplate,
        pickUploadedFile: pickUploadedFile,
        // rendering
        render: render,
        renderPacketList: renderPacketList,
        renderStepper: renderStepper,
        renderHeader: renderHeader,
        renderSidebarModes: renderSidebarModes,
        refreshPacketContentsTable: refreshPacketContentsTable,
        // indexeddb
        idbPut: idbPut,
        idbGet: idbGet,
        idbClear: idbClear,
        // events
        on: on,
        emit: emit,
        // actions
        reset: reset,
        // ui helpers
        ui: ui
    };

    window.claimIntake = api;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
