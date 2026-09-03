// Compare-step client module for the Contract Review demo.
(function () {
    'use strict';

    var docxEditorLeft = null;
    var docxEditorRight = null;
    var docxMounted = false;
    var topbarOriginalFile = null;
    var topbarRevisedFile = null;
    // Tracks the host DOM elements the editor
    var docxEditorLeftHost = null;
    var docxEditorRightHost = null;
    // Tracks the (originalPreviewUrl|negotiatedPreviewUrl)
    // pair currently loaded into the editors. Compared
    // against the bridge values on every render() so we
    // re-load only when the user has actually swapped
    // files (via resetCompareProgress on Import) - not
    // every time they navigate to Export and back via
    // the stepper. Reset to '' by destroy() so the next
    // mount reloads fresh.
    var docsLoadedFor = '';
    var documentEditorServiceUrl = 'https://document.syncfusion.com/web-services/docx-editor/api/documenteditor/';

    function bridgeValue(bridge, name) {
        return bridge && typeof bridge[name] === 'function' ? bridge[name]() : null;
    }

    function safeJson(r) {
        return r.text().then(function (text) {
            try {
                return { ok: r.ok, status: r.status, payload: text ? JSON.parse(text) : null };
            } catch (e) {
                return { ok: r.ok, status: r.status, payload: null };
            }
        });
    }

    function failureMessage(env, fallback) {
        if (env && env.payload && env.payload.message) { return env.payload.message; }
        if (env && env.status) { return fallback + ' (server returned ' + env.status + ').'; }
        return fallback;
    }

    function runCompare(originalUrl, revisedUrl, bridge) {
        return fetch(window.appUrl('/api/contract-review/compare'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
                originalPreviewUrl: originalUrl,
                revisedPreviewUrl: revisedUrl,
                author: 'Counterparty'
            })
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Compare failed'));
                }
                if (bridge && typeof bridge.setNegotiated === 'function') {
                    bridge.setNegotiated(env.payload);
                }
                if (bridge && typeof bridge.markCompared === 'function') { bridge.markCompared(); }
                return env.payload;
            });
    }

    function ensureEditorMount(bridge, readOnly) {
        // Check whether the editor instances are still
        // attached to the current DOM nodes. When the
        // user navigates away (e.g. to Export) and
        // comes back via the stepper, render() replaces
        // the panel's innerHTML with a fresh DOM tree.
        // The cached editor instances are now orphaned
        // (attached to detached nodes) and the new host
        // elements have no editor at all. We must tear
        // them down and re-mount so the documents can
        // be loaded into the live host elements.
        var leftHost = document.getElementById('crDocxLeft');
        var rightHost = document.getElementById('crDocxRight');
        if (!leftHost || !rightHost) {
            return Promise.reject(new Error('Compare panes are not mounted yet.'));
        }
        if (docxMounted && docxEditorLeft && docxEditorRight) {
            // The cached editor instances are still
            // attached to the current host elements if
            // and only if the host references haven't
            // changed. render() creates fresh DOM nodes
            // on every call, so when the user navigates
            // back via the stepper the host references
            // differ from the ones the editors are
            // attached to - which means the editors are
            // orphaned and we need to rebuild.
            if (leftHost === docxEditorLeftHost && rightHost === docxEditorRightHost) {
                return Promise.resolve();
            }
        }
        if (typeof ej === 'undefined' || !ej.documenteditor || !ej.documenteditor.DocumentEditorContainer) {
            return Promise.reject(new Error('EJ2 DocumentEditor library has not loaded yet.'));
        }
        destroyEditor(docxEditorLeft);
        destroyEditor(docxEditorRight);
        clearEditorHost(leftHost);
        clearEditorHost(rightHost);
        // Reset the "already loaded" flag so the new
        // editor instances will be populated with the
        // documents.
        docsLoadedFor = '';
        // The right editor's interaction model
        // depends on the revisit case:
        //   - readOnly = false (initial Compare, OR
        //     revisit after AI Summary but before
        //     Export): the right editor is the active
        //     editing surface with track changes
        //     enabled, the Changes pane visible with
        //     Accept/Reject buttons, and the
        //     beforeAcceptRejectChanges hook
        //     registered so accept / reject actions
        //     are captured in the change log.
        //   - readOnly = true (revisit after Export):
        //     the workflow is fully done, so the
        //     editors are passive inspection views.
        //     Track changes is disabled, the Changes
        //     pane is hidden, and the change-log hook
        //     is not registered. The editors fill the
        //     available space and the actions bar is
        //     not rendered by the caller.
        var lockForReadOnly = !!readOnly;

        try {
            docxEditorLeft = new ej.documenteditor.DocumentEditorContainer({
                height: '100%', width: '100%',
                serviceUrl: documentEditorServiceUrl,
                enableToolbar: false, showPropertiesPane: false, restrictEditing: true
            });
            docxEditorLeft.appendTo(leftHost);
            docxEditorLeft.documentEditor.isReadOnly = true;

            docxEditorRight = new ej.documenteditor.DocumentEditorContainer({
                height: '100%', width: '100%',
                serviceUrl: documentEditorServiceUrl,
                enableToolbar: false, showPropertiesPane: false,
                restrictEditing: lockForReadOnly,
                documentChange: function () {
                    if (!docxEditorRight || !docxEditorRight.documentEditor) { return; }
                    if (lockForReadOnly) {
                        // Read-only path (revisit after
                        // Export). The workflow is
                        // complete - we don't want the
                        // user to mutate the document or
                        // see Accept/Reject UI. The
                        // setters below ensure the
                        // Changes pane stays closed.
                        try { docxEditorRight.documentEditor.isReadOnly = true; } catch (e) {}
                        try { docxEditorRight.documentEditor.enableTrackChanges = false; } catch (e) {}
                        try { docxEditorRight.documentEditor.showRevisions = false; } catch (e) {}
                        setTimeout(function () {
                            try {
                                if (typeof docxEditorRight.closePane === 'function') {
                                    docxEditorRight.closePane();
                                }
                            } catch (e) {}
                            try {
                                var panes = rightHost.querySelectorAll('.e-de-track-changes-pane, .e-de-revision-pane, .e-de-pane');
                                for (var i = 0; i < panes.length; i++) {
                                    panes[i].style.display = 'none';
                                }
                            } catch (e) {}
                        }, 100);
                        return;
                    }
                    // Interactive path (initial Compare
                    // OR revisit after AI Summary). Track
                    // changes must be enabled on every
                    // document load so the Changes pane
                    // shows Accept/Reject buttons.
                    docxEditorRight.documentEditor.enableTrackChanges = true;
                    // Honour the "Show comparison
                    // results with tracked changes"
                    // checkbox state. EJ2 automatically
                    // shows revisions when the document
                    // loads, so we hide them when the
                    // user hasn't asked for them.
                    var checkbox = document.getElementById('crShowResultsCheckbox');
                    if (checkbox && !checkbox.checked) {
                        try { docxEditorRight.documentEditor.showRevisions = false; } catch (e) {}
                        setTimeout(function () {
                            try {
                                if (typeof docxEditorRight.closePane === 'function') {
                                    docxEditorRight.closePane();
                                }
                            } catch (e) {}
                            try {
                                var panes = rightHost.querySelectorAll('.e-de-track-changes-pane, .e-de-revision-pane, .e-de-pane');
                                for (var i = 0; i < panes.length; i++) {
                                    panes[i].style.display = 'none';
                                }
                            } catch (e) {}
                        }, 50);
                    }
                }
            });
            if (!lockForReadOnly) {
                // Only register the change-log hook on
                // the active workflow path. On the
                // read-only path (revisit after
                // Export) the editor is locked and
                // there are no accept / reject actions
                // to capture, so the hook would be
                // dead weight and would fire
                // spuriously if the user manages to
                // interact with the locked editor.
                docxEditorRight.beforeAcceptRejectChanges = function (args) {
                    if (!args) { return; }
                    var source = args.source || docxEditorRight.documentEditor;
                    var contentSfdt = '';
                    try { contentSfdt = source && source.getContent ? source.getContent() || '' : ''; } catch (e) {}
                    var snippet = '';
                    try { snippet = source && source.selection && source.selection.text ? String(source.selection.text).substring(0, 120) : ''; } catch (e) {}
                    if (bridge && typeof bridge.pushChangeLog === 'function') {
                        bridge.pushChangeLog({
                            at: Date.now(),
                            author: args.author || args.Author || 'Counterparty',
                            action: args.actionType || args.ActionType || args.action || 'Unknown',
                            detail: snippet,
                            contentSfdt: contentSfdt
                        });
                    }
                };
            }
            docxEditorRight.appendTo(rightHost);
            if (lockForReadOnly) {
                // Belt-and-braces: explicitly lock the
                // right editor and disable track
                // changes once the underlying
                // documentEditor is ready. The
                // restrictEditing flag above handles
                // the ribbon, but EJ2 also exposes
                // isReadOnly and enableTrackChanges on
                // the documentEditor itself which
                // controls the "Changes" sidebar.
                try { docxEditorRight.documentEditor.isReadOnly = true; } catch (e) {}
                try { docxEditorRight.documentEditor.enableTrackChanges = false; } catch (e) {}
                try { docxEditorRight.documentEditor.showRevisions = false; } catch (e) {}
            } else {
                // Enable track changes on every
                // interactive mount. The documentChange
                // handler above also re-enables it
                // after every document load, but we
                // set it once here so the right editor
                // is in the right state before the
                // first documentChange fires. This is
                // what surfaces the "Changes" pane
                // with Accept/Reject buttons.
                docxEditorRight.documentEditor.enableTrackChanges = true;
                try { docxEditorRight.documentEditor.isReadOnly = false; } catch (e) {}
            }
            docxEditorLeft.documentEditor.viewChange = function () {
                if (!docxEditorRight || !docxEditorRight.documentEditor) { return; }
                docxEditorRight.documentEditor.selection.setScrollPosition(docxEditorLeft.documentEditor.selection.getScrollPosition());
            };
            docxEditorRight.documentEditor.viewChange = function () {
                if (!docxEditorLeft || !docxEditorLeft.documentEditor) { return; }
                docxEditorLeft.documentEditor.selection.setScrollPosition(docxEditorRight.documentEditor.selection.getScrollPosition());
            };
        } catch (e) {
            destroy();
            return Promise.reject(new Error('Could not initialise the compare editors: ' + e.message));
        }
        // Remember which host elements the editors are
        // attached to. render() creates fresh DOM nodes
        // on every call, so a subsequent render will
        // produce different host elements - the
        // ensureEditorMount check above compares these
        // references against the current document to
        // detect orphaned editor instances.
        docxEditorLeftHost = leftHost;
        docxEditorRightHost = rightHost;
        docxMounted = true;
        return Promise.resolve();
    }

    function clearEditorHost(host) {
        if (!host) { return; }
        while (host.firstChild) { host.removeChild(host.firstChild); }
    }

    function destroyEditor(editor) {
        if (!editor) { return; }
        try { if (typeof editor.destroy === 'function') { editor.destroy(); } } catch (e) {}
    }

    function destroy() {
        destroyEditor(docxEditorLeft);
        destroyEditor(docxEditorRight);
        docxEditorLeft = null;
        docxEditorRight = null;
        docxEditorLeftHost = null;
        docxEditorRightHost = null;
        docxMounted = false;
        docsLoadedFor = '';
    }

    function openSfdtInto(editor, sfdt, name) {
        var payload = typeof sfdt === 'string' ? sfdt : JSON.stringify(sfdt);
        editor.documentEditor.open(payload);
        if (name) { try { editor.documentEditor.documentName = name; } catch (e) {} }
        return true;
    }

    function importDocxIntoEditor(editor, file, name) {
        var form = new FormData();
        form.append('file', file, file.name || 'document.docx');
        return fetch(documentEditorServiceUrl + 'Import', {
            method: 'POST', body: form
        })
            .then(function (r) {
                if (!r.ok) { throw new Error('Document service returned ' + r.status + '.'); }
                return r.text();
            })
            .then(function (sfdt) { return openSfdtInto(editor, sfdt, name); });
    }

    function loadDocxFromUrl(editor, url, name) {
        if (!editor || !editor.documentEditor) {
            return Promise.reject(new Error('Editor is not mounted yet.'));
        }
        return fetch(window.appUrl(url), { credentials: 'same-origin' })
            .then(function (r) {
                if (!r.ok) { throw new Error('Could not download the DOCX for the editor (status ' + r.status + ').'); }
                return r.blob();
            })
            .then(function (blob) {
                return importDocxIntoEditor(editor, new File([blob], name || 'document.docx', {
                    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                }), name);
            });
    }

    function runServerCompare(originalFile, revisedFile) {
        var form = new FormData();
        form.append('originalFile', originalFile, originalFile.name);
        form.append('revisedFile', revisedFile, revisedFile.name);
        form.append('author', 'Counterparty');
        form.append('dateTime', new Date().toISOString());
        return fetch(window.appUrl('/api/contract-review/compare-documents'), {
            method: 'POST', credentials: 'same-origin', body: form
        })
            .then(function (r) { return safeJson(r); })
            .then(function (env) {
                if (!env.ok || !env.payload || !env.payload.success) {
                    throw new Error(failureMessage(env, 'Compare failed'));
                }
                return env.payload;
            });
    }

    function render(panel, bridge) {
        // 40/60 grid: Original document on the left at 40%
        // of the viewport, the negotiated (revised) document
        // on the right at 60%. The left pane is read-only and
        // exists for reference; the right pane is the active
        // editing surface with track-changes enabled.
        //
        // The top "cr-compare-actions" toolbar (the
        // "Show comparison results with tracked changes"
        // toggle and the "Proceed to AI summary" button) is
        // shown in two cases:
        //   - the initial Compare step (workflow in progress)
        //   - revisit after AI Summary but before Export
        //     (allow the user to make additional
        //     accept / reject decisions and re-generate the
        //     summary with new changes)
        //
        // The toolbar is HIDDEN on revisit after Export
        // (isExportCompleted === true). The workflow is
        // fully done at that point - the Compare view
        // becomes a passive inspection of the previously
        // compared documents and the editors fill the
        // available space.
        var isExportCompleted = !!(bridge && bridge.isExportCompleted && bridge.isExportCompleted());
        var isRevisit = !!(bridge && bridge.isCompareCompleted && bridge.isCompareCompleted());
        var actionsBarHtml = isExportCompleted
            ? ''
            : '<div class="cr-compare-actions">'
                + '<label class="cr-compare-toggle"><input type="checkbox" id="crShowResultsCheckbox" /><span>Show comparison results with tracked changes</span></label>'
                + '<div class="cr-compare-buttons"><span id="crProceedSummaryHint" class="cr-compare-warning" role="status"><span class="cr-compare-warning-icon" aria-hidden="true">i</span><span>Accept or reject at least one tracked change by right-clicking it to enable AI.</span></span><button id="crProceedSummaryBtn" class="cr-btn cr-btn-primary" type="button" disabled title="Accept or reject at least one tracked change to enable.">Proceed to AI summary &rarr;</button></div>'
                + '</div>';
        panel.innerHTML = ''
            + actionsBarHtml
            + '<div class="cr-compare-grid cr-compare-grid--50-50">'
            + '<div class="cr-compare-pane cr-compare-pane--original"><div class="cr-compare-pane-header"><span><span class="cr-pane-eyebrow">Original</span><span id="crOriginalTitle">Original document</span></span></div><div class="cr-compare-pane-body"><div id="crDocxLeft" class="cr-docx-area"><div class="cr-docx-placeholder cr-editor-placeholder">The original DOCX opens here for reference.</div></div></div></div>'
            + '<div class="cr-compare-pane cr-compare-pane--revised"><div class="cr-compare-pane-header"><span><span class="cr-pane-eyebrow">Negotiated</span><span id="crRevisedTitle">Result document (with tracked changes)</span></span></div><div class="cr-compare-pane-body"><div id="crDocxRight" class="cr-docx-area"><div class="cr-docx-placeholder cr-editor-placeholder">The negotiated DOCX opens here after Compare.</div></div></div></div>'
            + '</div>'
            + '</div>';

        // Case 1 revisit: AI Summary completed but Export
        // not yet reached. Reset the change log so only
        // NEW accept / reject actions are tracked, and
        // start the "Proceed to AI summary" button in the
        // disabled state until the user makes new
        // decisions. The button is wired by
        // wireProceedSummaryButton() further down.
        //
        // Case 2 revisit: Export reached. The actions bar
        // is not rendered, so there's no button to
        // disable - we skip this branch entirely.
        if (isRevisit && !isExportCompleted) {
            if (bridge && typeof bridge.resetChangeLog === 'function') {
                console.log('[compareReview] Revisit (case 1: post-AI-summary) - resetting change log');
                bridge.resetChangeLog();
                var afterResetLog = bridge.getChangeLog ? bridge.getChangeLog() : null;
                console.log('[compareReview] After reset, change log length:', afterResetLog ? afterResetLog.length : 'N/A');
            }
            setTimeout(function () {
                var btn = proceedSummaryBtn();
                if (btn) {
                    btn.disabled = true;
                    console.log('[compareReview] Button explicitly disabled for revisit');
                }
            }, 100);
        } else {
            console.log('[compareReview] isRevisit=' + isRevisit + ', isExportCompleted=' + isExportCompleted + ', bridge=' + !!bridge);
        }

        // Only wire the topbar when the actions bar
        // exists. On case 2 revisit the bar is hidden,
        // so the checkbox + button do not exist in the
        // DOM and the wire functions would no-op anyway,
        // but gating explicitly keeps the intent clear.
        if (!isExportCompleted) {
            wireTopbar(bridge);
        }
        ensureEditorMount(bridge, isExportCompleted).then(function () {
            var original = bridgeValue(bridge, 'getOriginal');
            var negotiated = bridgeValue(bridge, 'getNegotiated');
            // Load documents into the editors when we
            // have both URLs in state, no topbar-picked
            // files are set, AND the currently-mounted
            // editor instances haven't already been
            // loaded with this document pair. The
            // `docsLoadedFor` flag is reset to '' by
            // ensureEditorMount() every time the editor
            // instances are torn down and rebuilt, so
            // navigating back to Compare via the
            // stepper always triggers a fresh load.
            if (negotiated && original && !topbarOriginalFile && !topbarRevisedFile) {
                var loadKey = (original.previewUrl || '') + '|' + (negotiated.previewUrl || '');
                if (loadKey !== docsLoadedFor) {
                    docsLoadedFor = loadKey;
                    return Promise.all([
                        loadDocxFromUrl(docxEditorLeft, original.previewUrl, 'Original document'),
                        loadDocxFromUrl(docxEditorRight, negotiated.previewUrl, 'Negotiated document')
                    ]);
                }
            }
        }).catch(function (err) { alert(err.message || 'Editor failed to start'); });
        wireProceedSummaryButton(bridge);
        // Keep the Proceed button's enabled state in sync
        // with the change log. beforeAcceptRejectChanges
        // already pushes a new entry via bridge.pushChangeLog
        // (which emits the global 'change-log' event), so
        // subscribing here covers accept / reject from the
        // EJ2 ribbon AND any other path that mutates the
        // log. We seed the initial state from
        // bridge.getChangeLog() so the button enables
        // immediately if the user is returning to Compare
        // with pre-existing entries.
        if (bridge && typeof bridge.on === 'function') {
            bridge.on('change-log', function () { refreshProceedSummaryButton(bridge); });
        }
        refreshProceedSummaryButton(bridge);
    }

    // ---------------------------------------------------------------
    // "Proceed to AI summary" button state machine
    //
    // The button lives on the Compare toolbar but is the
    // gateway to the AI summary step. Two rules govern it:
    //
    //   1. It is disabled until the user has accepted or
    //      rejected AT LEAST ONE tracked change. An empty
    //      change log means there is nothing to summarise,
    //      so jumping ahead would just produce a
    //      "No changes to summarise" page.
    //
    //   2. On click, the button does NOT immediately
    //      navigate. It first triggers the AI summary
    //      generation (bridge.ensureAiSummary) and only
    //      navigates to the summary step once the DOCX
    //      is ready. While the request is in flight the
    //      button shows "Generating AI summary..." and
    //      is disabled - mirroring the "Comparing..."
    //      state on the Import page so the user always
    //      sees feedback that work is happening before
    //      the page transition.
    // ---------------------------------------------------------------
    function proceedSummaryBtn() {
        return document.getElementById('crProceedSummaryBtn');
    }

    function proceedSummaryHasEntries(bridge) {
        if (!bridge || typeof bridge.getChangeLog !== 'function') { return false; }
        var log = bridge.getChangeLog();
        return !!(log && log.length);
    }

    function refreshProceedSummaryButton(bridge) {
        var btn = proceedSummaryBtn();
        if (!btn) { return; }
        // If the user is already mid-generation, leave the
        // button in its busy state - do not let a stray
        // change-log event flip it back to "Proceed to AI
        // summary" while the AI call is in flight.
        if (btn.dataset && btn.dataset.busy === '1') { return; }
        var hasEntries = proceedSummaryHasEntries(bridge);
        var hint = document.getElementById('crProceedSummaryHint');
        if (hint) {
            hint.hidden = hasEntries;
        }
        console.log('[compareReview] refreshProceedSummaryButton: hasEntries=' + hasEntries);
        if (bridge && typeof bridge.getChangeLog === 'function') {
            var log = bridge.getChangeLog();
            console.log('[compareReview] Current change log length:', log ? log.length : 'N/A');
        }
        btn.disabled = !hasEntries;
        console.log('[compareReview] Button disabled set to:', btn.disabled);
        if (hasEntries) {
            btn.textContent = 'Proceed to AI summary \u2192';
            btn.removeAttribute('title');
        } else {
            btn.textContent = 'Proceed to AI summary \u2192';
            btn.setAttribute('title', 'Accept or reject at least one tracked change to enable.');
        }
    }

    function setProceedSummaryBusy(btn, busy) {
        if (!btn) { return; }
        if (busy) {
            btn.dataset.busy = '1';
            btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
            btn.textContent = 'Generating AI summary\u2026';
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
        } else {
            btn.dataset.busy = '0';
            if (btn.dataset.originalText) {
                btn.textContent = btn.dataset.originalText;
                delete btn.dataset.originalText;
            }
            btn.removeAttribute('aria-busy');
        }
    }

    function wireProceedSummaryButton(bridge) {
        var btn = proceedSummaryBtn();
        if (!btn) { return; }
        btn.addEventListener('click', function () {
            if (btn.disabled) { return; }
            if (!proceedSummaryHasEntries(bridge)) {
                // Defensive: should not be reachable
                // because the button is disabled when the
                // log is empty, but guard anyway so a
                // stale click never starts an empty AI
                // summary.
                alert('Accept or reject at least one tracked change first.');
                return;
            }
            if (btn.dataset && btn.dataset.busy === '1') { return; }
            setProceedSummaryBusy(btn, true);
            var ensure = bridge && typeof bridge.ensureAiSummary === 'function'
                ? bridge.ensureAiSummary({ force: true })
                : Promise.resolve(null);
            Promise.resolve(ensure)
                .then(function () {
                    // AI summary DOCX is on disk and ready
                    // in state - safe to navigate. The
                    // summary page will pick up
                    // state.aiSummarySfdt / state.aiSummaryStatus
                    // and render the editor without
                    // triggering a second generation pass.
                    if (bridge && typeof bridge.setMode === 'function') {
                        bridge.setMode('summary');
                    }
                })
                .catch(function (err) {
                    var msg = (err && err.message) ? err.message : 'AI summary failed.';
                    alert(msg);
                    // Roll the button back so the user can
                    // retry. The change log is unchanged,
                    // so refreshProceedSummaryButton keeps
                    // it enabled.
                    setProceedSummaryBusy(btn, false);
                    refreshProceedSummaryButton(bridge);
                });
        });
    }

    function wireTopbar(bridge) {
        var checkbox = document.getElementById('crShowResultsCheckbox');
        if (checkbox) {
            checkbox.addEventListener('change', function () {
                var title = document.getElementById('crRevisedTitle');
                if (title) { title.textContent = checkbox.checked ? 'Result Document (with tracked changes)' : 'Revised Document'; }
                if (docxEditorRight && docxEditorRight.documentEditor) { 
                    docxEditorRight.documentEditor.showRevisions = checkbox.checked;
                    // Toggle the Changes pane visibility
                    setTimeout(function () {
                        try {
                            var rightHost = document.getElementById('crDocxRight');
                            if (rightHost) {
                                // Close all sidebar panes (Table of Contents, Properties, etc.)
                                // but keep the main document area visible
                                var panes = rightHost.querySelectorAll('.e-de-track-changes-pane, .e-de-revision-pane, .e-de-navigator-pane, .e-de-table-of-contents');
                                if (checkbox.checked) {
                                    // Hide all panes first
                                    for (var i = 0; i < panes.length; i++) {
                                        panes[i].style.display = 'none';
                                    }
                                    // Then show only the Changes pane
                                    var changesPanes = rightHost.querySelectorAll('.e-de-track-changes-pane, .e-de-revision-pane');
                                    for (var i = 0; i < changesPanes.length; i++) {
                                        changesPanes[i].style.display = '';
                                    }
                                } else {
                                    // Hide all sidebar panes
                                    for (var i = 0; i < panes.length; i++) {
                                        panes[i].style.display = 'none';
                                    }
                                }
                            }
                        } catch (e) {}
                    }, 50);
                }
            });
        }
    }

    window.claimContractReviewCompare = {
        render: render,
        runCompare: runCompare,
        getRightEditor: function () { return docxEditorRight; },
        destroy: destroy
    };
})();
