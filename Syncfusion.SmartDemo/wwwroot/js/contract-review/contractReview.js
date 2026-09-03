// ============================================================================
// contractReview.js
//
// Client-side state owner for the Contract Review demo. Mirrors
// the design of claimIntake.js: localStorage-backed packet, the
// server is a dumb pipeline runner, the browser owns everything
// workflow-related (mode, packet, change log, exported PDF URL,
// active DOCX editor instance). The server endpoints exist only
// to (1) hand the negotiated DOCX to the editor after a
// Compare call and (2) render the accepted DOCX to PDF.
//
// Modes (matches the stepper):
//   'import'  - left packet + sides selector; the user picks
//               which DOCX plays the original/revised role.
//   'compare' - side-by-side DOCX editors. Left is a read-only
//               preview of the original; right holds the
//               negotiated (track-changed) DOCX with Accept /
//               Reject controls and an in-memory change log.
//   'summary' - placeholder card summarising the negotiated
//               outcomes; will host the AI summary in phase 2.
//   'export'  - EJ2 PDF viewer + Download buttons for the
//               reviewed contract PDF and (phase 2) the summary
//               PDF.
//
// Public surface (window.claimContractReview):
//   state, save(), load(), wipe(), reset(),
//   addDocument(doc), removeDocument(id),
//   setOriginal(doc), setRevised(doc),
//   setMode(mode),
//   uploadFile(file), runCompare(), exportPdf(),
//   render(), on(event, fn) / emit(event, payload)
// ============================================================================
(function () {
    'use strict';

    var STORAGE_KEY = 'claimContractReview.packet.v1';
    var SCHEMA_VERSION = 1;
    var MODES = ['', 'import', 'compare', 'summary', 'export'];
    // Same Syncfusion DocumentEditor service URL used
    // by the Compare view. The AI summary page mounts a
    // read-only DocumentEditorContainer with the same
    // serviceUrl so the user can read the AI-generated
    // DOCX in the same editor surface.
    var documentEditorServiceUrl = 'https://document.syncfusion.com/web-services/docx-editor/api/documenteditor/';

    var listeners = Object.create(null);
    var state = emptyPacket();

    // Cached server template list.
    var cachedTemplates = [];
    var templatesPromise = null;
    // Session lifetime for localStorage sliding expiry.
    var SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;
    var policyPromise = null;

    // EJ2 DocumentEditor instances + boot state. Mounted lazily
    // only on entering Compare mode. Right pane has
    // track-changes + the beforeAcceptRejectChanges handler
    // that drives our change log.
    var docxEditorLeft = null;
    var docxEditorRight = null;
    var docxMounted = false;
    // True once both panes have content; comparedDocId is the
    // negotiated DOCX previewUrl we should remember to clean up
    // when the user resets.
    var compared = false;
    // True while the auto-render kicked off by
    // renderExport() is in flight. Prevents duplicate
    // /api/contract-review/export-pdf calls when the
    // centre panel re-renders for an unrelated reason
    // (e.g. a change-log entry arrives) while we are
    // still waiting for the server to render the PDF.
    var exporting = false;

    // ---------------------------------------------------------------
    // Empty packet factory
    // ---------------------------------------------------------------
    function emptyPacket() {
        return {
            schemaVersion: SCHEMA_VERSION,
            expiresAt: Date.now() + SESSION_LIFETIME_MS,
            activeMode: 'import',
            step: 0,
            // Per-step progress flags. Persisted so the
            // stepper can paint completed steps green even
            // when the user navigates back to a previous
            // step (e.g. returning to Compare after AI
            // summary has finished should leave AI summary
            // showing as a green completed chip, not a
            // disabled grey one). Mirrors the per-step
            // progress fields claimIntake.js writes onto
            // each document (extraction, reviewApproved,
            // redactedPreviewUrl).
            compareCompleted: false,
            summaryCompleted: false,
            exportCompleted: false,
            // The last mode the user actually progressed
            // past. Used by the Import view to render a
            // "Continue where you left off" button that
            // jumps the user back to their deepest step.
            // Tracks a *strictly advanced* mode, not just
            // the current one, so the Import CTA keeps
            // pointing at the furthest step even when the
            // user clicked back to Import manually.
            lastAdvancedMode: 'import',
            // Two slots: original side + revised side
            originalPreviewUrl: '',
            originalDisplayName: '',
            originalFileName: '',
            revisedPreviewUrl: '',
            revisedDisplayName: '',
            revisedFileName: '',
            // Negotiated DOCX after WordDocument.Compare
            negotiatedPreviewUrl: '',
            negotiatedDisplayName: '',
            // PDF export URL (server-rendered from final DOCX)
            changeLog: [],
            // PDF export URL (server-rendered from final DOCX)
            pdfPreviewUrl: '',
            pdfFileName: '',
            // AI summary artefacts. The SFDT is the
            // payload the EJ2 DocumentEditor on the AI
            // summary page opens directly; the previewUrl
            // is the server-rendered DOCX the Export page
            // downloads / previews.
            aiSummarySfdt: '',
            aiSummaryHtml: '',
            aiSummaryPreviewUrl: '',
            aiSummaryFileName: '',
            aiSummaryEntryCount: 0,
            // 'idle' | 'generating' | 'ready' | 'error'
            // - idle:    nothing generated yet for this
            //            session (or the change log is empty)
            // - generating: a /ai-summary call is in flight
            // - ready:   SFDT + DOCX are on hand
            // - error:   last attempt failed
            aiSummaryStatus: 'idle',
            aiSummaryError: '',
            // AI summary PDF. The Export page only
            // offers PDF download/preview for the AI
            // summary now (the user's edited DOCX is
            // rendered to PDF via DocIORenderer on the
            // server in parallel with the reviewed-
            // contract PDF render). The DOCX itself is
            // not surfaced on the Export page.
            aiSummaryPdfPreviewUrl: '',
            aiSummaryPdfFileName: '',
            // AI summary EDITED DOCX. Server-persisted copy
            // of the user's edited AI summary (last Save
            // or Proceed to Export). openAiSummaryDocx
            // prefers this URL over aiSummaryPreviewUrl so
            // the user's edits survive a navigate-away-
            // and-back round trip. Cleared by
            // resetCompareProgress() so a fresh Compare
            // run starts from the original AI DOCX again.
            aiSummaryEditedDocxPreviewUrl: '',
            aiSummaryEditedDocxFileName: '',
            // Documents the user uploaded/copied from templates
            documents: []
        };
    }

    // ---------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------
    function save() {
        state.expiresAt = Date.now() + SESSION_LIFETIME_MS;
        try {
            var json = JSON.stringify(state);
            localStorage.setItem(STORAGE_KEY, json);
            return true;
        } catch (e) {
            return false;
        }
    }

    function load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) { state = emptyPacket(); return; }
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') { state = emptyPacket(); return; }
            if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
                try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
                state = emptyPacket();
                return;
            }
            state = {
                schemaVersion: SCHEMA_VERSION,
                expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : Date.now() + SESSION_LIFETIME_MS,
                activeMode: MODES.indexOf(parsed.activeMode) >= 0 ? parsed.activeMode : 'import',
                step: typeof parsed.step === 'number' ? parsed.step : stepForMode(parsed.activeMode || 'import'),
                // Per-step completion flags. Treat as falsy
                // when missing so packets predating the
                // schema upgrade degrade gracefully to
                // "nothing completed yet" - the stepper will
                // rebuild its view from the live flags on
                // the next state change.
                compareCompleted: !!parsed.compareCompleted,
                summaryCompleted: !!parsed.summaryCompleted,
                exportCompleted: !!parsed.exportCompleted,
                // lastAdvancedMode is a hint, not a
                // contract: if it's missing or invalid,
                // fall back to the current activeMode.
                lastAdvancedMode: MODES.indexOf(parsed.lastAdvancedMode) >= 0 ? parsed.lastAdvancedMode : (MODES.indexOf(parsed.activeMode) >= 0 ? parsed.activeMode : 'import'),
                originalPreviewUrl: typeof parsed.originalPreviewUrl === 'string' ? parsed.originalPreviewUrl : '',
                originalDisplayName: typeof parsed.originalDisplayName === 'string' ? parsed.originalDisplayName : '',
                originalFileName: typeof parsed.originalFileName === 'string' ? parsed.originalFileName : '',
                revisedPreviewUrl: typeof parsed.revisedPreviewUrl === 'string' ? parsed.revisedPreviewUrl : '',
                revisedDisplayName: typeof parsed.revisedDisplayName === 'string' ? parsed.revisedDisplayName : '',
                revisedFileName: typeof parsed.revisedFileName === 'string' ? parsed.revisedFileName : '',
                negotiatedPreviewUrl: typeof parsed.negotiatedPreviewUrl === 'string' ? parsed.negotiatedPreviewUrl : '',
                negotiatedDisplayName: typeof parsed.negotiatedDisplayName === 'string' ? parsed.negotiatedDisplayName : '',
                pdfPreviewUrl: typeof parsed.pdfPreviewUrl === 'string' ? parsed.pdfPreviewUrl : '',
                pdfFileName: typeof parsed.pdfFileName === 'string' ? parsed.pdfFileName : '',
                changeLog: Array.isArray(parsed.changeLog) ? parsed.changeLog.slice(-50) : [],
                // AI summary artefacts. Treated as
                // optional on the persisted packet so
                // older sessions (predating this feature)
                // degrade cleanly. Status defaults to
                // 'idle' which lets the page auto-trigger
                // generation on the next AI summary visit.
                aiSummarySfdt: typeof parsed.aiSummarySfdt === 'string' ? parsed.aiSummarySfdt : '',
                aiSummaryHtml: typeof parsed.aiSummaryHtml === 'string' ? parsed.aiSummaryHtml : '',
                aiSummaryPreviewUrl: typeof parsed.aiSummaryPreviewUrl === 'string' ? parsed.aiSummaryPreviewUrl : '',
                aiSummaryFileName: typeof parsed.aiSummaryFileName === 'string' ? parsed.aiSummaryFileName : '',
                aiSummaryEntryCount: typeof parsed.aiSummaryEntryCount === 'number' ? parsed.aiSummaryEntryCount : 0,
                aiSummaryStatus: (function (s) {
                    return s === 'generating' || s === 'ready' || s === 'error' || s === 'idle'
                        ? s
                        : 'idle';
                })(parsed.aiSummaryStatus),
                aiSummaryError: typeof parsed.aiSummaryError === 'string' ? parsed.aiSummaryError : '',
                // AI summary PDF fields degrade cleanly
                // when the persisted packet predates the
                // PDF-on-Export feature: the Export
                // page just re-runs the parallel
                // conversion on the next "Proceed to
                // Export" click.
                aiSummaryPdfPreviewUrl: typeof parsed.aiSummaryPdfPreviewUrl === 'string' ? parsed.aiSummaryPdfPreviewUrl : '',
                aiSummaryPdfFileName: typeof parsed.aiSummaryPdfFileName === 'string' ? parsed.aiSummaryPdfFileName : '',
                // Edited-DOCX fields degrade cleanly when
                // the persisted packet predates the
                // rehydration feature: openAiSummaryDocx
                // falls back to the original AI model output
                // on the next visit, exactly as before.
                aiSummaryEditedDocxPreviewUrl: typeof parsed.aiSummaryEditedDocxPreviewUrl === 'string' ? parsed.aiSummaryEditedDocxPreviewUrl : '',
                aiSummaryEditedDocxFileName: typeof parsed.aiSummaryEditedDocxFileName === 'string' ? parsed.aiSummaryEditedDocxFileName : '',
                documents: Array.isArray(parsed.documents) ? parsed.documents.filter(function (d) {
                    return d && typeof d.previewUrl === 'string';
                }) : []
            };
        } catch (e) {
            state = emptyPacket();
        }
    }

    function wipe() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        // Reset the in-memory `compared` flag too - this
        // is the live signal that compare has been run in
        // the current session. The emptyPacket() factory
        // already clears the per-step completion flags and
        // lastAdvancedMode, so the stepper returns to
        // grey and the Import CTA hides until the user
        // re-runs Compare.
        compared = false;
        // Clear the dedupe key for openAiSummaryDocx
        // so the next visit to the AI summary step
        // re-loads from state.aiSummaryPreviewUrl
        // (the original AI model output) instead of
        // skipping the load because the dedupe key
        // still matches the URL that is no longer in
        // state.
        aiSummaryLoadedUrl = '';
        // Reset the dirty flag too. The next visit
        // to the AI summary step will load a fresh
        // DOCX into a freshly mounted editor, so
        // "dirty" should mean "user edited the new
        // document" - not "user edited the previous
        // document before Reset".
        aiSummaryDirty = false;
        // Clear the in-flight auto-render guard too.
        // Without this, a Reset fired while a render is
        // in flight would leave exporting=true, and the
        // next visit to Export would silently skip the
        // auto-render because the guard thinks a render
        // is still pending.
        exporting = false;
        // Tear down the AI summary editor so the next
        // visit to the AI summary step starts clean.
        destroyAiSummaryEditor();
        aiSummaryInFlight = false;
        state = emptyPacket();
        emit('wipe', {});
    }

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------
    function on(event, fn) {
        if (!listeners[event]) { listeners[event] = []; }
        listeners[event].push(fn);
    }
    function emit(event, payload) {
        var arr = listeners[event] || [];
        for (var i = 0; i < arr.length; i++) {
            try { arr[i](payload); } catch (e) {}
        }
        // Always persist + re-render on any state change.
        if (event !== 'wipe') { save(); }
    }

    function stepForMode(mode) {
        if (mode === 'compare') return 2;
        if (mode === 'summary') return 3;
        if (mode === 'export') return 4;
        return 1;
    }

    // ---------------------------------------------------------------
    // setMode / state mutators
    // ---------------------------------------------------------------
    function setMode(mode) {
        if (MODES.indexOf(mode) < 0) { return; }
        // Block forward navigation until prerequisites met.
        if (mode === 'compare' && (!state.originalPreviewUrl || !state.revisedPreviewUrl)) { return; }
        if (mode === 'summary' && !compared) { return; }
        if (mode === 'export' && (!state.changeLog.length || !state.negotiatedPreviewUrl)) {
            // Allow export even with no Accept/Reject (the user
            // may inspect the negotiated DOCX without edits)
            // provided compare ran.
            if (!state.negotiatedPreviewUrl) { return; }
        }
        state.activeMode = mode;
        state.step = stepForMode(mode);
        // Track the deepest mode the user has reached. This
        // is what the Import view reads to render the
        // "Continue where you left off" button. We only
        // advance lastAdvancedMode, never regress it - the
        // button always points at the furthest step, even
        // when the user has clicked back to Import
        // manually. lastAdvancedMode is also what the
        // stepper uses to paint completed steps as green
        // when the user returns to a previous step.
        if (stepIndex(mode) > stepIndex(state.lastAdvancedMode || 'import')) {
            state.lastAdvancedMode = mode;
        }
        // Mark the step the user is leaving as completed.
        // The stepper paints completed steps green even
        // when the user is on a later step (so the user
        // can see their progress at a glance) and also
        // when the user comes back to a previous step
        // (so the green status is sticky, not transient).
        // 'compare' is marked completed when the user
        // moves past Compare (to summary or export), not
        // when they land on Compare.
        if (mode === 'summary' || mode === 'export') {
            state.compareCompleted = true;
        }
        if (mode === 'summary') {
            state.summaryCompleted = true;
        }
        if (mode === 'export') {
            state.summaryCompleted = true;
            state.exportCompleted = true;
        }
        save();
        emit('mode-changed', { mode: mode });
        render();
    }

    function setOriginal(doc) {
        if (!doc || !doc.previewUrl) { return; }
        addDocument(doc);
        // A document can only play one of the two roles; if the
        // user re-picks the same file on both sides we keep the
        // revised assignment (most recent assignment wins).
        // Replacing either side invalidates the negotiated
        // DOCX, the change log, and the rendered PDF (the
        // compare result and the export were built from the
        // *previous* pair of files). The per-step completion
        // flags are also reset so the stepper returns to
        // grey until the user runs Compare again. The
        // lastAdvancedMode pointer is *not* regressed: it
        // still reflects how far the user got last time, and
        // the Import CTA keeps offering a resume path -
        // re-running Compare will flip the green chips
        // back on again.
        var isReplacement = state.originalPreviewUrl && state.originalPreviewUrl !== doc.previewUrl;
        state.originalPreviewUrl = doc.previewUrl;
        state.originalDisplayName = doc.displayName || doc.fileName;
        state.originalFileName = doc.fileName || state.originalFileName;
        if (isReplacement) {
            resetCompareProgress();
        }
        emit('original-changed', { document: doc });
        render();
    }

    function setRevised(doc) {
        if (!doc || !doc.previewUrl) { return; }
        addDocument(doc);
        var isReplacement = state.revisedPreviewUrl && state.revisedPreviewUrl !== doc.previewUrl;
        state.revisedPreviewUrl = doc.previewUrl;
        state.revisedDisplayName = doc.displayName || doc.fileName;
        state.revisedFileName = doc.fileName || state.revisedFileName;
        if (isReplacement) {
            resetCompareProgress();
        }
        emit('revised-changed', { document: doc });
        render();
    }

    // Soft-reset the per-compare artefacts. Used when the
    // user replaces one of the two sides on the Import
    // view: the previous compare result, change log, and
    // rendered PDF no longer correspond to the current
    // pair of files, so the stepper should walk back to
    // grey until the user runs Compare again. Mirrors the
    // claimIntake "soft reset" pattern that strips only
    // the per-document progress fields on Reset, leaving
    // the file metadata intact.
    function resetCompareProgress() {
        state.negotiatedPreviewUrl = '';
        state.negotiatedDisplayName = '';
        state.pdfPreviewUrl = '';
        state.pdfFileName = '';
        state.changeLog = [];
        // The change log is the source of truth for the
        // AI summary, so wiping it invalidates the AI
        // summary artefacts too. We also tear the AI
        // summary editor down so the next visit to the
        // AI summary step starts from an empty editor.
        state.aiSummarySfdt = '';
        state.aiSummaryHtml = '';
        state.aiSummaryPreviewUrl = '';
        state.aiSummaryFileName = '';
        state.aiSummaryEntryCount = 0;
        state.aiSummaryStatus = 'idle';
        state.aiSummaryError = '';
        // Reset the AI summary PDF too - the previous
        // PDF was rendered from the previous change
        // log, so it no longer corresponds to the
        // current pair of files.
        state.aiSummaryPdfPreviewUrl = '';
        state.aiSummaryPdfFileName = '';
        // Reset the AI summary EDITED DOCX too. The
        // user's edits were made against the previous
        // change log; replaying them on a fresh compare
        // run would attach stale hand-typed text to a
        // fresh AI summary. Bytes on disk are not
        // deleted here; they become unreachable and are
        // cleaned up by the per-session wipe.
        state.aiSummaryEditedDocxPreviewUrl = '';
        state.aiSummaryEditedDocxFileName = '';
        // Clear the openAiSummaryDocx dedupe key so the
        // next mount does not short-circuit on a stale
        // URL still cached in aiSummaryLoadedUrl.
        // destroyAiSummaryEditor() below also drops it,
        // but this explicit clear documents the intent.
        aiSummaryLoadedUrl = '';
        // Drop the dirty flag too. The next mount
        // will load a fresh DOCX into a fresh
        // editor; aiSummaryDirty should only become
        // true when the user edits THAT document,
        // not when they edit the previous one
        // before replacing a file.
        aiSummaryDirty = false;
        destroyAiSummaryEditor();
        aiSummaryInFlight = false;
        // Tear down the live compare editors if they are
        // mounted - their underlay is the previous
        // negotiated DOCX which no longer matches the
        // current pair. Without this, switching files
        // and clicking Run compare would mount a new
        // pair on top of the old editors and produce
        // duplicate chrome.
        try { if (window.claimContractReviewCompare && window.claimContractReviewCompare.destroy) { window.claimContractReviewCompare.destroy(); } } catch (e) { /* ignore */ }
        // Reset the per-step completion flags so the
        // stepper returns to grey. We also reset
        // lastAdvancedMode to 'import' so the Import CTA
        // ("Continue where you left off") hides until the
        // user re-runs Compare. The previous workflow's
        // "resume" point no longer applies - the user
        // just changed the inputs.
        compared = false;
        // Bump the auto-render guard too. If the user
        // replaces a file while the Export page's
        // auto-render is still in flight, the next
        // visit to Export should re-trigger the render
        // (for the new file pair) rather than no-op
        // because exporting is still true.
        exporting = false;
        state.compareCompleted = false;
        state.summaryCompleted = false;
        state.exportCompleted = false;
        state.lastAdvancedMode = 'import';
        // If the user was on a step beyond Compare when
        // they replaced a file, send them back to Import
        // so they cannot sit on a step whose data is
        // gone. Import is the only step that is still
        // consistent with the new file pair.
        if (state.activeMode === 'compare' || state.activeMode === 'summary' || state.activeMode === 'export') {
            state.activeMode = 'import';
            state.step = stepForMode('import');
        }
    }

    function addDocument(doc) {
        if (!doc || !doc.previewUrl) { return; }
        for (var i = 0; i < state.documents.length; i++) {
            if (state.documents[i].previewUrl === doc.previewUrl) {
                state.documents[i] = merge(state.documents[i], doc);
                emit('documents-changed', { documents: state.documents.slice() });
                return state.documents[i];
            }
        }
        state.documents.push(doc);
        emit('documents-changed', { documents: state.documents.slice() });
    }

    function merge(prev, next) {
        return {
            previewUrl: prev.previewUrl || next.previewUrl,
            fileName: next.fileName || prev.fileName,
            displayName: next.displayName || prev.displayName,
            fileType: next.fileType || prev.fileType,
            fileSize: next.fileSize || prev.fileSize,
            side: next.side || prev.side,
            sourceTemplate: next.sourceTemplate || prev.sourceTemplate
        };
    }

    function pushChangeLog(entry) {
        state.changeLog.push(entry);
        if (state.changeLog.length > 50) {
            state.changeLog = state.changeLog.slice(-50);
        }
        emit('change-log', { entry: entry, log: state.changeLog.slice() });
    }

    function reset() {
        // Soft reset - keep the packet, clear mode + cache only
        // after a server wipe. The hard reset (server wipe)
        // also rotates the ci_session cookie.
        window.claimContractReviewCompare.destroy();
        // Close the PDF preview modal too, in case the user
        // opened it from the Final page and then hit Reset.
        // Mirrors claimIntake.js: tear the EJ2 viewer down so
        // it does not outlive the document it is showing.
        try { closePdfPreviewModal(); } catch (e) { /* ignore */ }
        apiWipe()
            .then(function () {
                wipe();
                render();
                // Mirror the first-launch behaviour: after
                // the wipe rotates the session cookie, mint
                // a fresh pickedSessionKey so the two default
                // template picks land under the same
                // per-session folder as the new cookie. If
                // we kept the previous key the body would
                // disagree with the (now-rotated) cookie
                // and the server could orphan one of the
                // uploads.
                pickedSessionKey = null;
                // Re-prime the two default templates on the
                // Import view, exactly the way boot() does
                // on first load. This is what the user
                // asked for: hitting Reset should return
                // them to the Import page with the
                // Original + Revised DOCX slots already
                // populated, ready to "Run compare" again
                // without them having to re-pick manually.
                autoLoadContractTemplates();
            })
            .catch(function () {
                wipe();
                render();
                // Best-effort even if the server wipe
                // failed: the cookie may still be valid
                // (or already gone) but the new picks
                // either way land somewhere readable.
                pickedSessionKey = null;
                autoLoadContractTemplates();
            });
    }

    // ---------------------------------------------------------------
    // API calls
    // ---------------------------------------------------------------
    function safeJson(r) {
        return r.text().then(function (text) {
            var looksJson = (r.headers.get('content-type') || '').indexOf('application/json') >= 0;
            try {
                return { ok: r.ok, status: r.status, payload: text ? JSON.parse(text) : null };
            } catch (e) {
                return { ok: r.ok, status: r.status, payload: null, parseError: e.message, snippet: text && text.substring(0, 200) };
            }
        });
    }
    function failureMessage(env, fallback) {
        if (env && env.payload && env.payload.message) { return env.payload.message; }
        if (env && env.status) { return fallback + ' (server returned ' + env.status + ').'; }
        return fallback;
    }

    function apiGetTemplates() {
        if (templatesPromise) { return templatesPromise; }
        templatesPromise = fetch(window.appUrl('/api/contract-review/templates'), {
            method: 'GET', headers: { 'Accept': 'application/json' }, credentials: 'same-origin'
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok) { throw new Error(failureMessage(env, 'Could not list templates')); }
                var ts = (env.payload && env.payload.templates) ? env.payload.templates : [];
                cachedTemplates = ts;
                return env.payload;
            })
            .catch(function (err) {
                templatesPromise = null;
                throw err;
            });
        return templatesPromise;
    }

    // Per-session key the client mints once and
    // sends on every /upload-by-template call. This
    // is what keeps two parallel picks in the same
    // per-session folder: the server's
    // AdoptSessionKey() primes the per-request cache
    // + the outbound ci_session cookie to this
    // value, so both responses carry the SAME
    // Set-Cookie and the next request (compare,
    // preview, etc.) can read both files.
    //
    // Without this, two parallel /upload-by-template
    // calls land under two different keys and the
    // editor 404s on the second file ("Could not
    // download the DOCX for the editor.").
    var pickedSessionKey = null;
    function ensurePickedSessionKey() {
        if (pickedSessionKey) { return pickedSessionKey; }
        // 32 hex chars, matches the server's
        // IsValidSessionKey() guard (16-128 chars,
        // URL-safe).
        var bytes = new Uint8Array(16);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (var i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); }
        }
        var hex = '';
        for (var j = 0; j < bytes.length; j++) {
            var h = bytes[j].toString(16);
            if (h.length < 2) { h = '0' + h; }
            hex += h;
        }
        pickedSessionKey = hex;
        return pickedSessionKey;
    }

    function apiPickTemplate(template) {
        if (!template || !template.fileName) { return Promise.reject(new Error('Template missing.')); }
        return fetch(window.appUrl('/api/contract-review/upload-by-template'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                fileName: template.fileName,
                sessionKey: ensurePickedSessionKey()
            })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Could not materialise template'));
                }
                return env.payload;
            });
    }

    function apiUpload(file) {
        var form = new FormData();
        form.append('document', file, file.name);
        return fetch(window.appUrl('/api/contract-review/upload'), {
            method: 'POST', credentials: 'same-origin', body: form
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Upload failed'));
                }
                return env.payload;
            });
    }

    function apiRunCompare() {
        return fetch(window.appUrl('/api/contract-review/compare'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                originalPreviewUrl: state.originalPreviewUrl,
                revisedPreviewUrl: state.revisedPreviewUrl,
                author: 'Counterparty'
            })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Compare failed'));
                }
                return env.payload;
            });
    }

    function apiExportPdf(docxBase64) {
        return fetch(window.appUrl('/api/contract-review/export-pdf'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ docxBase64: docxBase64 })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'PDF export failed'));
                }
                return env.payload;
            });
    }

    // Convert the live AI summary DOCX (the user's
    // edited copy) into a PDF on the server. Used by
    // the "Proceed to Export" button on the AI summary
    // page in parallel with the reviewed-contract PDF
    // render. The server uses DocIORenderer.ConvertToPDF
    // and persists the result in the per-session
    // Generated subfolder.
    function apiExportAiSummaryPdf(docxBase64) {
        return fetch(window.appUrl('/api/contract-review/ai-summary-pdf'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ docxBase64: docxBase64 })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'AI summary PDF export failed'));
                }
                return env.payload;
            });
    }

    // Persist the live AI summary DOCX on the server so
    // the editor can rehydrate from the user's edited
    // copy on a later visit. Each call mints a fresh
    // Guid; the previous edited DOCX is left on disk and
    // garbage-collected by the per-session wipe.
    function apiSaveAiSummaryDocx(docxBase64) {
        return fetch(window.appUrl('/api/contract-review/ai-summary-save-docx'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ docxBase64: docxBase64 })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'AI summary DOCX save failed'));
                }
                return env.payload;
            });
    }

    // POST the live SFDT (serialised by
    // container.documentEditor.serialize()) to
    // /api/contract-review/ai-summary-save-pdf. The
    // server parses the SFDT into a Word document
    // via SfdtIngestor and renders it to PDF via
    // DocIORenderer.ConvertToPDF. Mirrors the
    // Syncfusion reference pattern for
    // /api/documenteditor/ExportPdf exactly. The
    // body shape `{ content: "<sfdt-string>" }`
    // matches the Syncfusion `SaveParameter` DTO
    // from the reference sample.
    // -----------------------------------------------------------------
    // AI summary generation
    //
    // The Compare view's beforeAcceptRejectChanges
    // handler pushes one row per Accept / Reject into
    // state.changeLog, with the live SFDT content
    // snapshot, author, action type and timestamp. The
    // AI summary step POSTs that log to
    // /api/contract-review/ai-summary; the server runs
    // the AI agent, converts the resulting HTML to DOCX
    // via Syncfusion DocIO, persists the DOCX in the
    // per-session Generated subfolder, and returns the
    // SFDT envelope so the EJ2 DocumentEditor on the AI
    // summary page can `open(sfdt)` directly.
    // -----------------------------------------------------------------
    function apiGenerateAiSummary(entries) {
        return fetch(window.appUrl('/api/contract-review/ai-summary'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ entries: entries })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'AI summary generation failed'));
                }
                return env.payload;
            });
    }

    // Drive the AI summary generation end-to-end. Called
    // from renderSummary() when the page mounts. The
    // summary is one-shot per Compare run - the AI summary
    // page no longer offers a Regenerate button, so this
    // function is only ever invoked automatically by the
    // page mount path. State transitions: idle -> generating
    // -> ready | error. The in-flight flag is module-scoped
    // so a re-render kicked off by an unrelated state change
    // (e.g. a change-log entry arrives) cannot stack two
    // parallel requests.
    var aiSummaryInFlight = false;
    var aiSummaryGenerationPromise = null;
    function ensureAiSummary(opts) {
        opts = opts || {};
        if (aiSummaryInFlight) { return aiSummaryGenerationPromise || Promise.resolve(null); }
        // Already ready and the user did not explicitly
        // ask to regenerate - nothing to do.
        if (!opts.force && state.aiSummaryStatus === 'ready' && state.aiSummarySfdt) {
            return Promise.resolve(state.aiSummarySfdt);
        }
        if (!state.changeLog.length) {
            state.aiSummaryStatus = 'idle';
            return Promise.resolve(null);
        }
        aiSummaryInFlight = true;
        state.aiSummaryStatus = 'generating';
        state.aiSummaryError = '';
        aiSummaryGenerationPromise = apiGenerateAiSummary(state.changeLog)
            .then(function (payload) {
                state.aiSummarySfdt = payload.sfdt || '';
                state.aiSummaryHtml = payload.summaryHtml || '';
                state.aiSummaryPreviewUrl = payload.previewUrl || '';
                state.aiSummaryFileName = payload.fileName || '';
                state.aiSummaryEntryCount = payload.entryCount || state.changeLog.length;
                state.aiSummaryStatus = 'ready';
                return payload.sfdt;
            })
            .catch(function (err) {
                state.aiSummaryStatus = 'error';
                state.aiSummaryError = (err && err.message) ? err.message : 'AI summary failed.';
                throw err;
            })
            .then(function (val) {
                aiSummaryInFlight = false;
                aiSummaryGenerationPromise = null;
                return val;
            }, function (err) {
                aiSummaryInFlight = false;
                aiSummaryGenerationPromise = null;
                throw err;
            });
        return aiSummaryGenerationPromise;
    }

    // -----------------------------------------------------------------
    // AI summary DocumentEditor mount / teardown
    //
    // The AI summary page hosts an EJ2 DocumentEditor
    // container so the user can read the AI-generated
    // DOCX in the same editor surface as the Compare
    // view. We mount lazily (only on entering the AI
    // summary step) and destroy the instance when
    // leaving the page so the editor's heavy canvas
    // doesn't pin memory while the user is on
    // Import / Compare / Export.
    //
    // The SFDT we get back from /api/contract-review/
    // ai-summary is produced by our server-side
    // SfdtEmitter, which emits a minimal-but-valid EJ2
    // SFDT envelope. Calling documentEditor.open()
    // directly with that string works in some EJ2
    // builds but spins a permanent loading indicator
    // in others (the editor does a second
    // capability check against serviceUrl and never
    // resolves). The robust path is the one the
    // Compare view already uses:
    //   1. fetch the persisted DOCX bytes from
    //      state.aiSummaryPreviewUrl,
    //   2. POST them to
    //      {serviceUrl}/Import to let the Syncfusion
    //      service produce a definitive SFDT,
    //   3. call documentEditor.open(sfdt).
    // This is what loadAiSummaryDocxFromUrl() below
    // does; the editor's behaviour is identical to
    // the Compare view's left/right panes.
    // -----------------------------------------------------------------
    var aiSummaryEditor = null;
    var aiSummaryEditorMounted = false;
    var aiSummaryLoadInFlight = null;
    var aiSummaryLoadedUrl = '';
    // Dirty-since-mount flag. Flipped to true the
    // first time the user types into the live editor
    // after a fresh document load. On a revisit where
    // the workflow has already completed, the
    // "Proceed to Export" CTA is hidden until this
    // flag becomes true, so a single keystroke is
    // what reopens the CTA. Reset to false in three
    // places: ensureAiSummaryEditorMount (fresh mount
    // into a new host), destroyAiSummaryEditor
    // (teardown), and loadAiSummaryDocxFromUrl's open()
    // call (the editor's own contentChange fires
    // immediately after open() to acknowledge the
    // load - we suppress that one event so the dirty
    // flag does not start true).
    var aiSummaryDirty = false;
    // One-shot suppression flag for the
    // contentChange event. Set to true just before
    // editor.documentEditor.open(sfdt) and back to
    // false immediately after. The EJ2 editor fires
    // a contentChange event as soon as open() is
    // called, regardless of whether the document
    // content actually changed - without the guard
    // a freshly-loaded revisit would pre-reveal the
    // CTA before the user has typed anything.
    var aiSummarySuppressingChange = false;
    function ensureAiSummaryEditorMount() {
        if (aiSummaryEditorMounted && aiSummaryEditor) { return Promise.resolve(); }
        if (typeof ej === 'undefined' || !ej.documenteditor || !ej.documenteditor.DocumentEditorContainer) {
            return Promise.reject(new Error('EJ2 DocumentEditor library has not loaded yet.'));
        }
        var host = document.getElementById('crAiSummaryEditorHost');
        if (!host) {
            return Promise.reject(new Error('AI summary editor host is not mounted yet.'));
        }
        try {
            if (aiSummaryEditor) {
                try { aiSummaryEditor.destroy(); } catch (e) { /* ignore */ }
                aiSummaryEditor = null;
            }
            while (host.firstChild) { host.removeChild(host.firstChild); }
            // The editor is ALWAYS editable on the AI
            // summary page, even on a revisit after the
            // workflow has completed. The previous
            // revisit restriction (restrictEditing=true
            // + isReadOnly=true + nav-only toolbar) is
            // intentionally removed: the user wants to
            // be able to make hand-typed edits to a
            // frozen artefact and have the
            // "Proceed to Export" CTA reappear the
            // moment they type a single character.
            // The dirty-since-mount flag (aiSummaryDirty)
            // is reset at the bottom of this function
            // and flipped back to true by the EJ2
            // contentChange handler wired up here, so
            // the "first keystroke reopens the CTA"
            // behaviour is independent of how long the
            // editor has been on screen.
            var isRevisit = !!(state.pdfPreviewUrl && state.aiSummaryPdfPreviewUrl);
            aiSummaryEditor = new ej.documenteditor.DocumentEditorContainer({
                height: '100%',
                width: '100%',
                serviceUrl: documentEditorServiceUrl,
                enableToolbar: true,
                showPropertiesPane: false,
                // Editing is enabled on the AI summary
                // page in BOTH the first-visit and
                // revisit paths so the user can refine
                // the generated DOCX before exporting
                // (or re-export after revisiting). We
                // deliberately do NOT set
                // restrictEditing here: that flag is
                // the EJ2 "protect document" feature
                // (password / form-fields) and overlays
                // a "Restricted mode" banner on top of
                // the document, which is not what we
                // want. isReadOnly is left at its
                // default (false) so the user gets a
                // caret, can type, and can apply
                // formatting from the toolbar.
                restrictEditing: false
            });
            aiSummaryEditor.appendTo(host);
            // The full toolbar (Insert, Format, etc.)
            // is always appropriate on the AI summary
            // page now that the editor is editable in
            // both first-visit and revisit. There is
            // no longer a "nav-only" revisit toolbar:
            // the user can refine the DOCX, then
            // re-trigger the PDF render via the
            // "Proceed to Export" CTA, which only
            // shows on revisit once the editor
            // registers a content change.
            aiSummaryEditor.toolbarItems = [
                'New', 'Open', 'Separator',
                'Undo', 'Redo', 'Separator',
                'Image', 'Table', 'Hyperlink', 'Bookmark', 'Comments', 'TableOfContents', 'Separator',
                'Header', 'Footer', 'PageSetup', 'PageNumber', 'Break', 'Separator',
                'Find', 'Separator', 'LocalClipboard', 'RestrictEditing'
            ];
            if (aiSummaryEditor.documentEditor) {
                aiSummaryEditor.documentEditor.isReadOnly = false;
                // Reset the dirty flag on every fresh
                // mount. The previous instance was
                // destroyed, so any earlier edits are
                // gone - the editor is starting from
                // the on-disk DOCX, not from the
                // user's hand-typed state. We also
                // wire the contentChange handler here
                // so a single keystroke on the
                // (initially hidden) CTA flips
                // aiSummaryDirty and reveals the
                // "Proceed to Export" button in place.
                aiSummaryDirty = false;
                try {
                    aiSummaryEditor.documentEditor.contentChange = function () {
                        // Skip the very first
                        // contentChange that fires
                        // immediately after open() -
                        // that is the editor
                        // acknowledging the document
                        // was loaded, NOT the user
                        // typing. The guard prevents
                        // a stale "user edited"
                        // signal from showing the CTA
                        // on a freshly-loaded revisit
                        // before the user has typed
                        // anything.
                        if (aiSummarySuppressingChange) { return; }
                        if (aiSummaryDirty) { return; }
                        aiSummaryDirty = true;
                        revealProceedExportOnDirty();
                    };
                } catch (e) { /* older EJ2 builds: no-op */ }
            }
            aiSummaryEditorMounted = true;
            return Promise.resolve();
        }
        catch (e) {
            return Promise.reject(new Error('Could not initialise the AI summary editor: ' + (e && e.message ? e.message : e)));
        }
    }

    function destroyAiSummaryEditor() {
        if (aiSummaryEditor) {
            try { aiSummaryEditor.destroy(); } catch (e) { /* ignore */ }
            aiSummaryEditor = null;
        }
        aiSummaryEditorMounted = false;
        aiSummaryLoadInFlight = null;
        aiSummaryLoadedUrl = '';
        // Drop the dirty flag on teardown. The
        // next mount starts from the on-disk DOCX
        // (not from the user's hand-typed state),
        // so aiSummaryDirty should be false until
        // the user actually types in the new
        // editor instance.
        aiSummaryDirty = false;
        var host = document.getElementById('crAiSummaryEditorHost');
        if (host) { while (host.firstChild) { host.removeChild(host.firstChild); } }
    }

    // Fetch the AI summary DOCX from the per-session
    // Generated subfolder, hand it to the Syncfusion
    // /Import endpoint to produce a definitive SFDT,
    // and open the result in the editor. Same shape
    // as loadDocxFromUrl() in compareReview.js - the
    // Compare view's left + right panes use this
    // exact path and it works reliably.
    function loadAiSummaryDocxFromUrl(editor, url, name) {
        return fetch(window.appUrl(url), { credentials: 'same-origin' })
            .then(function (r) {
                if (!r.ok) { throw new Error('Could not download the AI summary DOCX (HTTP ' + r.status + ').'); }
                return r.blob();
            })
            .then(function (blob) {
                var form = new FormData();
                form.append('file', blob, name || 'ai-summary.docx');
                return fetch(documentEditorServiceUrl + 'Import', {
                    method: 'POST', body: form
                });
            })
            .then(function (r) {
                if (!r.ok) { throw new Error('Document service returned ' + r.status + '.'); }
                return r.text();
            })
            .then(function (sfdt) {
                if (!editor || !editor.documentEditor) { return false; }
                try {
                    // Suppress the spurious contentChange
                    // that EJ2 fires as soon as open()
                    // completes. The event is the editor
                    // acknowledging the load, NOT the
                    // user typing - we do not want it
                    // to flip aiSummaryDirty and reveal
                    // the CTA on a freshly-loaded
                    // revisit before the user has typed
                    // anything.
                    aiSummarySuppressingChange = true;
                    try {
                        editor.documentEditor.open(sfdt);
                    } finally {
                        // Reset on the next tick so the
                        // suppressed event is dropped
                        // but the user's NEXT keystroke
                        // still fires the handler.
                        setTimeout(function () { aiSummarySuppressingChange = false; }, 0);
                    }
                    if (name) { try { editor.documentEditor.documentName = name; } catch (e) { /* ignore */ } }
                    return true;
                } catch (e) {
                    aiSummarySuppressingChange = false;
                    console.warn('AI summary editor open() failed', e);
                    return false;
                }
            });
    }

    // Load the AI summary DOCX into the live editor.
    // De-duplicated: a re-entry while a load is in flight
    // returns the same promise instead of stacking fetches.
    //
    // Source preference: the user's edited DOCX
    // (state.aiSummaryEditedDocxPreviewUrl, populated by
    // the last Proceed to Export or Save) over the original
    // AI model output (state.aiSummaryPreviewUrl). The
    // edited copy is what the user last had on screen; the
    // original AI DOCX would silently drop their edits.
    function openAiSummaryDocx() {
        if (!aiSummaryEditor) { return Promise.resolve(false); }
        if (aiSummaryLoadInFlight) { return aiSummaryLoadInFlight; }
        if (!state.aiSummaryPreviewUrl) { return Promise.resolve(false); }
        var url = state.aiSummaryEditedDocxPreviewUrl || state.aiSummaryPreviewUrl;
        var name = state.aiSummaryEditedDocxFileName || state.aiSummaryFileName || 'AI summary';
        // Do not reopen the source DOCX when Proceed to Export
        // checks readiness. Reopening here would replace the live
        // editor document and discard edits the user just made.
        if (aiSummaryLoadedUrl === url) { return Promise.resolve(true); }
        aiSummaryLoadInFlight = loadAiSummaryDocxFromUrl(aiSummaryEditor, url, name)
            .then(function (ok) {
                    if (ok) { aiSummaryLoadedUrl = url; }
                    aiSummaryLoadInFlight = null;
                    return ok;
                },
                  function (err) { aiSummaryLoadInFlight = null; throw err; });
        return aiSummaryLoadInFlight;
    }

    // Re-paint ONLY the AI summary status pill in
    // place. Called from the success / error branches
    // of the ensureAiSummary chain in renderSummary()
    // - re-running the full render would tear down the
    // EJ2 editor we just opened, and the user would
    // see a blank canvas with a "ready" pill.
    function repaintAiSummaryStatus() {
        var pill = document.querySelector('.cr-summary-status');
        if (!pill) { return; }
        var summaryStatus = state.aiSummaryStatus;
        var text;
        var cls;
        if (!state.changeLog.length) {
            text = 'No changes to summarise yet. Accept or reject a tracked change in the Compare step first.';
            cls = 'cr-summary-status--idle';
        } else if (summaryStatus === 'generating') {
            text = 'Generating AI summary from the change log\u2026';
            cls = 'cr-summary-status--busy';
        } else if (summaryStatus === 'ready') {
            var countLabel = state.aiSummaryEntryCount || state.changeLog.length;
            text = 'AI summary ready (' + countLabel + ' change' + (countLabel === 1 ? '' : 's') + '). The DOCX is open in the editor below.';
            cls = 'cr-summary-status--ready';
        } else if (summaryStatus === 'error') {
            text = 'AI summary failed: ' + (state.aiSummaryError || 'unknown error') + '. Go back to Compare and re-run to produce a fresh summary.';
            cls = 'cr-summary-status--error';
        } else {
            text = 'The AI summary will be generated automatically when you reach this step.';
            cls = 'cr-summary-status--idle';
        }
        pill.className = 'cr-summary-status ' + cls;
        pill.textContent = text;
    }

    function apiWipe() {
        return fetch(window.appUrl('/api/contract-review/wipe'), {
            method: 'POST', credentials: 'same-origin'
        })
            .then(function () { return; })
            .catch(function () { return; });
    }

    function loadSessionPolicy() {
        if (policyPromise) { return policyPromise; }
        policyPromise = fetch(window.appUrl('/api/contract-review/policy'), {
            method: 'GET', headers: { 'Accept': 'application/json' }, credentials: 'same-origin'
        })
            .then(function (r) { return r.json(); })
            .then(function (payload) {
                var ms = payload && typeof payload.sessionLifetimeMs === 'number' ? payload.sessionLifetimeMs : (2 * 60 * 60 * 1000);
                if (ms > 0) { SESSION_LIFETIME_MS = ms; }
                return SESSION_LIFETIME_MS;
            })
            .catch(function () { return SESSION_LIFETIME_MS; });
        return policyPromise;
    }

    function uploadFile(file, side) {
        // side is the explicit assignment from the new
        // import dropzones ('Original' or 'Revised'). When
        // omitted we fall back to the original auto-assign
        // behaviour (first upload -> Original, second ->
        // Revised) and use the filename heuristic as a
        // last resort.
        return apiUpload(file).then(function (payload) {
            var doc = {
                previewUrl: payload.previewUrl,
                fileName: payload.fileName,
                displayName: payload.displayName,
                fileType: payload.fileType,
                fileSize: payload.fileSize,
                side: side || payload.side || guess(file.name)
            };
            addDocument(doc);
            var assignedSide = side || (
                !state.originalPreviewUrl
                    ? 'Original'
                    : (!state.revisedPreviewUrl ? 'Revised' : doc.side)
            );
            if (assignedSide === 'Original') {
                setOriginal(doc);
            } else if (assignedSide === 'Revised') {
                setRevised(doc);
            } else if (!state.originalPreviewUrl) {
                setOriginal(doc);
            } else if (!state.revisedPreviewUrl) {
                setRevised(doc);
            }
            return doc;
        });
    }

    function guess(fileName) {
        var lower = (fileName || '').toLowerInvariant ? fileName.toLowerInvariant() : (fileName || '').toLowerCase();
        if (lower.indexOf('original') >= 0) return 'Original';
        if (lower.indexOf('redline') >= 0 || lower.indexOf('revised') >= 0) return 'Revised';
        return 'Either';
    }

    function pickTemplate(template) {
        return apiPickTemplate(template).then(function (payload) {
            var doc = {
                previewUrl: payload.previewUrl,
                fileName: payload.fileName,
                displayName: payload.displayName,
                fileType: payload.fileType,
                fileSize: payload.fileSize,
                side: payload.side || guess(payload.fileName),
                sourceTemplate: template.fileName
            };
            addDocument(doc);
            // Auto-assign templates to the side they advertise;
            // templates without a side go to whichever slot is
            // empty (preferring original if both open).
            if (doc.side === 'Original') {
                setOriginal(doc);
            } else if (doc.side === 'Revised') {
                setRevised(doc);
            } else if (!state.originalPreviewUrl) {
                setOriginal(doc);
            } else if (!state.revisedPreviewUrl) {
                setRevised(doc);
            }
            return doc;
        });
    }

    function runCompare() {
        if (!state.originalPreviewUrl || !state.revisedPreviewUrl) {
            throw new Error('Pick both an Original and a Revised document first.');
        }
        return window.claimContractReviewCompare.runCompare(
            state.originalPreviewUrl,
            state.revisedPreviewUrl,
            createCompareBridge()
        ).then(function () { setMode('compare'); });
    }

    function exportPdf() {
        var editorContainer = window.claimContractReviewCompare.getRightEditor();
        if (!editorContainer) {
            throw new Error('Run compare first to load the editor.');
        }
        // Pull the live DOCX bytes back via saveAsBlob.
        // Syncfusion's
        //   DocumentEditorContainer.documentEditor.saveAsBlob('Docx')
        // returns a Blob. Wrap that in a FileReader -> ArrayBuffer
        // -> base64 string for the server.
        if (!editorContainer.documentEditor || typeof editorContainer.documentEditor.saveAsBlob !== 'function') {
            throw new Error('The DOCX editor is not in a state that can export.');
        }
        return editorContainer.documentEditor.saveAsBlob('Docx').then(function (blob) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onerror = function () { reject(new Error('Could not read DOCX bytes.')); };
                reader.onload = function () {
                    var buffer = reader.result;
                    // The FileReader returns an ArrayBuffer when
                    // the blob is binary; to base64-encode the
                    // bytes without depending on a polyfill, we
                    // do it manually by byte-chunk.
                    var bytes = new Uint8Array(buffer);
                    var b64 = bytesToBase64(bytes);
                    resolve(b64);
                };
                reader.readAsArrayBuffer(blob);
            });
        })
        .then(function (b64) { return apiExportPdf(b64); })
        .then(function (payload) {
            state.pdfPreviewUrl = payload.previewUrl;
            state.pdfFileName = payload.fileName;
            // Mark Export as completed so the stepper
            // chip stays green when the user navigates
            // back to Compare or AI summary. The
            // pdfPreviewUrl is the secondary signal (the
            // stepper falls back to checking
            // state.pdfPreviewUrl) but the explicit flag
            // is what makes the green state sticky even
            // after the user clicks Reset's soft path
            // (the wipe() path clears both).
            state.exportCompleted = true;
            // Mark the deepest step the user has reached
            // - Export. lastAdvancedMode is what the
            // Import CTA reads to render "Continue where
            // you left off", so this is what makes the
            // CTA say "Continue to Export" after the
            // user has rendered a PDF.
            if (stepIndex('export') > stepIndex(state.lastAdvancedMode || 'import')) {
                state.lastAdvancedMode = 'export';
            }
            emit('pdf-ready', { payload: payload });
            // Suppress the centre-panel render when the
            // AI summary page owns the render lock.
            // exportPdf() is shared between the
            // Compare-page auto-render and the
            // Proceed-to-Export path on the AI summary
            // page. In the latter path, the handler
            // captures DOCX bytes from the live editor
            // BEFORE either PDF POST fires, then waits
            // on Promise.all. If we render() here while
            // exporting === true we tear down and
            // remount the EJ2 editor (renderCentre ->
            // renderSummary destroys and rebuilds the
            // AI summary editor canvas), producing a
            // visible editor-rebuild flash mid-render.
            // The handler performs the single
            // setMode('export') -> render() at the end,
            // so we just persist state and bail.
            // The Compare-page path leaves exporting
            // === false; render() runs as before so the
            // Export page lands with PDFs already on
            // disk.
            save();
            if (!exporting) {
                render();
            }
        });
    }

    // Capture the live AI summary DOCX from the
    // mounted EJ2 DocumentEditor and return it as
    // a base64 string. Mirrors the saveAsBlob +
    // FileReader + bytesToBase64 pipeline used in
    // exportPdf() above, but pulls from
    // `aiSummaryEditor` instead of the Compare
    // view's right editor. Returns null when the
    // editor is not mounted yet, in which case the
    // caller should fall back to the server-stored
    // DOCX (we re-fetch via /ai-summary-sfdt on the
    // server if needed). The fallback is not used
    // in the live flow because the AI summary
    // editor is always mounted by the time the user
    // can click "Proceed to Export" - the CTA only
    // appears once a change log exists, and the
    // page auto-mounts the editor on entry.
    function captureAiSummaryDocxBase64() {
        var editor = aiSummaryEditor;
        if (!editor || !editor.documentEditor || typeof editor.documentEditor.saveAsBlob !== 'function') {
            return Promise.resolve(null);
        }
        return editor.documentEditor.saveAsBlob('Docx').then(function (blob) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onerror = function () { reject(new Error('Could not read AI summary DOCX bytes.')); };
                reader.onload = function () {
                    var bytes = new Uint8Array(reader.result);
                    resolve(bytesToBase64(bytes));
                };
                reader.readAsArrayBuffer(blob);
            });
        });
    }

    function ensureAiSummaryEditorReady() {
        return ensureAiSummaryEditorMount()
            .then(function () {
                if (state.aiSummaryStatus === 'ready' && state.aiSummaryPreviewUrl) {
                    return openAiSummaryDocx();
                }
                return ensureAiSummary().then(function () {
                    return state.aiSummaryPreviewUrl ? openAiSummaryDocx() : false;
                });
            })
            .then(function (loaded) {
                if (!loaded || !aiSummaryEditor || !aiSummaryEditor.documentEditor) {
                    throw new Error('The AI summary editor is not ready yet.');
                }
                return aiSummaryEditor;
            });
    }

    // Render the AI summary DOCX (the user's edited
    // copy) to a PDF on the server. The bytes come
    // from the live EJ2 editor via
    // captureAiSummaryDocxBase64() so the PDF
    // reflects any edits the user made on the AI
    // summary page. Used by the "Proceed to Export"
    // button in parallel with the reviewed-contract
    // PDF render. The two requests fire
    // concurrently so the user only waits for the
    // slower of the two (typically 1-3s), not the
    // sum.
    function exportAiSummaryPdf() {
        return captureAiSummaryDocxBase64().then(function (b64) {
            if (!b64) {
                throw new Error('The AI summary editor is not ready yet.');
            }
            return apiExportAiSummaryPdf(b64);
        }).then(function (payload) {
            state.aiSummaryPdfPreviewUrl = payload.previewUrl || '';
            state.aiSummaryPdfFileName = payload.fileName || '';
            return payload;
        });
    }

    // Save button click handler (toolbar item
    // `crSaveAiSummary`). Captures the live DOCX
    // from the editor and POSTs it to the server's
    // /ai-summary-pdf endpoint, which decodes the
    // base64 DOCX bytes and renders them straight
    // to PDF via DocIORenderer.ConvertToPDF. The
    // user can hit Save any number of times to
    // refresh the PDF after additional edits; the
    // Export page picks up the latest previewUrl
    // from state. An in-flight guard prevents
    // double-clicks from stacking two parallel
    // POSTs.
    //
    // Why saveAsBlob('Docx') and not
    // documentEditor.serialize(): the editor is
    // configured with `serviceUrl` pointing at the
    // public Syncfusion document service. In that
    // mode serialize() does NOT return the full
    // SFDT envelope - it returns a small
    // incremental-sync payload (the diff against
    // the server-side document), and the SFDT is
    // only ever materialised server-side. The
    // server-side SfdtIngestor we built reads the
    // canonical full-SFDT schema and silently
    // produces a blank WordDocument from a delta
    // payload, which is why the saved PDF came
    // out blank. saveAsBlob('Docx') returns the
    // full DOCX bytes directly from the editor,
    // which we round-trip through the same DOCX ->
    // PDF pipeline the 'Proceed to Export' button
    // uses (and which is known to work).
    var aiSummarySaveInFlight = false;
    function onSaveAiSummaryClicked(editor) {
        if (!editor || !editor.documentEditor) { return; }
        if (typeof editor.documentEditor.saveAsBlob !== 'function') { return; }
        if (aiSummarySaveInFlight) { return; }
        aiSummarySaveInFlight = true;
        // Capture the live DOCX (the user's edited
        // copy) as a base64 string. We deliberately
        // re-use the same saveAsBlob + FileReader +
        // bytesToBase64 pipeline as
        // captureAiSummaryDocxBase64() rather than
        // the serialize() / SfdtIngestor path -
        // the latter produces a blank PDF when
        // serviceUrl is set (see block comment
        // above).
        editor.documentEditor.saveAsBlob('Docx').then(function (blob) {
            if (!blob) {
                throw new Error('The AI summary editor returned an empty document.');
            }
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onerror = function () { reject(new Error('Could not read the AI summary DOCX bytes.')); };
                reader.onload = function () {
                    var bytes = new Uint8Array(reader.result);
                    resolve(bytesToBase64(bytes));
                };
                reader.readAsArrayBuffer(blob);
            });
        })
            .then(function (b64) {
                if (!b64) {
                    throw new Error('The AI summary DOCX was empty.');
                }
                // Fan out: edited-DOCX save (so the next
                // visit to AI summary rehydrates with the
                // user's edits) + PDF render (so the Export
                // page's PDF card refreshes). DOCX save is
                // non-fatal; PDF failure is surfaced below.
                var editedDocxPromise = apiSaveAiSummaryDocx(b64)
                    .then(function (docxPayload) {
                        state.aiSummaryEditedDocxPreviewUrl = docxPayload.previewUrl || '';
                        state.aiSummaryEditedDocxFileName = docxPayload.fileName || '';
                        return docxPayload;
                    })
                    .catch(function (docxErr) {
                        if (console && console.warn) {
                            console.warn('AI summary edited DOCX save failed (non-fatal):', docxErr);
                        }
                        return { __err: docxErr };
                    });
                var pdfPromise = apiExportAiSummaryPdf(b64);
                return Promise.all([pdfPromise, editedDocxPromise]).then(function (results) {
                    return results[0];
                });
            })
            .then(function (payload) {
                state.aiSummaryPdfPreviewUrl = payload.previewUrl || '';
                state.aiSummaryPdfFileName = payload.fileName || '';
                // Persist + render before logging so any
                // observer reading state from a console
                // snapshot sees the new values.
                save();
                try { render(); } catch (e) { /* ignore */ }
            })
            .catch(function (err) {
                // Log the full error to the
                // console for debugging (the alert
                // would otherwise swallow the stack
                // and the response body). The alert
                // shows whatever message we can
                // surface, plus a fallback that names
                // the failed render so the user has a
                // next step (check the server log).
                if (console && console.error) {
                    console.error('AI summary save failed', err);
                }
                var msg = 'Could not save the AI summary as a PDF.';
                if (err && err.message) {
                    msg = err.message;
                } else if (typeof err === 'string') {
                    msg = err;
                } else if (err && err.toString && err.toString() !== '[object Object]') {
                    msg = err.toString();
                }
                alert(msg + '\n\nCheck the browser console for the full error.');
            })
            .then(function () { aiSummarySaveInFlight = false; });
    }

    // base64 encoder that works on large DOCX blobs (~50KB).
    // Avoids the deprecated `btoa` for binary inputs and keeps
    // the string clean for JSON transport.
    function bytesToBase64(bytes) {
        var len = bytes.length;
        var chars = new Array(Math.ceil(len * 4 / 3));
        var i = 0; var j = 0;
        while (i < len) {
            var b1 = bytes[i++] & 0xff;
            var b2 = i < len ? bytes[i++] & 0xff : NaN;
            var b3 = i < len ? bytes[i++] & 0xff : NaN;
            chars[j++] = b64Chars[b1 >> 2];
            chars[j++] = b64Chars[((b1 & 0x03) << 4) | ((isNaN(b2) ? 0 : b2) >> 4)];
            chars[j++] = isNaN(b2) ? '=' : b64Chars[(((b2 & 0x0f) << 2) | ((isNaN(b3) ? 0 : b3) >> 6))];
            chars[j++] = isNaN(b3) ? '=' : b64Chars[b3 & 0x3f];
        }
        return chars.join('');
    }
    var b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    // ---------------------------------------------------------------
    // Renderers (centre panel, packet list, stepper, header)
    // ---------------------------------------------------------------
    function render() {
        // After the left panel removal the centre panel
        // is full-width and the only renderers that matter
        // are the stepper (workflow progress), the centre
        // panel (mode-specific content) and the workflow
        // context message. The packet list and review-modes
        // sidebar renderers are no-ops kept as stubs in
        // case a future page wants them back, but the live
        // render path does not invoke them.
        renderStepper();
        renderCentre();
        renderHeaderContext();
    }

    function renderStepper() {
        var stepOrder = [
            { id: 'cr-step-import', key: 'import' },
            { id: 'cr-step-compare', key: 'compare' },
            { id: 'cr-step-summary', key: 'summary' },
            { id: 'cr-step-export', key: 'export' }
        ];
        var progress = 0;
        // Determine the highest step index that has been
        // *completed* (i.e. the user has reached a later
        // step at least once during this workflow). A
        // step's chip should turn green as soon as the
        // user has moved past it, AND it must stay green
        // when the user comes back. The persistence comes
        // from the per-step completion flags written by
        // setMode() (compareCompleted, summaryCompleted,
        // exportCompleted) plus the live "compare
        // produced a negotiated DOCX" signal.
        var completedIndex = stepIndex('import'); // Import is "complete" from the moment we land
        if (state.compareCompleted || compared) { completedIndex = Math.max(completedIndex, stepIndex('compare')); }
        // Summary is marked as completed either when the
        // user has explicitly moved to export (sticky
        // flag) OR when the AI summary has been generated
        // and is currently available (live signal).
        if (state.summaryCompleted || (compared && state.aiSummarySfdt)) { completedIndex = Math.max(completedIndex, stepIndex('summary')); }
        // Export is marked as completed only when
        // state.exportCompleted is explicitly true.
        // Do NOT check pdfPreviewUrl - that's just an
        // intermediate artifact (the reviewed contract
        // PDF), not proof the user finished the export step.
        if (state.exportCompleted) { completedIndex = Math.max(completedIndex, stepIndex('export')); }
        for (var i = 0; i < stepOrder.length; i++) {
            var el = document.getElementById(stepOrder[i].id);
            var key = stepOrder[i].key;
            if (!el) { continue; }
            el.classList.remove('completed', 'active', 'disabled');
            var earned = stepEarned(key);
            if (!earned) {
                el.classList.add('disabled');
                el.setAttribute('aria-disabled', 'true');
            } else {
                el.removeAttribute('aria-disabled');
            }
            // Active = the page the user is currently on.
            // This is what gives the stepper its blue ring.
            if (state.activeMode === key) {
                el.classList.add('active');
            }
            // Completed (green) = this step has been
            // finished at least once AND the user is not
            // on it right now. The "AND not on it now"
            // clause is what lets the active step show as
            // a blue ring instead of a green chip - the
            // active state is more informative on the page
            // the user is currently working on. The flag
            // is sticky: a user returning to Compare
            // after AI summary was completed still sees
            // the AI summary chip painted green, exactly
            // as the spec asks.
            else if (stepIndex(key) <= completedIndex) {
                el.classList.add('completed');
            }
            // Count only the completed (green) steps for
            // the progress display. Don't count earned
            // (available) steps - only steps that have
            // been fully finished.
            if (stepIndex(key) <= completedIndex) { progress++; }
        }
        // Connector lines. A line is lit green when the
        // step on the LEFT of the line has been earned -
        // i.e. the user has at least reached the start of
        // the next leg. This produces the green-rail effect
        // when the user is on a later step (compare done
        // but currently on summary, etc.) without ever
        // lighting a line whose start has not been
        // completed yet.
        var pairs = [
            { a: 'cr-line-import', baseKey: 'import' },
            { a: 'cr-line-compare', baseKey: 'compare' },
            { a: 'cr-line-summary', baseKey: 'summary' }
        ];
        for (var p = 0; p < pairs.length; p++) {
            var ln = document.getElementById(pairs[p].a);
            if (!ln) { continue; }
            ln.classList.toggle('completed', !!stepEarned(pairs[p].baseKey));
        }
        var countEl = document.getElementById('cr-workflow-count');
        if (countEl) { countEl.textContent = progress + ' of 4 steps complete'; }
    }

    function stepEarned(key) {
        if (key === 'import') return true;
        // Compare is "earned" only after the user has
        // actually RUN compare. Just having both files
        // uploaded is the prerequisite to enter Compare
        // (and is what the stepper's `data-mode` click
        // guard checks), but it is not evidence of
        // completion. Otherwise the stepper flips to
        // "Compare complete" the moment the auto-load on
        // boot (or the auto-load after Reset) populates
        // the two dropzones, which is wrong: the user
        // has not yet seen the side-by-side editor.
        // `compared` is the in-session live signal set
        // by the compare bridge when runCompare resolves;
        // `compareCompleted` is the sticky persisted
        // signal so a returning user still sees the
        // green chip after a page reload.
        if (key === 'compare') return !!(state.compareCompleted || compared);
        // Summary is earned only after Compare is complete
        // AND AI summary has been generated successfully.
        if (key === 'summary') return !!(state.summaryCompleted || (compared && state.aiSummarySfdt));
        // Export is earned only after Summary is complete
        // (which means AI summary DOCX exists).
        if (key === 'export') return !!(state.summaryCompleted || state.aiSummaryPdfPreviewUrl);
        return false;
    }

    function stepIndex(key) {
        var order = ['import', 'compare', 'summary', 'export'];
        return order.indexOf(key);
    }

    // The left packet panel and the review-modes sidebar
    // were removed. The renderSidebar(), renderPacketList(),
    // renderPacketItem(), wirePacketItems(), selectPacketItem(),
    // fillTemplateTable(), refreshContractPacketContents(),
    // syncAddFilesState(), renderCompare(), wireCompareTopbar(),
    // onTopbarFilePicked(), showRevisionsTitle(), getShowTrackedChanges(),
    // assignSide(), shortKind() and FILE_KIND_LABEL helpers
    // that previously lived here are no longer reachable;
    // the corresponding render() calls were dropped in the
    // same pass. Import is now served by renderImport() (two
    // upload dropzones), Compare by claimContractReviewCompare.render()
    // in compareReview.js (40/60 dual editor), Summary and
    // Export by the unchanged renderSummary() / renderExport()
    // functions below.

    function renderCentre() {
        var panel = document.getElementById('cr-centre-panel');
        if (!panel) { return; }
        var mode = state.activeMode || 'import';
        // Tear down the AI summary editor whenever the
        // user is NOT on the summary mode - the EJ2
        // editor pins a heavy canvas, and we want it
        // released as soon as the user navigates away.
        // renderSummary() remounts it on the next visit.
        if (mode !== 'summary' && aiSummaryEditorMounted) {
            destroyAiSummaryEditor();
        }
        if (mode === 'compare') {
            window.claimContractReviewCompare.render(panel, createCompareBridge());
        } else if (mode === 'summary') {
            renderSummary(panel);
        } else if (mode === 'export') {
            renderExport(panel);
        } else {
            renderImport(panel);
        }
    }

    function createCompareBridge() {
        return {
            getOriginal: function () {
                return { previewUrl: state.originalPreviewUrl, displayName: state.originalDisplayName };
            },
            getNegotiated: function () {
                return { previewUrl: state.negotiatedPreviewUrl, displayName: state.negotiatedDisplayName };
            },
            getChangeLog: function () { return state.changeLog.slice(); },
            // True when the Compare step has been
            // processed and the user has progressed to
            // either AI summary or Export. Used by the
            // Compare view to detect any revisit (to
            // reset the change log so only new
            // accept / reject actions are tracked).
            // The "hide the actions bar" decision is
            // made separately via isExportCompleted:
            // the bar is still shown when revisiting
            // after AI Summary (so the user can make
            // additional changes and re-generate the
            // summary) and only hidden on revisit
            // after Export.
            isCompareCompleted: function () {
                return !!(state.summaryCompleted || state.exportCompleted);
            },
            // True only when the user has progressed
            // all the way to the Export step. The
            // Compare view uses this to distinguish
            // two revisit cases:
            //   - after AI summary but before Export
            //     (summaryCompleted=true, exportCompleted=false):
            //     show the actions bar with the
            //     "Proceed to AI summary" button so the
            //     user can make additional accept /
            //     reject decisions and re-generate the
            //     summary.
            //   - after Export (exportCompleted=true):
            //     hide the actions bar AND lock the
            //     editors in read-only mode. The
            //     workflow is fully done - the Compare
            //     view becomes a passive inspection of
            //     the previously compared documents,
            //     and the editors fill the available
            //     space.
            isExportCompleted: function () {
                return !!state.exportCompleted;
            },
            setNegotiated: function (payload) {
                state.negotiatedPreviewUrl = payload.negotiatedPreviewUrl || '';
                state.negotiatedDisplayName = state.revisedDisplayName || payload.negotiatedFileName || 'Negotiated';
                state.changeLog = [];
            },
            markCompared: function () { compared = true; },
            pushChangeLog: pushChangeLog,
            resetChangeLog: function () {
                // Clear the change log when revisiting Compare
                // after AI summary. This allows the user to make
                // new changes and regenerate the summary with only
                // the new changes.
                state.changeLog = [];
                emit('change-log', { entry: null, log: [] });
            },
            setMode: setMode,
            escapeHtml: ui.escapeHtml,
            // Exposed so the Compare view can subscribe to
            // change-log updates and re-evaluate the
            // "Proceed to AI summary" button's enabled
            // state as the user accepts / rejects tracked
            // changes. Mirrors the global emit('change-log')
            // contract used by renderSummary() / renderExport().
            on: on,
            // Pre-warms the AI summary DOCX so the user is
            // never dropped onto a blank "Generating..."
            // page. Called from the Compare view when the
            // user clicks "Proceed to AI summary" with at
            // least one change recorded. Resolves with the
            // SFDT body on success, rejects on failure -
            // the caller decides whether to navigate.
            ensureAiSummary: function (opts) { return ensureAiSummary(opts || {}); }
        };
    }

    function renderImport(panel) {
        // After the left packet panel was removed, the
        // Import view is the user's only way to get a file
        // into the workflow. Render two side-by-side
        // dropzones (one for Original, one for Revised) with
        // their own click + drag-and-drop affordances. The
        // Run compare button lives in a compact footer
        // underneath the dropzones so the whole Import view
        // fits in the viewport without scrolling.
        //
        // The hidden file inputs (`cr-import-original-input`
        // and `cr-import-revised-input`) are picked up by
        // the page-scoped wireImportZone() / wireImportUpload()
        // helpers in ContractReview.cshtml. We re-invoke
        // window.crWireImportZones() at the end of this
        // render so the freshly created host divs (which
        // have no _wired flag) get their click + drag
        // handlers attached. Without this, the second time
        // the user lands on Import the new zones have no
        // listeners and the "Replace file" button silently
        // no-ops.
        var bothReady = !!(state.originalPreviewUrl && state.revisedPreviewUrl);
        // Compute whether the user has already progressed
        // past Import in a previous run. lastAdvancedMode is
        // the deepest mode the user has reached; if it is
        // beyond Import AND both files are still on disk,
        // we offer a "Continue where you left off" CTA that
        // jumps the user straight back to their furthest
        // step. The CTA is disabled when the workflow has
        // been reset (lastAdvancedMode === 'import') or
        // when the user has just uploaded a fresh file
        // (setOriginal/setRevised already call
        // resetCompareProgress() which clears the per-step
        // completion flags; we also clear lastAdvancedMode
        // in that path so the CTA disappears until the
        // user re-runs Compare).
        var hasProgress = !!(state.lastAdvancedMode && stepIndex(state.lastAdvancedMode) > 0);
        var continueMode = hasProgress ? state.lastAdvancedMode : '';
        var continueLabel = 'Continue where you left off';
        if (continueMode === 'compare') { continueLabel = 'Continue to Compare \u2192'; }
        else if (continueMode === 'summary') { continueLabel = 'Continue to AI summary \u2192'; }
        else if (continueMode === 'export') { continueLabel = 'Continue to Export \u2192'; }
        var continueEnabled = hasProgress && bothReady;
        var continueHint = !bothReady
            ? 'Upload both files to unlock the continue option.'
            : (hasProgress
                ? 'You previously reached the ' + (continueMode.charAt(0).toUpperCase() + continueMode.slice(1)) + ' step. Jump straight back to it.'
                : 'Run compare to begin the workflow.');
        // Top of the Import view is a 2-column grid of
        // info cards (mirrors the design): a light-blue
        // "Contract Review Demo" overview on the left,
        // a light-green "Scenario Objective" card on
        // the right. The icon glyphs are inline SVGs so
        // the card stays self-contained - no font / icon
        // dependency. They are not interactive, so the
        // accessibility tree is aria-hidden.
        var docIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>'
            + '<polyline points="14 2 14 8 20 8"></polyline>'
            + '<line x1="8" y1="13" x2="16" y2="13"></line>'
            + '<line x1="8" y1="17" x2="13" y2="17"></line>'
            + '</svg>';
        var targetIconSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<circle cx="12" cy="12" r="10"></circle>'
            + '<circle cx="12" cy="12" r="6"></circle>'
            + '<circle cx="12" cy="12" r="2"></circle>'
            + '</svg>';
        panel.innerHTML = ''
            + '<div class="cr-overview-row">'
            +   '<section class="cr-info-card">'
            +     '<span class="cr-info-card-icon">' + docIconSvg + '</span>'
            +     '<div class="cr-info-card-body">'
            +       '<h2 class="cr-info-card-title">Contract Review Demo</h2>'
            +       '<p>Drop two versions of a contract and let DOCX Editor line up every change side by side.</p>'
            +       '<ul class="cr-info-card-list">'
            +         '<li>Review tracked changes side by side</li>'
            +         '<li>Accept or reject proposed terms</li>'
            +         '<li>Summarize obligations with AI assistant</li>'
            +         '<li>Export a clean, revised PDF</li>'
            +       '</ul>'
            +     '</div>'
            +   '</section>'
            +   '<section class="cr-info-card">'
            +     '<span class="cr-info-card-icon cr-info-card-icon--objective">' + targetIconSvg + '</span>'
            +     '<div class="cr-info-card-body">'
            +       '<p class="cr-info-card-eyebrow cr-info-card-eyebrow--objective">Scenario Objective</p>'
            +       '<h2 class="cr-info-card-title">Turn contract changes into a negotiated, counterparty-ready agreement.</h2>'
            +       '<p>Upload the original and revised DOCX files to compare every change side by side. Review each tracked edit, accept or reject the proposed terms, use the AI assistant to summarize the negotiated obligations, and export the final clean PDF.</p>'
            +     '</div>'
            +   '</section>'
            + '</div>'
            + '<div class="cr-import-zones">'
            +   renderImportZone('Original', state.originalDisplayName || state.originalFileName, 'cr-import-original-zone', 'cr-import-original-input', 'cr-eyebrow-original', 'cr-import-dropzone--original')
            +   renderImportZone('Revised', state.revisedDisplayName || state.revisedFileName, 'cr-import-revised-zone', 'cr-import-revised-input', 'cr-eyebrow-revised', 'cr-import-dropzone--revised')
            + '</div>'
            + '<div class="cr-import-footer">'
            +   '<div class="cr-import-footer-text-block">'
            +     '<span class="cr-import-footer-text">'
            +       (bothReady
            ? 'Both files ready. Open the side-by-side review workspace to inspect every tracked change.'
            : 'Upload both files to continue. The original pane is read-only; the revised pane has track changes enabled.')
            +     '</span>'
            +     (hasProgress
            ? '<span class="cr-import-footer-resume">' + ui.escapeHtml(continueHint) + '</span>'
            : '')
            +   '</div>'
            +   '<div class="cr-import-footer-actions">'
            +     (hasProgress
            ? '<button id="crImportContinueBtn" type="button" class="cr-btn cr-btn-outline" '
            +     (continueEnabled ? '' : 'disabled title="' + ui.escapeHtml(continueHint) + '"') + '>'
            +     ui.escapeHtml(continueLabel) + '</button>'
            : '')
            +     '<button id="crImportCompareBtn" class="cr-btn cr-btn-primary" '
            +       (bothReady ? '' : 'disabled title="Upload an Original and a Revised DOCX first."') + '>'
            +       'Run compare &rarr;'
            +     '</button>'
            +   '</div>'
            + '</div>';
        var btn = document.getElementById('crImportCompareBtn');
        if (btn) {
            btn.addEventListener('click', function () {
                if (btn.disabled) { return; }
                btn.disabled = true;
                btn.textContent = 'Comparing...';
                runCompare().catch(function (err) {
                    alert((err && err.message) ? err.message : 'Compare failed.');
                }).then(function () {
                    btn.disabled = false;
                    btn.textContent = 'Run compare \u2192';
                });
            });
        }
        // "Continue where you left off" jumps the user
        // straight to their deepest step. We use the same
        // setMode() chokepoint so prerequisite gating
        // (compare -> summary, etc.) is honoured - the
        // user can never resume to a step they would not
        // otherwise be able to navigate to.
        var continueBtn = document.getElementById('crImportContinueBtn');
        if (continueBtn) {
            continueBtn.addEventListener('click', function () {
                if (continueBtn.disabled) { return; }
                if (!continueMode) { return; }
                setMode(continueMode);
            });
        }
        // Re-wire the freshly rendered dropzones. The
        // page-scoped wiring in ContractReview.cshtml only
        // runs once (at boot) and tracks hosts by
        // host._wired; new host divs created here need
        // their own listeners. The helper is a no-op until
        // boot has finished, so a quick safety guard keeps
        // us from throwing on the very first synchronous
        // render before the page script has loaded.
        if (typeof window.crWireImportZones === 'function') {
            window.crWireImportZones();
        }
    }

    // Render one of the two dropzone cards used by
    // renderImport. Each card is a tinted column with
    // two stacked zones: a compact summary at the
    // top (eyebrow + filename + status + Replace file
    // button when ready) and a large dashed drop area
    // below (cloud icon + prompt + Browse file), which
    // hides once a file has been uploaded. The whole
    // card is the click target - the inner Browse
    // button is pointer-events: none so we never
    // double-fire the hidden file picker.
    function renderImportZone(side, currentName, hostId, inputId, eyebrowClass, sideModifier) {
        // Each dropzone card is a tall tinted surface
        // with two stacked children:
        //   1. A compact summary header (eyebrow +
        //      filename + side hint + Replace file
        //      button). Tinted in the side's brand
        //      colour (blue / green).
        //   2. A large dashed drop area centred on a
        //      cloud-up icon plus a filled Browse file
        //      button ("Drag & drop DOCX file here or").
        // The whole card is the click target. The
        // drop area is a child of the card so its own
        // dashed border (kept gray-blue/green at low
        // opacity) reads as a sub-region, while the
        // card itself carries the broader color wash.
        var isReady = !!currentName;
        var sideLower = side.toLowerCase();
        var statusText = isReady ? 'File loaded' : 'Upload the ' + sideLower + ' contract (DOCX).';
        var titleText = isReady
            ? (/\.[^.]+$/.test(currentName) ? currentName : currentName + '.docx')
            : (side + ' contract');
        var eyebrowClassFull = 'cr-import-dropzone-eyebrow ' + eyebrowClass;
        var modifierClass = sideModifier || '';
        // Cloud-upload glyph (Feather/Lucide style).
        // Inline SVG keeps the card self-contained
        // without a font / icon dependency.
        var cloudSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>'
            + '<polyline points="12 12 12 16"></polyline>'
            + '<polyline points="9 14 12 11 15 14"></polyline>'
            + '</svg>';
        return ''
            + '<div id="' + hostId + '" class="cr-import-dropzone ' + modifierClass + (isReady ? '' : ' cr-import-dropzone-empty') + ' ' + (isReady ? 'cr-is-ready' : '') + '" '
            +     'data-side="' + side + '" role="button" tabindex="0" aria-label="Upload ' + side + ' contract">'
            +   '<div class="cr-import-summary">'
            +     '<div class="' + eyebrowClassFull + '"><span class="cr-import-summary-icon" aria-hidden="true">'
            +       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
            +         '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>'
            +         '<polyline points="14 2 14 8 20 8"></polyline>'
            +         '<line x1="8" y1="13" x2="16" y2="13"></line>'
            +         '<line x1="8" y1="17" x2="13" y2="17"></line>'
            +       '</svg>'
            +     '</span>' + side + '</div>'
            +     '<h3 class="cr-import-dropzone-title">' + ui.escapeHtml(titleText) + '</h3>'
            +     '<span class="cr-import-dropzone-status' + (isReady ? ' cr-status-ready' : '') + '">' + (isReady ? '<span class="cr-import-status-icon" aria-hidden="true">&#10003;</span>' : '') + ui.escapeHtml(statusText) + '</span>'
            +     '<span class="cr-import-summary-replace">' + (isReady ? 'Replace file' : '') + '</span>'
            +   '</div>'
            +   '<div class="cr-import-dropspot">'
            +     '<span class="cr-import-dropspot-icon" aria-hidden="true">' + cloudSvg + '</span>'
            +     '<span class="cr-import-dropspot-prompt">Drag &amp; drop a replacement DOCX file here or</span>'
            +     '<button type="button" class="cr-import-dropspot-btn" tabindex="-1">Replace file</button>'
            +   '</div>'
            +   '<input id="' + inputId + '" type="file" accept=".docx" hidden />'
            + '</div>';
    }

    function refreshContractPacketContents() {
        var body = document.getElementById('crPacketContentsTableBody');
        if (!body) { return; }
        apiGetTemplates().then(function (payload) {
            if (!document.getElementById('crPacketContentsTableBody')) { return; }
            var templates = payload && Array.isArray(payload.templates) ? payload.templates : [];
            var rows = [];
            var matched = {};
            for (var i = 0; i < templates.length; i++) {
                var template = templates[i];
                var documentItem = null;
                for (var j = 0; j < state.documents.length; j++) {
                    if (state.documents[j].fileName === template.fileName) {
                        documentItem = state.documents[j];
                        matched[template.fileName] = true;
                        break;
                    }
                }
                rows.push(documentItem || template);
            }
            for (var d = 0; d < state.documents.length; d++) {
                if (!matched[state.documents[d].fileName]) { rows.push(state.documents[d]); }
            }
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="4">No files in the packet yet. Use &quot;Add files&quot; to upload a DOCX file.</td></tr>';
                return;
            }
            body.innerHTML = rows.map(function (item) {
                var fileName = item.displayName || item.fileName || '';
                var type = item.fileType || 'Word';
                var size = item.fileSize ? formatSize(item.fileSize) : '-';
                return '<tr><td>' + ui.escapeHtml(fileName) + '</td>'
                    + '<td>' + ui.escapeHtml(type) + '</td>'
                    + '<td>1</td><td>' + ui.escapeHtml(size) + '</td></tr>';
            }).join('');
        }).catch(function () {
            body.innerHTML = '<tr><td colspan="4">Unable to load packet contents.</td></tr>';
        });
    }

    function fillTemplateTable() {
        var body = document.getElementById('crTemplateTableBody');
        if (!body) { return; }
        body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#94a3b8;">Loading templates...</td></tr>';
        apiGetTemplates().then(function (payload) {
            var templates = (payload && Array.isArray(payload.templates)) ? payload.templates : [];
            if (!templates.length) {
                body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#94a3b8;">No templates found.</td></tr>';
                return;
            }
            var html = '';
            for (var i = 0; i < templates.length; i++) {
                var t = templates[i];
                var side = t.side || 'Either';
                html += ''
                    + '<tr>'
                    +   '<td>' + ui.escapeHtml(t.displayName || t.fileName) + '<br><span style="color:#94a3b8;font-size:11px;">' + ui.escapeHtml(formatSize(t.fileSize)) + '</span></td>'
                    +   '<td><span class="cr-choose-side-pill cr-side-' + ui.escapeHtml((side || 'either').toLowerCase()) + '">' + ui.escapeHtml(side.toUpperCase()) + '</span></td>'
                    +   '<td style="text-align:right;">'
                    +     '<button data-tpl-file="' + ui.escapeHtml(t.fileName) + '" data-tpl-name="' + ui.escapeHtml(t.displayName) + '" data-side="' + ui.escapeHtml(side) + '" '
                    +         (side === 'Original' ? '' : 'style="margin-right:4px;" ') + '>'
                    +         (side === 'Original' ? 'Use as Original' : (side === 'Revised' ? 'Use as Revised' : 'Use as Original'))
                    +     '</button>'
                    +     (side !== 'Original' ? '<button data-tpl-file="' + ui.escapeHtml(t.fileName) + '" data-tpl-name="' + ui.escapeHtml(t.displayName) + '" data-side="Revised" '
                    +         (side === 'Revised' ? 'style="display:none;" ' : '') + '>'
                    +         'Use as Revised'
                    +     '</button>' : '')
                    +   '</td>'
                    + '</tr>';
            }
            body.innerHTML = html;
        }).catch(function () {
            body.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#b91c1c;">Could not list templates.</td></tr>';
        });
    }

    // Compare view is rendered by compareReview.js
    // (window.claimContractReviewCompare.render). The dead
    // renderCompare() / wireCompareTopbar() / onTopbarFilePicked()
    // / getShowTrackedChanges() / showRevisionsTitle() and the
    // topbar file trackers that used to live here were
    // removed in the same pass that deleted the left panel
    // - compareReview.js owns the live compare surface.

    function refreshChangeLog() {
        var rows = document.getElementById('crChangeLogRows');
        if (!rows) { return; }
        if (!state.changeLog.length) {
            rows.innerHTML = '<div class="cr-change-log-row" style="color:#94a3b8;">No changes yet.</div>';
            return;
        }
        rows.innerHTML = state.changeLog.slice().reverse().slice(0, 50).map(renderChangeRow).join('');
    }

    function renderChangeRow(entry) {
        return ''
            + '<div class="cr-change-log-row">'
            + '<span class="' + (entry.action === 'Accept' || entry.action === 'Accept all'
                ? 'cr-change-action-accept'
                : entry.action === 'Reject' || entry.action === 'Reject all'
                    ? 'cr-change-action-reject'
                    : '') + '">'
            + ui.escapeHtml(entry.action) + '</span> by '
            + ui.escapeHtml(entry.author || 'unknown')
            + ' &middot; ' + ui.escapeHtml(new Date(entry.at || Date.now()).toLocaleTimeString())
            + ' <span style="color:#94a3b8;">- ' + ui.escapeHtml(entry.detail || '') + '</span>'
            + '</div>';
    }

    function renderSummary(panel) {
        // CRITICAL: tear down the EJ2 editor BEFORE we
        // overwrite panel.innerHTML. The editor is
        // mounted as a child of #crAiSummaryEditorHost,
        // and that host lives inside the panel we are
        // about to wipe. If we do not destroy first,
        // the new host div is empty (the user sees a
        // blank canvas) while the EJ2 instance is
        // dangling, attached to a host that is no
        // longer in the DOM. This is the root cause of
        // the "DOCX is open in the editor below" but
        // blank editor symptom.
        destroyAiSummaryEditor();
        var rows = '';
        if (state.changeLog.length) {
            rows = state.changeLog.slice().reverse().map(function (e) {
                return ''
                    + '<div class="cr-summary-changes-row cr-summary-change-entry">'
                    + '<div><strong>' + ui.escapeHtml(e.action || 'Unknown action') + '</strong> by '
                    + ui.escapeHtml(e.author || 'unknown') + '</div>'
                    + '<div class="cr-summary-meta">' + ui.escapeHtml(new Date(e.at || Date.now()).toLocaleString()) + '</div>'
                    + (e.detail ? '<div class="cr-summary-detail"><strong>Selected text:</strong> ' + ui.escapeHtml(e.detail) + '</div>' : '')
                    + (e.contentSfdt ? '<details class="cr-summary-snapshot"><summary>View captured document SFDT</summary><pre>' + ui.escapeHtml(e.contentSfdt) + '</pre></details>' : '<div class="cr-summary-no-snapshot">No document snapshot captured.</div>')
                    + '</div>';
            }).join('');
        }
        if (!rows) {
            rows = '<div class="cr-summary-changes-row" style="color:#94a3b8;">No accepted / rejected changes yet.</div>';
        }
        // The "Proceed to Export" button is rendered in
        // two visual states:
        //   - idle: a primary CTA that says
        //     "Proceed to Export"
        //   - in-flight: a disabled outline button that
        //     says "Rendering..." (mirrors claim-intake's
        //     "Apply Permanently" -> "Final" flow where
        //     the redaction step waits for the server to
        //     produce the artefacts before navigating).
        // The user's request: do NOT navigate to Export
        // until the PDF is ready. The Export page should
        // arrive with Download + Preview already live,
        // not render a "Rendering..." pill of its own for
        // 5s. So the AI summary page itself owns the
        // render wait state. The `exporting` module-level
        // flag tracks whether a render is currently
        // in flight, so a re-render of the centre panel
        // (e.g. from the change-log listener) keeps the
        // button in its rendering state instead of
        // reverting to the idle CTA.
        var isExporting = exporting;
        // The CTA is shown on a render in three
        // situations:
        //   1. The workflow has not yet produced
        //      both PDFs (exportAlreadyDone is
        //      false) AND there is something to
        //      render (changeLog non-empty OR AI
        //      summary is already ready). This is
        //      the first-visit / pre-export path.
        //   2. The workflow HAS already produced
        //      both PDFs (exportAlreadyDone is
        //      true, i.e. a revisit) AND the
        //      user has edited the AI summary
        //      DOCX in the editor since the
        //      last mount (aiSummaryDirty is
        //      true). This is the new
        //      "first-keystroke-reopens-the-CTA"
        //      behaviour: the CTA is hidden on a
        //      fresh revisit but reappears the
        //      moment the user types a single
        //      character.
        //   3. (Defense in depth) On a render
        //      where exporting is currently in
        //      flight, the "Rendering..." pill
        //      takes precedence over both rules.
        var exportAlreadyDone = !!(state.pdfPreviewUrl && state.aiSummaryPdfPreviewUrl);
        var showCta = (!exportAlreadyDone && (state.changeLog.length || state.aiSummaryStatus === 'ready'))
            || (exportAlreadyDone && aiSummaryDirty);
        var ctaHtml = isExporting
            ? '<button class="cr-btn cr-btn-outline" id="crProceedExportBtn" type="button" disabled style="display:inline-flex;align-items:center;justify-content:center;cursor:default;opacity:.7;">Rendering\u2026</button>'
            : '<button class="cr-btn cr-btn-primary" id="crProceedExportBtn">Proceed to Export &rarr;</button>';
        var ctaHint = isExporting
            ? '<div class="cr-summary-render-hint">Rendering the reviewed PDF on the server. You will be taken to the Export page as soon as the file is ready.</div>'
            : '';

        var proceedInToolbarHtml = showCta
            ? ctaHtml
            : '';

        panel.innerHTML = ''
            + '<div class="cr-center-header">'
            +   '<p class="cr-section-title">Contract Review Demo</p>'
            +   '<div class="cr-summary-heading-row">'
            +     '<h1>Negotiated obligations summary</h1>'
            +     '<div class="cr-ai-summary-toolbar">' + proceedInToolbarHtml + '</div>'
            +   '</div>'
            + '</div>'
            + '<div class="cr-summary-card cr-fill-flex">'
            +   '<div class="cr-ai-summary-editor-wrap">'
            +     '<div id="crAiSummaryEditorHost" class="cr-ai-summary-editor"></div>'
            +   '</div>'
            +   '<details class="cr-summary-changes-collapse">'
            +     '<summary>Captured review events (' + state.changeLog.length + ')</summary>'
            +     '<div class="cr-summary-changes">' + rows + '</div>'
            +   '</details>'
            +   ctaHint
            + '</div>';

        // ----------------------------------------------------------------
        // Mount the EJ2 DocumentEditor and load the AI
        // summary DOCX into it. The mount happens first
        // (it is a no-op if already mounted but the
        // previous instance was destroyed by the
        // destroyAiSummaryEditor() call at the top of
        // this function, so we always get a fresh
        // mount into the new host div).
        //
        // ensureAiSummary() drives the AI agent + DOCX
        // generation when the SFDT is not already on
        // disk. After it resolves, state.aiSummaryPreviewUrl
        // is populated, and openAiSummaryDocx() loads
        // the DOCX into the live editor via the same
        // /Import path the Compare view uses.
        // ----------------------------------------------------------------
        ensureAiSummaryEditorMount()
            .then(function () {
                if (state.aiSummaryStatus === 'ready' && state.aiSummaryPreviewUrl) {
                    return openAiSummaryDocx();
                }
                return ensureAiSummary().then(function () {
                    if (state.aiSummaryPreviewUrl) {
                        return openAiSummaryDocx();
                    }
                    return false;
                });
            })
            .then(function () {
                // After the SFDT/DOCX is loaded into the
                // editor, the status pill may still
                // read "will be generated..." because
                // the page was rendered BEFORE the AI
                // call completed. Repaint the pill in
                // place so the user sees the actual
                // "ready" state.
                repaintAiSummaryStatus();
            })
            .catch(function (err) {
                state.aiSummaryStatus = 'error';
                state.aiSummaryError = (err && err.message) ? err.message : 'AI summary failed.';
                repaintAiSummaryStatus();
            });

        // The "Proceed to Export" CTA now lives in the
        // toolbar (where the Regenerate button used to be).
        // The Regenerate flow is gone - the AI summary is a
        // one-shot per Compare run, so the user re-runs
        // Compare to produce a fresh summary.
        var proceedBtn = document.getElementById('crProceedExportBtn');
        if (proceedBtn && !isExporting) {
            proceedBtn.addEventListener('click', onProceedExportClicked);
        }
    }

    // "Proceed to Export" click handler. Drives the
    // server-side PDF render from the AI summary page
    // (instead of from the Export page itself) and
    // navigates to Export only once both PDFs are
    // ready. Mirrors the claim-intake pattern: the
    // redaction page owns the "Apply Permanently" wait
    // state, and the Final page arrives with Download
    // + Preview already live - the user sees one
    // consistent "Rendering..." pill on the page they
    // initiated the action from, never an empty
    // Export page.
    //
    // Rendering discipline: the handler owns the
    // single render boundary for this transition. It
    // MUST NOT call full render() while the AI summary
    // page is mounted - renderCentre -> renderSummary
    // calls destroyAiSummaryEditor() at its first
    // line and rebuilds the editor canvas, which is
    // visible to the user as a flash. Instead:
    //   1. Capture DOCX bytes from the live editor
    //      BEFORE swapping the CTA pill (the editor
    //      is still mounted at this point, no
    //      teardown has happened).
    //   2. Swap ONLY the CTA pill and the inline
    //      "Rendering..." hint in place via
    //      repaintProceedExportButton(). No
    //      panel.innerHTML rewrite, no editor teardown.
    //   3. Fire the two PDF POSTs in parallel.
    //   4. On both complete: setMode('export'), which
    //      performs render() exactly once at the
    //      destination page.
    // exportPdf() also gates its own terminal render()
    // behind the `exporting` lock so its resolved
    // .then does not retrigger an intermediate render
    // on the AI summary page.
    function onProceedExportClicked() {
        // Re-entry guard: do not start a second export while
        // the current editor snapshot is being captured.
        if (exporting) { return; }
        // Set the guard immediately. The guard does TWO
        // things now:
        //   1. Blocks re-entry (a second click while
        //      capture or PDF POST is in flight).
        //   2. Tells exportPdf() (when it eventually
        //      resolves) to skip its terminal render(),
        //      because the SET of state changes exportPdf
        //      makes is incomplete - the handler still
        //      needs to fire Promise.all, mark
        //      exporting = false, and call setMode
        //      ('export') which will rerender once at
        //      the destination.
        exporting = true;
        ensureAiSummaryEditorReady()
            .then(captureAiSummaryDocxBase64)
            .then(function (b64) {
                if (!b64) { throw new Error('The AI summary DOCX was empty.'); }
                // We have the DOCX bytes. Update the CTA
                // pill IN PLACE - do NOT call render().
                // render() would tear down the editor
                // (renderSummary destroys the AI summary
                // editor canvas at its first line) and
                // mount a fresh empty one, which is
                // visible as a flash. The pill swap
                // keeps the editor alive and shows the
                // user that work is happening.
                repaintProceedExportButton(/* inFlight */ true);
                var contractPromise = state.pdfPreviewUrl
                    ? Promise.resolve({})
                    : exportPdf().catch(function (err) { return { __err: err }; });
                // Fan out three calls:
                //   1. contract PDF render (skipped if already on disk)
                //   2. edited-DOCX save (non-fatal; only used on the next visit's rehydration)
                //   3. AI summary PDF render (primary deliverable for the Export page)
                var editedDocxPromise = apiSaveAiSummaryDocx(b64)
                    .then(function (payload) {
                        state.aiSummaryEditedDocxPreviewUrl = payload.previewUrl || '';
                        state.aiSummaryEditedDocxFileName = payload.fileName || '';
                        // Do NOT bump aiSummaryLoadedUrl here:
                        // it would force a reload of the live
                        // editor and clobber in-progress edits.
                        save();
                        return payload;
                    })
                    .catch(function (err) {
                        if (console && console.warn) {
                            console.warn('AI summary edited DOCX save failed (non-fatal):', err);
                        }
                        return { __err: err };
                    });
                var aiSummaryPromise = apiExportAiSummaryPdf(b64)
                    .then(function (payload) {
                        state.aiSummaryPdfPreviewUrl = payload.previewUrl || '';
                        state.aiSummaryPdfFileName = payload.fileName || '';
                        save();
                        return payload;
                    })
                    .catch(function (err) { return { __err: err }; });
                return Promise.all([contractPromise, editedDocxPromise, aiSummaryPromise]);
            })
            .then(function (results) {
                exporting = false;
                var contractResult = results && results[0];
                var aiResult = results && results[2];
                if (contractResult && contractResult.__err) {
                    throw contractResult.__err;
                }
                // editedDocxResult is intentionally not
                // checked: its failure is non-fatal.
                if (aiResult && aiResult.__err) {
                    throw aiResult.__err;
                }
                if (state.pdfPreviewUrl && state.aiSummaryPdfPreviewUrl) {
                    // Single render boundary: setMode's
                    // internal render() dispatches to
                    // renderExport.
                    setMode('export');
                } else {
                    // Defensive fallback: at least one PDF
                    // did not materialise; re-render so the
                    // pill flips back to idle.
                    render();
                }
            })
            .catch(function (err) {
                exporting = false;
                alert((err && err.message) ? err.message : 'Export failed.');
                // Flip the pill back to idle on error.
                render();
            });
    }

    // In-place reveal of the "Proceed to Export"
    // CTA when the user types into the editor on a
    // revisit (where the button was originally
    // hidden because exportAlreadyDone was true).
    // The contentChange handler in
    // ensureAiSummaryEditorMount() flips
    // aiSummaryDirty and calls this function, which
    // inserts a fresh primary-CTA button into the
    // existing .cr-ai-summary-toolbar div in place.
    // We deliberately do NOT call render() here:
    // renderCentre -> renderSummary would tear down
    // the EJ2 editor (destroyAiSummaryEditor at its
    // first line) and remount it, which is visible
    // to the user as a flash. The in-place insert
    // keeps the editor alive and shows the user
    // that their keystroke registered.
    //
    // No-op conditions:
    //   - exporting === true: the user is already
    //     in the middle of a render, the CTA is in
    //     its disabled "Rendering..." state. Don't
    //     stomp on it.
    //   - the button is already present: re-entry
    //     from rapid keystrokes would otherwise
    //     stack click listeners.
    //   - the toolbar div is missing: the user has
    //     navigated away from the AI summary page
    //     mid-keystroke (very rare, but possible if
    //     the tab loses focus during a debounced
    //     render). Nothing to do; the next render
    //     will build the button correctly.
    function revealProceedExportOnDirty() {
        if (exporting) { return; }
        var toolbar = document.querySelector('.cr-ai-summary-toolbar');
        if (!toolbar) { return; }
        if (document.getElementById('crProceedExportBtn')) { return; }
        var btn = document.createElement('button');
        btn.id = 'crProceedExportBtn';
        btn.className = 'cr-btn cr-btn-primary';
        btn.textContent = 'Proceed to Export \u2192';
        btn.addEventListener('click', onProceedExportClicked);
        toolbar.appendChild(btn);
    }

    // In-place CTA pill swap for the Proceed to Export
    // button on the AI summary page. Avoids a full
    // render() round-trip (which would tear down and
    // rebuild the EJ2 editor) when we just want to flip
    // the button between its "Proceed to Export"
    // primary state and its disabled "Rendering..."
    // outline state. Mirrors repaintAiSummaryStatus(),
    // which updates only the status pill for the same
    // reason. Looks up the button + hint by id once per
    // call; the elements are tiny so DOM lookup cost is
    // negligible compared to a render() round-trip.
    function repaintProceedExportButton(inFlight) {
        var btn = document.getElementById('crProceedExportBtn');
        var toolbar = btn && btn.parentNode;
        var hint = toolbar && toolbar.parentNode
            ? toolbar.parentNode.querySelector('.cr-summary-render-hint')
            : null;
        if (!btn) {
            // Button does not exist (e.g. user navigated
            // away from AI summary mid-render). Nothing
            // to swap. The handler's terminal render() in
            // the catch / fallback branches will rebuild
            // whatever is appropriate when the promise
            // chain finishes.
            return;
        }
        if (inFlight) {
            // Replace the primary CTA with the disabled
            // "Rendering..." outline button. The new
            // element has the same id so subsequent
            // repaints can still find it.
            var newBtn = document.createElement('button');
            newBtn.id = 'crProceedExportBtn';
            newBtn.type = 'button';
            newBtn.className = 'cr-btn cr-btn-outline';
            newBtn.disabled = true;
            newBtn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:default;opacity:.7;';
            newBtn.textContent = 'Rendering\u2026';
            btn.parentNode.replaceChild(newBtn, btn);
            if (hint) {
                hint.textContent = 'Rendering the reviewed PDF on the server. You will be taken to the Export page as soon as the file is ready.';
            }
        } else {
            // Restore the primary CTA. Reuses the same
            // disabled style we strip on the way out for
            // parity with the renderSummary branch so the
            // user sees the same button they originally
            // clicked.
            btn.className = 'cr-btn cr-btn-primary';
            btn.disabled = false;
            btn.style.cssText = '';
            btn.textContent = 'Proceed to Export \u2192';
            if (hint) { hint.parentNode.removeChild(hint); }
            // Re-attach the click handler - the previous
            // button instance was replaced, so the old
            // listener went with it.
            btn.addEventListener('click', onProceedExportClicked);
        }
    }

    function renderExport(panel) {
        // TEMP DEBUG: log the resolved PDF URLs so the
        // user can confirm in DevTools that
        // state.aiSummaryPdfPreviewUrl from the Save
        // flow is what the Download/Preview buttons
        // are pointing at.
        if (console && console.info) {
            console.info('[Export page] state.pdfPreviewUrl=' + (state.pdfPreviewUrl || '(empty)') + ' | state.aiSummaryPdfPreviewUrl=' + (state.aiSummaryPdfPreviewUrl || '(empty)'));
        }
        var hasPdf = !!state.pdfPreviewUrl;
        var pdfUrl = hasPdf ? window.appUrl(state.pdfPreviewUrl) : '';
        var pdfName = state.pdfFileName || 'Reviewed-Contract.pdf';
        // Preview uses the page-scoped PDF preview modal (see
        // openPdfPreviewModal below) so the user sees the
        // reviewed PDF inside the Syncfusion PdfViewer rather
        // than in a new browser tab. Mirrors the claim-intake
        // Final-step pattern: download uses an <a download>, the
        // Preview button carries the absolute PDF URL on a
        // data-* attribute, and wireExportPreviewButtons()
        // delegates the click to openPdfPreviewModal.
        //
        // The render itself is no longer triggered from
        // this page. The "Proceed to Export" button on the
        // AI summary page owns the render wait state, so by
        // the time the user lands here the PDF is already
        // on disk and Download + Preview are immediately
        // live. This mirrors claim-intake's redaction ->
        // final flow exactly: the user waits on the page
        // they initiated the action from, the destination
        // page arrives with the artefact ready, and the
        // "Rendering..." pill never flickers here.
        //
        // The fallback below is defensive - in normal
        // operation the user always visits Export via the
        // AI summary page, so the no-PDF branch is
        // effectively unreachable. It exists for two
        // edge cases: (a) the user typed /?mode=export
        // directly into the address bar, (b) the user
        // manually navigated via the stepper after a Reset
        // wiped the PDF URL but kept the user on the
        // Export step. Both cases show a "go back" hint
        // that points the user at the AI summary page
        // where the render actually happens.
        var pdfAbsoluteUrl = hasPdf
            ? (window.location.origin + state.pdfPreviewUrl)
            : '';
        var revisedActions = hasPdf
            ? '<div class="cr-final-download-actions">'
            +   '<a class="cr-btn cr-btn-primary" href="' + ui.escapeHtml(pdfUrl) + '" download="' + ui.escapeHtml(pdfName) + '">Download</a>'
            +   '<button type="button" class="cr-btn cr-btn-outline" data-cr-pdf-preview-url="' + ui.escapeHtml(pdfAbsoluteUrl) + '" data-cr-pdf-preview-title="Reviewed contract PDF">Preview</button>'
            + '</div>'
            : '<div class="cr-final-download-actions">'
            +   '<button class="cr-btn cr-btn-primary" type="button" disabled>Download</button>'
            +   '<button class="cr-btn cr-btn-outline" type="button" disabled>Preview</button>'
            + '</div>'
            + '<div class="cr-final-render-hint">No PDF is available yet. Return to the AI summary step and click "Proceed to Export" to render the reviewed PDF.</div>'
            + '<button class="cr-btn cr-btn-outline cr-final-render-btn" id="crExportBackToSummaryBtn" type="button">Back to AI summary</button>';

        // AI Summary card. PDF-only on the Export
        // page: the user's edited DOCX is rendered to
        // PDF on the server (via DocIORenderer) in
        // parallel with the reviewed-contract PDF
        // render. By the time the user lands here,
        // both PDFs are on disk and Download + Preview
        // are live. The Preview button uses the same
        // data-cr-pdf-preview-* attribute as the
        // revised-document card so wireExportPreviewButtons
        // (already wired for the revised-document
        // preview) handles this one without
        // additional code.
        //
        // Three states:
        //   - ready:    the AI summary PDF is on disk,
        //               Download + Preview are live.
        //   - pending:  the user has change-log entries
        //               but hasn't visited the AI
        //               summary step yet (no AI
        //               summary, no PDF). Hint to the
        //               user.
        //   - empty:    no change-log entries at all
        //               (the user went straight to
        //               Export from Import). Disable
        //               both buttons and explain.
        var hasAiSummary = !!state.aiSummaryPdfPreviewUrl;
        var aiSummaryUrl = hasAiSummary ? window.appUrl(state.aiSummaryPdfPreviewUrl) : '';
        var aiSummaryAbsoluteUrl = hasAiSummary ? (window.location.origin + state.aiSummaryPdfPreviewUrl) : '';
        var aiSummaryName = state.aiSummaryPdfFileName || 'AI-Contract-Summary.pdf';
        var aiSummaryEntryCount = state.aiSummaryEntryCount || (state.changeLog ? state.changeLog.length : 0);
        var aiSummaryDescription = hasAiSummary
            ? ('The AI-generated summary of the ' + aiSummaryEntryCount + ' accepted / rejected change' + (aiSummaryEntryCount === 1 ? '' : 's') + ' (PDF).')
            : state.changeLog.length
                ? 'The AI summary will be generated the first time you open the AI summary step. The PDF will be ready when you proceed to Export.'
                : 'No change-log entries were captured, so no AI summary is available.';
        var aiSummaryActions = hasAiSummary
            ? '<div class="cr-final-download-actions">'
            +   '<a class="cr-btn cr-btn-primary" href="' + ui.escapeHtml(aiSummaryUrl) + '" download="' + ui.escapeHtml(aiSummaryName) + '">Download</a>'
            +   '<button type="button" class="cr-btn cr-btn-outline" data-cr-pdf-preview-url="' + ui.escapeHtml(aiSummaryAbsoluteUrl) + '" data-cr-pdf-preview-title="AI Summary PDF">Preview</button>'
            + '</div>'
            : '<div class="cr-final-download-actions">'
            +   '<button class="cr-btn cr-btn-primary" type="button" disabled>Download</button>'
            +   '<button class="cr-btn cr-btn-outline" type="button" disabled>Preview</button>'
            + '</div>'
            + (!state.changeLog.length
                ? ''
                : '<div class="cr-final-render-hint">Open the AI summary step to generate the summary, then return here to download the PDF.</div>')
            + '<button class="cr-btn cr-btn-outline cr-final-render-btn" id="crExportBackToSummaryBtn" type="button">Back to AI summary</button>';

        panel.innerHTML = ''
            + '<div class="cr-center-header">'
            +   '<div><p class="cr-section-title">Contract Review Demo</p><h1>Package</h1></div>'
            + '</div>'
            + '<section class="cr-final-panel">'
            +   '<div class="cr-final-intro">'
            +     '<div><h2>Package</h2><p>Download or preview the reviewed contract and the AI summary generated from this workflow.</p></div>'
            +   '</div>'
            +   '<div class="cr-final-download-grid">'
            +     '<div class="cr-final-download-card">'
            +       '<h3>Revised document</h3>'
            +       '<p>The reviewed contract with the accepted and rejected changes applied.</p>'
            +       revisedActions
            +     '</div>'
            +     '<div class="cr-final-download-card">'
            +       '<h3>AI Summary</h3>'
            +       '<p>' + ui.escapeHtml(aiSummaryDescription) + '</p>'
            +       aiSummaryActions
            +     '</div>'
            +   '</div>'
            + '</section>';
        wireExportPreviewButtons(panel);
        // Defensive fallback: if the user landed on
        // Export without a PDF (e.g. stepper click after
        // a soft reset), wire the "Back to AI summary"
        // button so they can drive the render through
        // the proper code path.
        var backBtn = document.getElementById('crExportBackToSummaryBtn');
        if (backBtn) {
            backBtn.addEventListener('click', function () { setMode('summary'); });
        }
    }

    // Wire the in-panel Preview button so its click opens the
    // PDF preview modal instead of a new tab. Delegated to the
    // panel rather than the document so a centre-panel
    // re-render does not stack listeners. Each button carries
    // the absolute PDF URL and a title in data-* attributes so
    // openPdfPreviewModal can mount the Syncfusion viewer
    // without re-deriving anything.
    function wireExportPreviewButtons(panel) {
        var buttons = panel.querySelectorAll('[data-cr-pdf-preview-url]');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i]._wired) { continue; }
            buttons[i]._wired = true;
            buttons[i].addEventListener('click', makeCrPdfPreviewHandler(buttons[i]));
        }
        // The AI Summary card on the Export page is
        // now PDF-only (Download PDF + Preview PDF).
        // The Preview button uses the same
        // data-cr-pdf-preview-* attribute as the
        // revised-document card, so the loop above
        // wires it for free. The previous
        // data-cr-aisummary-preview-* DOCX preview
        // path was removed.
    }

    function makeCrPdfPreviewHandler(button) {
        return function () {
            var url = button.getAttribute('data-cr-pdf-preview-url') || '';
            var title = button.getAttribute('data-cr-pdf-preview-title') || 'Preview';
            if (!url) { return; }
            openPdfPreviewModal(url, title);
        };
    }

    function mountPdfViewer(url) {
        var host = document.getElementById('crPdfHost');
        if (!host) { return; }
        // The Syncfusion EJ2 PDF Viewer embedded iframe is the
        // pattern used in the claim-intake demo. We delegate the
        // exact same call signature. The PDF viewer JS is the
        // same one referenced on ClaimIntake.cshtml.
        var resourceUrl = window.location.origin + (window.appBasePath || '') + '/pdfviewer';
        host.innerHTML = '';
        try {
            ej.pdfviewer.PdfViewer.Inject(ej.pdfviewer.TextSelection, ej.pdfviewer.TextSearch, ej.pdfviewer.Print);
            var viewer = new ej.pdfviewer.PdfViewer({
                documentPath: window.appUrl(url),
                resourceUrl: resourceUrl,
                enableClientSideRendering: true,
                height: '100%',
                width: '100%'
            });
            viewer.appendTo(host);
        } catch (e) {
            host.innerHTML = '<div class="cr-warning">PDF viewer could not start: ' + ui.escapeHtml(e.message || '') + '</div>';
        }
    }

    // ---------------------------------------------------------------
    // PDF Preview modal
    //
    // Mirrors the openPdfPreviewModal pattern from claimIntake.js
    // so both demos present reviewed PDFs in the same UI: a
    // full-viewport modal hosting the Syncfusion PdfViewer.
    // Mounted lazily on the first Preview click and torn down on
    // close so opening and closing the modal repeatedly (or
    // switching between Preview buttons) does not stack EJ2
    // viewer instances.
    // ---------------------------------------------------------------
    var currentPreviewViewer = null;
    function openPdfPreviewModal(url, title) {
        if (!url) { return; }
        var modal = document.getElementById('crPdfPreviewModal');
        var host = document.getElementById('crPdfPreviewHost');
        var titleEl = document.getElementById('crPdfPreviewTitle');
        if (!modal || !host) { return; }
        if (titleEl && title) { titleEl.textContent = title; }
        // Open first so the host has a measurable size - the
        // EJ2 viewer reads the host's clientWidth / clientHeight
        // when it appends; mounting while the host is inside a
        // display:none container yields a 0x0 viewer.
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden', 'false');
        // Tear down any previous preview viewer (re-opening the
        // modal for a different artefact must not stack viewers
        // on top of each other).
        if (currentPreviewViewer) {
            try { currentPreviewViewer.destroy(); } catch (e) { /* ignore */ }
            currentPreviewViewer = null;
        }
        host.innerHTML = '';
        if (!(window.ej && window.ej.pdfviewer && window.ej.pdfviewer.PdfViewer)) {
            console.warn('Syncfusion PDF Viewer class not available yet.');
            return;
        }
        var resourceUrl = window.location.origin + (window.appBasePath || '') + '/pdfviewer';
        try {
            ej.pdfviewer.PdfViewer.Inject(ej.pdfviewer.TextSelection, ej.pdfviewer.TextSearch, ej.pdfviewer.Print);
            var viewer = new ej.pdfviewer.PdfViewer({
                documentPath: url,
                resourceUrl: resourceUrl,
                enableClientSideRendering: true,
                height: '100%',
                width: '100%'
            });
            viewer.appendTo(host);
            currentPreviewViewer = viewer;
        } catch (e) {
            console.error('PDF preview viewer mount failed', e);
        }
    }

    function closePdfPreviewModal() {
        var modal = document.getElementById('crPdfPreviewModal');
        if (!modal) { return; }
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        if (currentPreviewViewer) {
            try { currentPreviewViewer.destroy(); } catch (e) { /* ignore */ }
            currentPreviewViewer = null;
        }
        var host = document.getElementById('crPdfPreviewHost');
        if (host) { host.innerHTML = ''; }
    }

    // ---------------------------------------------------------------
    // AI summary DOCX preview modal was removed.
    //
    // The Export page now shows the AI summary as
    // PDF only (Download PDF + Preview PDF). The
    // PDF preview uses the same
    // #crPdfPreviewModal that the revised-document
    // card uses, so no second modal is needed and
    // the previous openAiSummaryPreviewModal /
    // closeAiSummaryPreviewModal pair is gone. The
    // #crAiSummaryPreviewModal markup in
    // ContractReview.cshtml was also removed.
    // ---------------------------------------------------------------

    function wirePdfPreviewModalClose() {
        // Delegate close clicks to the document so the backdrop
        // and the X button both work without re-binding. The
        // [data-cr-pdf-preview-close] marker is the single
        // signal. Wired once on boot - the modal host lives in
        // ContractReview.cshtml and is page-scoped.
        document.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) { return; }
            if (t.closest('[data-cr-pdf-preview-close]')) {
                closePdfPreviewModal();
            }
        });
        // Escape closes the PDF preview modal. The
        // AI summary DOCX preview modal was removed
        // (the AI summary is now PDF-only on the
        // Export page), so there is only one modal
        // to close.
        document.addEventListener('keydown', function (e) {
            if (!e || e.key !== 'Escape') { return; }
            var pdfModal = document.getElementById('crPdfPreviewModal');
            if (pdfModal && pdfModal.classList.contains('is-open')) {
                closePdfPreviewModal();
            }
        });
    }

    function renderHeaderContext() {
        // Header context messages were removed from the
        // header markup. The function is kept as a no-op
        // so existing callers don't have to be changed.
        return;
    }

    // ---------------------------------------------------------------
    // UI helpers + escapeHtml shared
    // ---------------------------------------------------------------
    var ui = {
        escapeHtml: function (s) {
            if (s === null || s === undefined) { return ''; }
            return String(s)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },
        formatBytes: formatSize,
        getFileTypeLabel: function (fileName) {
            if (!fileName) { return 'File'; }
            var lower = fileName.toLowerCase();
            if (lower.indexOf('.docx') >= 0 || lower.indexOf('.doc') >= 0) return 'Word';
            if (lower.indexOf('.pdf') >= 0) return 'PDF';
            return 'File';
        }
    };

    function escapeHtml(s) { return ui.escapeHtml(s); }

    function formatSize(bytes) {
        if (!bytes || bytes < 0) { return ''; }
        if (bytes < 1024) { return bytes + ' B'; }
        if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' KB'; }
        return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    }

    // ---------------------------------------------------------------
    // Auto-load the two default contract templates
    //
    // On a fresh launch (no originalPreviewUrl, no
    // revisedPreviewUrl) the server has two default
    // templates under
    // wwwroot/templatefiles/contract-review:
    //   - Original_Contract.docx  (advertised side: Original)
    //   - Redlined_Contract.docx  (advertised side: Revised)
    // Materialise both via /upload-by-template so the user
    // sees a ready-to-compare Import view the first time
    // they open the demo. The two calls fire in parallel
    // (Promise.all) so the typical cold-start cost is the
    // duration of one round-trip, not two. Failures are
    // swallowed and logged: if the templates endpoint is
    // unreachable the user can still drop their own DOCX
    // into either zone via the click / drag-and-drop
    // affordances.
    // ---------------------------------------------------------------
    function autoLoadContractTemplates() {
        if (state.originalPreviewUrl || state.revisedPreviewUrl) {
            return Promise.resolve();
        }
        return apiGetTemplates().then(function (payload) {
            var list = (payload && Array.isArray(payload.templates)) ? payload.templates : [];
            if (!list.length) { return null; }
            // Find the template the server advertises for
            // each side. Templates without a side fall back
            // to the filename heuristic so the user gets
            // sensible defaults if the manifest omits the
            // side field.
            var originalTpl = null;
            var revisedTpl = null;
            for (var i = 0; i < list.length; i++) {
                var t = list[i];
                var side = (t.side || guess(t.fileName) || '').toString();
                if (side === 'Original' && !originalTpl) { originalTpl = t; }
                else if (side === 'Revised' && !revisedTpl) { revisedTpl = t; }
            }
            // No side-tagged templates at all - pick the
            // first two by filename.
            if (!originalTpl || !revisedTpl) {
                var remaining = list.filter(function (t) {
                    return t !== originalTpl && t !== revisedTpl;
                });
                if (!originalTpl && remaining.length) { originalTpl = remaining.shift(); }
                if (!revisedTpl && remaining.length) { revisedTpl = remaining.shift(); }
            }
            // IMPORTANT: pick the two templates
            // SEQUENTIALLY, not in parallel.
            //
            // /api/contract-review/upload-by-template is
            // the endpoint that mints the per-session
            // cookie. If two of them fire in parallel
            // (Promise.all), each request sees its own
            // HttpContext with no inbound cookie, so
            // each one mints a DIFFERENT session key.
            // The two files end up under two different
            // per-session folders, and the next request
            // - the /compare call - can only see one of
            // them, returning 404 when the editor tries
            // to load the other side.
            //
            // By chaining the two picks, the second
            // request sees the cookie set by the first
            // and uses the same session key. Both files
            // land in the same folder, the compare
            // endpoint can read both, and the editor
            // can fetch both.
            var chain = Promise.resolve();
            if (originalTpl) { chain = chain.then(function () { return pickTemplate(originalTpl); }); }
            if (revisedTpl)  { chain = chain.then(function () { return pickTemplate(revisedTpl); }); }
            return chain;
        }).then(function () {
            // Re-render so the dropzones flip into the
            // "ready" state and the Run compare button
            // enables. pickTemplate() already mutated state
            // (setOriginal / setRevised) but those
            // mutations only persisted + re-rendered
            // themselves; a final render() is the safest
            // way to make sure the centre panel reflects
            // both new docs together.
            render();
        }).catch(function (err) {
            // Best-effort: surface the error in the
            // console but do not interrupt the user's
            // flow. They can still drop their own files.
            if (console && console.warn) { console.warn('Auto-load templates failed', err); }
        });
    }

    // ---------------------------------------------------------------
    // Boot
    // ---------------------------------------------------------------
    function boot() {
        load();
        loadSessionPolicy();
        honourUrlMode();
        // Wire the PDF preview modal's close affordances once on
        // boot. The modal host lives in ContractReview.cshtml and
        // is page-scoped, so a single delegation is enough - we
        // never need to re-wire it when the centre panel
        // re-renders. Backdrop click and Escape both close it;
        // the close button is data-attributed so any element
        // with [data-cr-pdf-preview-close] acts as a dismisser.
        wirePdfPreviewModalClose();
        render();
        // Fire-and-forget auto-load of the two default
        // templates. Skipped if either side is already
        // populated (the user came back to a half-finished
        // workflow or replaced one of the templates
        // manually). Also skipped when the user is on a
        // later step (compare/summary/export) so we do
        // not stomp their state with default files.
        if (!state.originalPreviewUrl && !state.revisedPreviewUrl
            && (!state.activeMode || state.activeMode === 'import')) {
            autoLoadContractTemplates();
        }
        on('change-log', function (payload) {
            // Re-render the change-log list only (the centre
            // panel is unchanged when navigating in Compare).
            var rows = document.getElementById('crChangeLogRows');
            if (!rows) { return; }
            if (!payload || !payload.log || !payload.log.length) {
                rows.innerHTML = '<div class="cr-change-log-row" style="color:#94a3b8;">No changes yet.</div>';
                return;
            }
            rows.innerHTML = payload.log.slice().reverse().slice(0, 50).map(renderChangeRow).join('');
        });
        on('pdf-ready', function () { /* the export view picked it up via render() already */ });
    }

    function honourUrlMode() {
        try {
            var qs = window.location.search || '';
            var m = /[?&]mode=([^&]+)/.exec(qs);
            if (!m) { return; }
            var requested = decodeURIComponent(m[1]).toLowerCase();
            if (MODES.indexOf(requested) < 0) { return; }
            // Delegate to setMode() so the URL guard
            // honours the same navigation prereqs the
            // stepper's data-mode click handler does
            // (compare needs both files; summary needs
            // compare to have run; export needs the
            // negotiated DOCX). Using stepEarned()
            // here would over-restrict: e.g. a user
            // deep-linked to ?mode=compare with both
            // files uploaded but compare not yet run
            // would be silently dropped on the Import
            // page, which is the wrong outcome.
            setMode(requested);
        } catch (e) {}
    }

    var api = {
        // state
        get state() { return state; },
        save: save, load: load, wipe: wipe, reset: reset,
        // mutators
        addDocument: addDocument,
        setOriginal: setOriginal,
        setRevised: setRevised,
        setMode: setMode,
        // ws
        uploadFile: uploadFile,
        pickTemplate: pickTemplate,
        runCompare: runCompare,
        exportPdf: exportPdf,
        // render
        render: render,
        // events
        on: on, emit: emit,
        // ui
        ui: ui
    };

    window.claimContractReview = api;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();