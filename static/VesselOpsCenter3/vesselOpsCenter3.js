/*global window, document, widget, define */

/*
 * VesselOpsCenter
 * ---------------------------------------------------------------------
 * This widget merges two source artifacts into a single DS/UWA widget
 * module:
 *
 *   1. vessel_heatmap8.html  - "Enterprise Port Command Center", a
 *      multi-tab analytics console (Executive / Vessel Tracking Matrix /
 *      Terminal & Berth / Operations & Cranes / Environmental Context)
 *      built with ApexCharts, a snapshot timeline, and filter controls.
 *
 *   2. vesselMovement2.js    - the 3D-scene twin that publishes vessel,
 *      berth and tide-gauge markers onto the platform via PlatformAPI as
 *      the timeline plays back.
 *
 * The analytics console drives the on-page UI; every time the snapshot
 * timeline moves (via the dropdown, Play, Next, or filter changes) the
 * widget both re-renders the dashboard AND re-publishes the 3D markers
 * so the map and the console always describe the same instant in time.
 * ---------------------------------------------------------------------
 */

define('VesselOpsCenter3',
[
    'UWA/Core',
    'UWA/Promise',
    'UWA/String',
    'DS/WAFData/WAFData',
    'DS/PlatformAPI/PlatformAPI',
    'DS/UIKIT/Toggler',
    'DS/UIKIT/Autocomplete',
    'DS/UIKIT/Input/Button',
    'DS/UIKIT/Scroller',
    'css!DS/UIKIT/UIKIT.css'
],

function (UWA, Promise, String, WAFData, PlatformAPI) {

'use strict';

    // ---------------------------------------------------------------------
    // CONFIG
    // ---------------------------------------------------------------------
    var CONFIG = {
        // Replace with the actual hosted location of vessel_lifecycle_simulation.csv
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselOpsCenter/vessel_lifecycle_simulation.csv',
        APEXCHARTS_URL: 'https://cdn.jsdelivr.net/npm/apexcharts',
        DEFAULT_INTERVAL_MS: 350,
        FAST_INTERVAL_MS: 100,
        VESSEL_MARKER_PREFIX: 'VESSEL_',
        BERTH_MARKER_PREFIX: 'BERTH_',
        // Elevation (meters) vessel markers are lifted above ground level so they
        // don't visually collide with the berth marker/label sitting at the same lat/lng.
        VESSEL_MARKER_ELEVATION: 80,
        VESSEL_MARKER_SCALE: 1.4,
        // Berth markers stay pinned at ground level so the gap to the vessel above is obvious.
        BERTH_MARKER_ELEVATION: 0,
        // Fixed point where the current tide reading is displayed
        TIDE_MARKER_ID: 'TIDE_GAUGE',
        TIDE_LOCATION: [18.94543, 72.92450],
        // Anchorage: vessels get a stable slot around ANCH instead of stacking on one point
        ANCHORAGE_SLOTS: 12,
        ANCHORAGE_RADIUS_DEG: 0.0018,
        // UTF-8 glyph used for vessel markers instead of an icon set
        VESSEL_SYMBOL: '\uD83D\uDEA2'
    };

    // Static reference points / berth coordinates
    var BERTHS = {
        B1: [18.936532, 72.933758], B2: [18.937983, 72.934885], B3: [18.939687, 72.936355],
        B4: [18.94753,  72.93965],  B5: [18.95031,  72.94201],  B6: [18.95470,  72.94551],
        B7: [18.95717,  72.94673],  B8: [18.95993,  72.94795],  B9: [18.96259,  72.94918],
        B10: [18.96474, 72.95038]
    };
    var ANCH = [18.93366, 72.88527];
    var CHANNEL = [18.94137, 72.90879];
    var SEA = [18.92879, 72.86845];

    var STAGES = ['PLANNING', 'ARRIVAL', 'WAITING', 'INBOUND', 'BERTHING', 'CLEARANCE', 'CARGO', 'SERVICE', 'DEPARTURE'];
    var TABS = ['executive', 'vessels', 'terminals', 'operations', 'environment'];
    var NUMERIC_FIELDS = ['teu_capacity', 'import_teu', 'export_teu', 'cranes_assigned', 'tide_level', 'anchorage_wait_hours', 'cargo_hours'];

    // ---------------------------------------------------------------------
    // APP STATE
    // ---------------------------------------------------------------------
    var app = {
        events: [],
        times: [],
        timeIndex: 0,
        vesselMarkerIds: {},      // vessel_id -> marker id currently on the platform
        berthMarkerIds: {},       // berth code -> marker id (created once)
        berthOccupied: {},        // berth code -> bool, last published occupancy
        lastPublishedTide: null,
        playbackHandle: null,
        playing: false,
        currentTab: 'executive',
        chartsMap: {},
        isFirstLoad: true,
        statusBar: null
    };

    // ---------------------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------------------
    function safe(v) { return (v === undefined || v === null || v === '') ? '-' : String(v); }

    function esc(s) {
        return safe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // CSV timestamps look like "2026-02-28 03:27:29". Swapping the space for a
    // "T" keeps Date parsing consistent across browser engines.
    function parseEventDate(s) {
        return new Date(String(s).replace(' ', 'T'));
    }

    function parseCsv(text) {
        var lines = text.replace(/\r/g, '').trim().split('\n');
        if (!lines.length) { return []; }
        var headers = lines[0].split(',').map(function (h) { return h.trim(); });
        return lines.slice(1).filter(function (l) { return l.length; }).map(function (line) {
            var parts = line.split(',');
            var obj = {};
            headers.forEach(function (h, idx) {
                var raw = (parts[idx] || '').trim();
                if (NUMERIC_FIELDS.indexOf(h) !== -1) {
                    obj[h] = raw === '' ? 0 : (parseFloat(raw) || 0);
                } else {
                    obj[h] = raw;
                }
            });
            return obj;
        });
    }

    function apiGetText(url) {
        return new Promise(function (resolve, reject) {
            WAFData.proxifiedRequest(url, {
                method: 'GET',
                type: 'text',
                onComplete: resolve,
                onFailure: function (e, d) { reject(d || e); }
            });
        });
    }

    function ensureApexCharts() {
        return new Promise(function (resolve, reject) {
            if (window.ApexCharts) { resolve(); return; }
            var s = document.createElement('script');
            s.src = CONFIG.APEXCHARTS_URL;
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('Failed to load ApexCharts from ' + CONFIG.APEXCHARTS_URL)); };
            document.head.appendChild(s);
        });
    }

    function uniqueSorted(arr) {
        var seen = {}, out = [];
        arr.forEach(function (v) {
            if (!seen.hasOwnProperty(v)) {
                seen[v] = true;
                out.push(v);
            }
        });
        return out.sort();
    }

    function toXY(latlon, z) {
        var p = { x: latlon[1], y: latlon[0] };
        if (z) { p.z = z; }
        return p;
    }

    function removeContent(id) {
        if (!id) { return; }
        PlatformAPI.publish('3DEXPERIENCity.RemoveContent', id);
    }

    function setStatus(text, isError) {
        if (!app.statusBar) { return; }
        app.statusBar.textContent = text;
        app.statusBar.style.color = isError ? '#C0392B' : '#374151';
    }

    // Gives each vessel a stable slot on a small ring around ANCH so that when several
    // vessels are anchored at once they fan out instead of stacking on a single point.
    function anchorageOffset(vesselId) {
        var numPart = parseInt(String(vesselId).replace(/[^0-9]/g, ''), 10) || 0;
        var slots = CONFIG.ANCHORAGE_SLOTS;
        var idx = numPart % slots;
        var angle = (2 * Math.PI * idx) / slots;
        var r = CONFIG.ANCHORAGE_RADIUS_DEG;
        var latOffset = r * Math.sin(angle);
        var lonOffset = (r * Math.cos(angle)) / Math.cos(ANCH[0] * Math.PI / 180);
        return [ANCH[0] + latOffset, ANCH[1] + lonOffset];
    }

    // Mirrors pos() from the HTML twin (same precedence order), with anchored vessels
    // spread around ANCH via anchorageOffset() instead of all sharing one exact point.
    function posFor(ev) {
        if (ev.substage && ev.substage.indexOf('ANCHORAGE') !== -1) { return anchorageOffset(ev.vessel_id); }
        if (ev.stage === 'INBOUND' || ev.stage === 'BERTHING') { return CHANNEL; }
        if (ev.berth && (ev.stage === 'CARGO' || ev.stage === 'SERVICE' || ev.stage === 'CLEARANCE' ||
                ev.stage === 'BERTHING' || ev.substage === 'ALL_FAST')) {
            return BERTHS[ev.berth] || SEA;
        }
        return SEA;
    }

    // ---------------------------------------------------------------------
    // STATIC BERTH MARKERS (created once at load, icon pins on the quay)
    // ---------------------------------------------------------------------
    function initBerthMarkers() {
        Object.keys(BERTHS).forEach(function (b) {
            var markerId = CONFIG.BERTH_MARKER_PREFIX + b;
            app.berthMarkerIds[b] = markerId;
            app.berthOccupied[b] = false;
            PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
                widgetID: widget.id,
                position: toXY(BERTHS[b], CONFIG.BERTH_MARKER_ELEVATION),
                layer: {
                    id: markerId,
                    name: b,
                    description: '<b>Berth:</b> ' + b + '<br><b>Status:</b> Free'
                },
                render: {
                    style: 'icon',
                    color: '#2ca02c',
                    iconName: 'transportation-dock'
                },
                options: { projection: { from: 'WGS84' } }
            });
        });
    }

    // Re-publishes a berth marker with updated colour when occupancy changes
    function setBerthOccupied(b, occupied) {
        if (!BERTHS[b] || app.berthOccupied[b] === occupied) { return; }
        app.berthOccupied[b] = occupied;
        removeContent(app.berthMarkerIds[b]);
        var markerId = CONFIG.BERTH_MARKER_PREFIX + b;
        app.berthMarkerIds[b] = markerId;
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: toXY(BERTHS[b], CONFIG.BERTH_MARKER_ELEVATION),
            layer: {
                id: markerId,
                name: b,
                description: '<b>Berth:</b> ' + b + '<br><b>Status:</b> ' + (occupied ? 'Occupied' : 'Free')
            },
            render: {
                style: 'icon',
                color: occupied ? '#d62728' : '#2ca02c',
                iconName: 'transportation-dock'
            },
            options: { projection: { from: 'WGS84' } }
        });
    }

    // ---------------------------------------------------------------------
    // TIDE GAUGE MARKER (fixed location, updated whenever the tide value changes)
    // ---------------------------------------------------------------------
    function publishTideMarker(value) {
        if (app.lastPublishedTide === value) { return; }
        app.lastPublishedTide = value;
        removeContent(CONFIG.TIDE_MARKER_ID);
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: toXY(CONFIG.TIDE_LOCATION, 0),
            layer: {
                id: CONFIG.TIDE_MARKER_ID,
                name: '\uD83C\uDF0A ' + esc(value),
                description: '<b>Current Tide:</b> ' + esc(value) + ' / 5.0'
            },
            render: {
                style: 'text',
                text: '\uD83C\uDF0A ' + safe(value),
                color: '#d62728',
                scale: 1.2
            },
            options: { projection: { from: 'WGS84' } }
        });
    }

    // ---------------------------------------------------------------------
    // VESSEL MARKERS
    // ---------------------------------------------------------------------
    function publishVesselMarker(ev) {
        var id = ev.vessel_id;
        var markerId = CONFIG.VESSEL_MARKER_PREFIX + id;
        removeContent(app.vesselMarkerIds[id]); // drop previous position marker for this vessel, if any
        app.vesselMarkerIds[id] = markerId;
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: toXY(posFor(ev), CONFIG.VESSEL_MARKER_ELEVATION),
            layer: {
                id: markerId,
                name: '\uD83D\uDEF3\uFE0F' + id,
                description:
                    '<b>Vessel:</b> ' + esc(id) + '<br>' +
                    '<b>Voyage:</b> ' + esc(ev.voyage_no) + '<br>' +
                    '<b>Line:</b> ' + esc(ev.shipping_line) + '<br>' +
                    '<b>Type:</b> ' + esc(ev.container_type) + '<br>' +
                    '<b>Terminal:</b> ' + esc(ev.terminal) + '<br>' +
                    '<b>Berth:</b> ' + esc(ev.berth) + '<br>' +
                    '<b>Stage:</b> ' + esc(ev.stage) + '<br>' +
                    '<b>Substage:</b> ' + esc(ev.substage) + '<br>' +
                    '<b>Import/Export TEU:</b> ' + safe(ev.import_teu) + ' / ' + safe(ev.export_teu)
            },
            render: {
                style: 'text', // glyph-based marker; if your platform names this style differently
                                // (e.g. 'label'), swap it here - the rest of the payload is unchanged.
                text: CONFIG.VESSEL_SYMBOL,
                color: '#0B5CAB',
                scale: CONFIG.VESSEL_MARKER_SCALE
            },
            options: { projection: { from: 'WGS84' } }
        });
    }

    // Publishes the 3D scene (vessel positions, berth occupancy, tide gauge) so it
    // matches whatever instant the analytics console is currently showing.
    function syncSceneMarkers(metadata, envTide) {
        var occupied = {};
        Object.keys(metadata).forEach(function (key) {
            var meta = metadata[key];
            if (meta.latestRow) { publishVesselMarker(meta.latestRow); }
            if (meta.berth !== '-' && meta.hasArrived && !meta.hasDeparted) {
                occupied[meta.berth] = true;
            }
        });
        Object.keys(BERTHS).forEach(function (b) {
            setBerthOccupied(b, !!occupied[b]);
        });
        publishTideMarker(typeof envTide === 'number' ? envTide.toFixed(2) : safe(envTide));
    }



    // ---------------------------------------------------------------------
    // UI - STYLES
    // ---------------------------------------------------------------------
    var STYLE =
        '<style>' +
        /* ---- reset / base ---- */
        '.voc-wrap,.voc-wrap *{box-sizing:border-box;}' +
        /* Outer scrollable container.
         * min-height:100vh fills the widget's iframe viewport (= the panel height).
         * width:100% + overflow:auto gives on-demand scroll in both axes.
         * position:relative lets the absolute-positioned settings modal stay inside. */
        '.voc-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
            'background:#f3f4f6;color:#1f2937;line-height:1.4;' +
            'width:100%;min-height:100vh;overflow:auto;' +
            '-webkit-overflow-scrolling:touch;position:relative;}' +
        /* inner padding box so content never bleeds to edge */
        '.voc-inner{padding:14px;min-width:420px;}' +

        /* ---- top header bar ---- */
        '.voc-topbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;position:relative;}' +
        '.voc-topbar-left{flex:1;min-width:0;}' +
        '.voc-title{font-size:1.2rem;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.voc-subtitle{font-size:11px;color:#6b7280;}' +
        '.voc-topbar-right{display:flex;gap:6px;align-items:center;flex-shrink:0;}' +
        /* active tab badge */
        '.voc-active-badge{font-size:11.5px;font-weight:600;color:#3b82f6;background:#eff6ff;' +
            'border:1px solid #bfdbfe;padding:3px 9px;border-radius:20px;white-space:nowrap;cursor:default;}' +
        /* icon buttons */
        '.voc-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid #d1d5db;background:#fff;' +
            'cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;' +
            'transition:background .15s,border-color .15s;}' +
        '.voc-icon-btn:hover{background:#f0f9ff;border-color:#93c5fd;}' +
        '.voc-icon-btn.voc-active{background:#eff6ff;border-color:#3b82f6;}' +

        /* ---- status bar ---- */
        '.voc-status-bar{font-size:11px;color:#374151;background:#fff;padding:6px 10px;border-radius:6px;' +
            'margin-bottom:11px;box-shadow:0 1px 3px rgba(0,0,0,.05);word-break:break-all;}' +

        /* ---- burger dropdown menu ---- */
        '.voc-burger-menu{position:absolute;top:42px;right:0;z-index:200;' +
            'background:#fff;border:1px solid #e5e7eb;border-radius:10px;' +
            'box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:230px;padding:6px 0;display:none;}' +
        '.voc-burger-menu.voc-open{display:block;}' +
        '.voc-menu-section{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;' +
            'letter-spacing:.06em;padding:8px 14px 4px;}' +
        '.voc-menu-item{display:flex;align-items:center;gap:9px;padding:9px 14px;font-size:13px;' +
            'font-weight:500;color:#374151;cursor:pointer;transition:background .12s;}' +
        '.voc-menu-item:hover{background:#f0f9ff;color:#2563eb;}' +
        '.voc-menu-item.voc-menu-active{background:#eff6ff;color:#2563eb;font-weight:700;}' +
        '.voc-menu-divider{border:none;border-top:1px solid #f3f4f6;margin:4px 0;}' +
        '.voc-menu-icon{font-size:14px;width:18px;text-align:center;}' +

        /* ---- settings modal overlay ---- */
        '.voc-modal-backdrop{position:absolute;inset:0;background:rgba(17,24,39,.35);z-index:300;display:none;align-items:flex-start;justify-content:center;padding-top:50px;}' +
        '.voc-modal-backdrop.voc-open{display:flex;}' +
        '.voc-modal{background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.18);' +
            'width:90%;max-width:680px;max-height:82vh;overflow-y:auto;display:flex;flex-direction:column;}' +
        '.voc-modal-header{display:flex;align-items:center;justify-content:space-between;' +
            'padding:14px 18px;border-bottom:1px solid #f3f4f6;position:sticky;top:0;background:#fff;z-index:1;}' +
        '.voc-modal-title{font-size:15px;font-weight:700;color:#111827;}' +
        '.voc-modal-close{width:30px;height:30px;border-radius:6px;border:1px solid #e5e7eb;' +
            'background:#fff;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;}' +
        '.voc-modal-close:hover{background:#fee2e2;border-color:#fca5a5;}' +
        '.voc-modal-body{padding:16px 18px;display:flex;flex-direction:column;gap:14px;}' +
        /* playback row inside modal */
        '.voc-pb-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;}' +
        '.voc-pb-row .voc-cg{flex:1;min-width:140px;}' +
        /* modal apply button */
        '.voc-modal-footer{padding:12px 18px;border-top:1px solid #f3f4f6;display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;background:#fff;}' +

        /* ---- shared form control group ---- */
        '.voc-cg{display:flex;flex-direction:column;gap:4px;}' +
        '.voc-cg label{font-weight:600;font-size:11px;color:#4b5563;}' +
        '.voc-cg select,.voc-cg input[type="text"]{padding:7px 10px;font-size:13px;border-radius:6px;' +
            'border:1px solid #d1d5db;background:#fff;width:100%;outline:none;}' +
        '.voc-cg select:focus,.voc-cg input[type="text"]:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.15);}' +
        '.voc-filters-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;}' +

        /* ---- buttons ---- */
        '.voc-btn{padding:8px 14px;font-size:13px;font-weight:600;border-radius:6px;' +
            'border:1px solid #d1d5db;background:#fff;cursor:pointer;white-space:nowrap;transition:all .15s;}' +
        '.voc-btn:hover{background:#f9fafb;border-color:#9ca3af;}' +
        '.voc-btn.voc-active{background:#fee2e2;color:#ef4444;border-color:#fca5a5;}' +
        '.voc-btn-primary{background:#2563eb;color:#fff;border-color:#2563eb;}' +
        '.voc-btn-primary:hover{background:#1d4ed8;border-color:#1d4ed8;}' +

        /* ---- tab content panes ---- */
        '.voc-tab-content{display:none;}' +
        '.voc-tab-content.voc-tab-content-active{display:block;}' +

        /* ---- KPI cards ---- */
        '.voc-kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;margin-bottom:13px;}' +
        '.voc-kpi-card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);display:flex;flex-direction:column;}' +
        '.voc-kpi-card label{font-size:10.5px;font-weight:600;color:#4b5563;margin-bottom:2px;}' +
        '.voc-kpi-val{font-size:18px;font-weight:700;color:#111827;margin-bottom:5px;}' +
        '.voc-kpi-explanation{font-size:10px;color:#6b7280;border-top:1px dashed #e5e7eb;padding-top:4px;font-style:italic;line-height:1.3;}' +

        /* ---- vessel matrix ---- */
        '.voc-vessel-panel-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;}' +
        '@media(max-width:1024px){.voc-vessel-panel-grid{grid-template-columns:1fr;}}' +
        '.voc-matrix-container{background:#fff;padding:14px;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.05);overflow-x:auto;margin-bottom:14px;}' +
        '.voc-matrix-container table{width:100%;border-collapse:collapse;min-width:850px;text-align:center;}' +
        '.voc-matrix-container th,.voc-matrix-container td{padding:8px 5px;border:1px solid #e5e7eb;font-size:11.5px;}' +
        '.voc-matrix-container th{background:#f9fafb;font-weight:600;color:#374151;}' +
        '.voc-vessel-row{cursor:pointer;}' +
        '.voc-vessel-row:hover td{background:#f8fafc;}' +
        '.voc-vessel-axis-cell{text-align:left;font-weight:bold;background:#f9fafb;min-width:180px;color:#111827;position:sticky;left:0;box-shadow:2px 0 5px -2px rgba(0,0,0,.1);}' +
        '.voc-drilldown-row{background:#f8fafc;display:none;}' +
        '.voc-drilldown-container{padding:10px;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:6px;margin:4px auto;width:98%;overflow-x:auto;}' +
        '.voc-subtable{width:100%;border-collapse:collapse;min-width:700px;}' +
        '.voc-subtable th{background:#f1f5f9;color:#475569;font-size:10.5px;padding:5px;}' +
        '.voc-subtable td{padding:5px;font-size:10.5px;border:1px solid #e2e8f0;background:#fff;}' +
        '.voc-berth-badge{display:inline-block;padding:2px 4px;font-size:10px;border-radius:4px;font-weight:600;margin-top:4px;background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;}' +
        '.voc-delay-warning-tag{display:block;font-size:9px;color:#b91c1c;font-weight:bold;margin-top:4px;text-transform:uppercase;background:rgba(254,226,226,.6);padding:1px 2px;border-radius:3px;}' +
        '.voc-cell-empty{background:#fcfcfd;color:#d1d5db;}' +
        '.voc-cell-low{background:#dcfce7;color:#166534;}' +
        '.voc-cell-med{background:#eff6ff;color:#1e40af;}' +
        '.voc-cell-critical{background:#fee2e2;color:#991b1b;}' +

        /* ---- charts ---- */
        '.voc-charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:8px;}' +
        '.voc-chart-card{background:#fff;padding:14px;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.05);width:100%;overflow:hidden;display:flex;flex-direction:column;}' +
        '.voc-chart-card.voc-span2{grid-column:1/-1;}' +
        '.voc-chart-title{font-weight:600;font-size:13px;color:#374151;margin-bottom:2px;border-bottom:1px solid #e5e7eb;padding-bottom:5px;}' +
        '.voc-chart-explanation{font-size:10.5px;color:#6b7280;font-style:italic;margin-bottom:10px;margin-top:2px;line-height:1.3;}' +
        '.voc-grid-col{display:flex;flex-direction:column;gap:14px;}' +
        '.voc-tip{font-size:11px;color:#6b7280;font-style:italic;display:block;margin-bottom:8px;}' +
        '</style>';

    // ---- small helpers ----
    function kpiCard(id, label, color, explanation) {
        return '<div class="voc-kpi-card" style="border-left:4px solid ' + color + ';">' +
            '<label>' + label + '</label>' +
            '<div class="voc-kpi-val" id="' + id + '">-</div>' +
            '<div class="voc-kpi-explanation">' + explanation + '</div>' +
            '</div>';
    }

    var TAB_META = [
        { id: 'executive',   icon: '\uD83D\uDCCA', label: 'Executive Insights' },
        { id: 'vessels',     icon: '\uD83D\uDEA2', label: 'Vessel Tracking Matrix' },
        { id: 'terminals',   icon: '\u2693',        label: 'Terminal \u0026 Berth' },
        { id: 'operations',  icon: '\uD83C\uDFF7\uFE0F', label: 'Operations \u0026 Cranes' },
        { id: 'environment', icon: '\uD83C\uDF21\uFE0F', label: 'Environmental Context' }
    ];

    function buildHtml() {
        // ---- burger dropdown items ----
        var menuItems = '';
        menuItems += '<div class="voc-menu-section">Navigate</div>';
        TAB_META.forEach(function (t) {
            menuItems += '<div class="voc-menu-item" id="voc-menu-' + t.id + '" data-tab="' + t.id + '">' +
                '<span class="voc-menu-icon">' + t.icon + '</span>' + t.label + '</div>';
        });
        menuItems += '<hr class="voc-menu-divider">' +
            '<div class="voc-menu-item" id="voc-menu-open-settings">' +
                '<span class="voc-menu-icon">\u2699\uFE0F</span>Simulation Controls' +
            '</div>';

        // ---- settings modal body ----
        var modal =
            '<div class="voc-modal-backdrop" id="voc-settings-backdrop">' +
                '<div class="voc-modal">' +
                    '<div class="voc-modal-header">' +
                        '<span class="voc-modal-title">\u2699\uFE0F Simulation &amp; Filter Controls</span>' +
                        '<button class="voc-modal-close" id="voc-modal-close-btn">\u00D7</button>' +
                    '</div>' +
                    '<div class="voc-modal-body">' +

                        // Playback row
                        '<div class="voc-pb-row">' +
                            '<div class="voc-cg" style="flex:2;min-width:200px;">' +
                                '<label for="voc-ts-select">Snapshot Timeline</label>' +
                                '<select id="voc-ts-select"></select>' +
                            '</div>' +
                            '<div class="voc-cg">' +
                                '<label>Playback</label>' +
                                '<div style="display:flex;gap:6px;">' +
                                    '<button class="voc-btn" id="voc-play-btn">\u25B6 Play</button>' +
                                    '<button class="voc-btn" id="voc-next-btn">Next \u2794</button>' +
                                '</div>' +
                            '</div>' +
                            '<div class="voc-cg" style="min-width:90px;">' +
                                '<label for="voc-speed">Speed</label>' +
                                '<select id="voc-speed">' +
                                    '<option value="' + CONFIG.DEFAULT_INTERVAL_MS + '">Normal</option>' +
                                    '<option value="' + CONFIG.FAST_INTERVAL_MS + '">Fast</option>' +
                                '</select>' +
                            '</div>' +
                        '</div>' +

                        // Filters grid
                        '<div class="voc-filters-grid">' +
                            '<div class="voc-cg">' +
                                '<label for="voc-date-filter">Date Scope</label>' +
                                '<select id="voc-date-filter">' +
                                    '<option value="ALL" selected>All Simulation History</option>' +
                                    '<option value="2026-02-28">2026-02-28 (Day 1)</option>' +
                                    '<option value="2026-03-01">2026-03-01 (Day 2)</option>' +
                                    '<option value="2026-03-02">2026-03-02 (Day 3)</option>' +
                                    '<option value="2026-03-03">2026-03-03 (Day 4)</option>' +
                                    '<option value="2026-03-04">2026-03-04 (Day 5)</option>' +
                                    '<option value="2026-03-05">2026-03-05 (Day 6)</option>' +
                                    '<option value="2026-03-06">2026-03-06 (Day 7)</option>' +
                                    '<option value="2026-03-07">2026-03-07 (Day 8)</option>' +
                                '</select>' +
                            '</div>' +
                            '<div class="voc-cg">' +
                                '<label for="voc-shift-filter">Work Shift</label>' +
                                '<select id="voc-shift-filter">' +
                                    '<option value="ALL" selected>All Shifts (24 h)</option>' +
                                    '<option value="MORNING">Morning (06:00-14:00)</option>' +
                                    '<option value="AFTERNOON">Afternoon (14:00-22:00)</option>' +
                                    '<option value="NIGHT">Night (22:00-06:00)</option>' +
                                '</select>' +
                            '</div>' +
                            '<div class="voc-cg">' +
                                '<label for="voc-status-filter">Vessel Pipeline</label>' +
                                '<select id="voc-status-filter">' +
                                    '<option value="IN_PORT" selected>In Port (Active Ops)</option>' +
                                    '<option value="ALL">All Tracked Voyages</option>' +
                                    '<option value="PRE_ARRIVAL">Pre-Arrival Only</option>' +
                                    '<option value="DEPARTED">Departed Only</option>' +
                                '</select>' +
                            '</div>' +
                            '<div class="voc-cg">' +
                                '<label for="voc-matrix-sort">Matrix Sort</label>' +
                                '<select id="voc-matrix-sort">' +
                                    '<option value="TOTAL_TIME_DESC">Total Time (Max\u2794Min)</option>' +
                                    '<option value="RECENT_EVENT_DESC" selected>Most Recent Update</option>' +
                                    '<option value="VESSEL_ID_ASC">Vessel ID (A\u2794Z)</option>' +
                                    '<option value="CARGO_VOLUME_DESC">Cargo Volume (Max TEU)</option>' +
                                '</select>' +
                            '</div>' +
                            '<div class="voc-cg" style="grid-column:1/-1;">' +
                                '<label for="voc-search-input">Quick Search</label>' +
                                '<input type="text" id="voc-search-input" placeholder="Search vessel ID, line, substage\u2026">' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="voc-modal-footer">' +
                        '<button class="voc-btn voc-btn-primary" id="voc-modal-apply-btn">Apply \u2714</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        // ---- tab content panes (unchanged) ----
        var panes =
            '<div id="voc-tab-executive" class="voc-tab-content voc-tab-content-active">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-exe-tat', 'Avg Turnaround Time (TAT)', '#3b82f6', 'Total elapsed hours from port entry to open-sea departure.') +
                    kpiCard('voc-kpi-exe-cap', 'Capacity Utilization Load', '#10b981', 'Active TEU exchange vs total fleet capacity.') +
                    kpiCard('voc-kpi-exe-delpct', 'Delayed Voyage Ratio', '#ef4444', 'Share of voyages reporting active disruption logs.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card"><div class="voc-chart-title">Congestion Gaps by Carrier Line (Hours)</div><div class="voc-chart-explanation">Accumulated demurrage/idle hours by carrier.</div><div id="voc-exe-demurrage-chart"></div></div>' +
                    '<div class="voc-chart-card"><div class="voc-chart-title">Delay Factor Distribution</div><div class="voc-chart-explanation">Leading operational bottleneck root-causes.</div><div id="voc-exe-delay-pie"></div></div>' +
                '</div>' +
            '</div>' +

            '<div id="voc-tab-vessels" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-vsl-active', 'Active Hulls In Port', '#2563eb', 'Vessels currently berthed or transiting.') +
                    kpiCard('voc-kpi-vsl-plan', 'Pre-Arrival Pipeline', '#d97706', 'Vessels in planning with active ETA receipts.') +
                    kpiCard('voc-kpi-vsl-anch', 'Avg Anchorage Wait', '#dc2626', 'Average wait at anchorage for pilot access.') +
                '</div>' +
                '<div class="voc-vessel-panel-grid">' +
                    '<div class="voc-matrix-container">' +
                        '<span class="voc-tip">\uD83D\uDCA1 Click a row to expand the sub-stage timeline.</span>' +
                        '<table><thead><tr id="voc-matrix-header"></tr></thead><tbody id="voc-matrix-body"></tbody></table>' +
                    '</div>' +
                    '<div class="voc-grid-col">' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Fleet Mix Profile</div><div id="voc-vsl-mix-donut"></div></div>' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Capacity Ranges (TEU)</div><div id="voc-vsl-capacity-bar"></div></div>' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Queue Count by Stage</div><div id="voc-vsl-stage-bar"></div></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            '<div id="voc-tab-terminals" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-term-imp', 'Total Imports Handled', '#059669', 'Cumulative discharge TEU up to selected timestamp.') +
                    kpiCard('voc-kpi-term-exp', 'Total Exports Handled', '#0891b2', 'Cumulative load TEU processed outbound.') +
                    kpiCard('voc-kpi-term-occupancy', 'Berth Occupancy Index', '#4f46e5', 'Percentage of berths currently occupied.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2"><div class="voc-chart-title">Terminal \u2794 Berth Imports &amp; Exports</div><div class="voc-chart-explanation">Import vs Export TEU per berth node.</div><div id="voc-term-geo-bar"></div></div>' +
                    '<div class="voc-chart-card voc-span2"><div class="voc-chart-title">Container Type Proportions</div><div class="voc-chart-explanation">Dry Van vs Reefer Cargo distribution.</div><div id="voc-term-type-pie"></div></div>' +
                '</div>' +
            '</div>' +

            '<div id="voc-tab-operations" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-ops-cranes', 'Avg Cranes Assigned', '#7c3aed', 'Mean crane sets allocated per vessel cargo phase.') +
                    kpiCard('voc-kpi-ops-speed', 'Mean Crane Velocity', '#2563eb', 'TEU/hr across cargo operations.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2"><div class="voc-chart-title">Crane Density vs Handling Velocity</div><div class="voc-chart-explanation">Scatter: does more cranes = faster handling?</div><div id="voc-ops-efficiency-scatter"></div></div>' +
                '</div>' +
            '</div>' +

            '<div id="voc-tab-environment" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-env-weather', 'Current Weather', '#4b5563', 'Atmospheric descriptor at current snapshot.') +
                    kpiCard('voc-kpi-env-tide', 'Tide Water Level', '#06b6d4', 'Hydrographic level (m) \u2014 also drives the 3D tide marker.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2"><div class="voc-chart-title">Tide Fluctuations vs Active Disruptions</div><div class="voc-chart-explanation">Cross-references water level against delay spike frequency.</div><div id="voc-env-tide-line"></div></div>' +
                '</div>' +
            '</div>';

        return STYLE +
            '<div class="voc-wrap">' +
                '<div class="voc-inner">' +
                    // top bar
                    '<div class="voc-topbar">' +
                        '<div class="voc-topbar-left">' +
                            '<div class="voc-title">\u2693 Enterprise Port Command Center</div>' +
                            '<div class="voc-subtitle">Synced live with the 3D port scene</div>' +
                        '</div>' +
                        '<div class="voc-topbar-right">' +
                            '<span class="voc-active-badge" id="voc-active-badge">Executive Insights</span>' +
                            '<button class="voc-icon-btn" id="voc-settings-btn" title="Simulation Controls">\u2699\uFE0F</button>' +
                            '<button class="voc-icon-btn" id="voc-burger-btn" title="Navigate">\u2630</button>' +
                        '</div>' +
                        // burger dropdown (absolutely positioned inside topbar)
                        '<div class="voc-burger-menu" id="voc-burger-menu">' + menuItems + '</div>' +
                    '</div>' +

                    // status bar
                    '<div class="voc-status-bar" id="voc-status">Initializing\u2026</div>' +

                    // tab panes
                    panes +

                    // settings modal (absolute overlay anchored to .voc-inner)
                    modal +
                '</div>' +
            '</div>';
    }

    // -----------------------------------------------------------------------
    // initUi — wire up burger menu, settings modal, filter events, drilldown
    // -----------------------------------------------------------------------
    function initUi() {
        widget.body.empty();
        UWA.createElement('div', { html: buildHtml() }).inject(widget.body);

        // .voc-inner must be position:relative so the absolute-positioned modal stays inside it
        var inner = document.querySelector('.voc-inner');
        if (inner) { inner.style.position = 'relative'; }

        app.statusBar = document.getElementById('voc-status');

        // ---- burger menu ----
        var burgerBtn  = document.getElementById('voc-burger-btn');
        var burgerMenu = document.getElementById('voc-burger-menu');

        burgerBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            burgerMenu.classList.toggle('voc-open');
            burgerBtn.classList.toggle('voc-active');
        });

        // Tab navigation items inside burger menu
        TAB_META.forEach(function (t) {
            var item = document.getElementById('voc-menu-' + t.id);
            if (!item) { return; }
            item.addEventListener('click', function () {
                switchTab(t.id);
                burgerMenu.classList.remove('voc-open');
                burgerBtn.classList.remove('voc-active');
            });
        });

        // "Simulation Controls" item in burger opens the settings modal
        document.getElementById('voc-menu-open-settings').addEventListener('click', function () {
            burgerMenu.classList.remove('voc-open');
            burgerBtn.classList.remove('voc-active');
            openSettingsModal();
        });

        // ---- settings icon button (top-right) ----
        document.getElementById('voc-settings-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            openSettingsModal();
        });

        // ---- settings modal close / apply ----
        document.getElementById('voc-modal-close-btn').addEventListener('click', closeSettingsModal);
        document.getElementById('voc-modal-apply-btn').addEventListener('click', function () {
            renderActiveTab();
            closeSettingsModal();
        });
        // clicking backdrop outside the modal card closes it
        document.getElementById('voc-settings-backdrop').addEventListener('click', function (e) {
            if (e.target === this) { closeSettingsModal(); }
        });

        // ---- timeline / filter change events (live — fire without needing Apply) ----
        document.getElementById('voc-ts-select').addEventListener('change', function () {
            var idx = app.times.indexOf(this.value);
            if (idx !== -1) { app.timeIndex = idx; }
            renderActiveTab();
        });
        document.getElementById('voc-date-filter').addEventListener('change', renderActiveTab);
        document.getElementById('voc-shift-filter').addEventListener('change', renderActiveTab);
        document.getElementById('voc-status-filter').addEventListener('change', renderActiveTab);
        document.getElementById('voc-matrix-sort').addEventListener('change', renderActiveTab);
        document.getElementById('voc-search-input').addEventListener('input', renderActiveTab);

        // ---- playback ----
        document.getElementById('voc-play-btn').addEventListener('click', togglePlayback);
        document.getElementById('voc-next-btn').addEventListener('click', function () { stepPlayback(1); });

        // ---- close burger when clicking anywhere else ----
        document.addEventListener('click', function () {
            burgerMenu.classList.remove('voc-open');
            burgerBtn.classList.remove('voc-active');
        });

        // ---- vessel drilldown rows (event delegation on tbody) ----
        document.getElementById('voc-matrix-body').addEventListener('click', function (e) {
            var target = e.target;
            var row = null;
            while (target && target !== this) {
                if (target.className && String(target.className).indexOf('voc-vessel-row') !== -1) { row = target; break; }
                target = target.parentNode;
            }
            if (!row) { return; }
            var key = row.getAttribute('data-key');
            var sub = document.getElementById('voc-sub-' + key);
            if (sub) { sub.style.display = (sub.style.display === 'table-row') ? 'none' : 'table-row'; }
        });
    }

    function openSettingsModal() {
        var backdrop = document.getElementById('voc-settings-backdrop');
        if (backdrop) { backdrop.classList.add('voc-open'); }
    }

    function closeSettingsModal() {
        var backdrop = document.getElementById('voc-settings-backdrop');
        if (backdrop) { backdrop.classList.remove('voc-open'); }
    }

    function populateTimelineSelect() {
        var select = document.getElementById('voc-ts-select');
        select.innerHTML = '';
        app.times.forEach(function (ts) {
            var opt = document.createElement('option');
            opt.value = ts;
            opt.textContent = ts;
            select.appendChild(opt);
        });
    }

    // ---------------------------------------------------------------------
    // CHART RENDERING (ApexCharts)
    // ---------------------------------------------------------------------

    // Debounced resize: when multiple charts are created in one render pass
    // (e.g. all three charts on the Vessels tab), we fire a single resize
    // event 220ms after the LAST creation so ApexCharts can recalculate
    // dimensions if the container was still being laid out.
    var _resizeTimer = null;
    function scheduleResizeNudge() {
        window.clearTimeout(_resizeTimer);
        _resizeTimer = window.setTimeout(function () {
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        }, 220);
    }

    function safeRender(id, config) {
        var el = document.getElementById(id);
        if (!el || !window.ApexCharts) { return; }

        if (app.chartsMap[id]) {
            // Chart already exists — just update the data, no rebuild needed.
            config.chart.animations = { enabled: false };
            app.chartsMap[id].updateOptions(config, true, false);
        } else {
            // First time on this chart container — create and render.
            // NOTE: do NOT check el.offsetWidth here.  In many platform
            // environments (and in jsdom) offsetWidth is 0 even on visible
            // elements.  Checking it caused a destroy-recreate loop on every
            // render tick, preventing charts from ever stabilising.
            // Instead we rely on redrawOnParentResize / redrawOnWindowResize
            // and the scheduleResizeNudge() call below to fix any zero-size
            // render that happened while layout was still in progress.
            config.chart.animations          = { enabled: app.isFirstLoad, animateOnDataChange: false };
            config.chart.redrawOnParentResize = true;
            config.chart.redrawOnWindowResize = true;
            app.chartsMap[id] = new window.ApexCharts(el, config);
            app.chartsMap[id].render();
            scheduleResizeNudge();
        }
    }

    function renderBarChart(id, categories, data, label) {
        safeRender(id, {
            series: [{ name: label, data: data }],
            chart: { type: 'bar', height: 200, toolbar: { show: false } },
            colors: ['#3b82f6'],
            plotOptions: { bar: { dataLabels: { position: 'top' } } },
            xaxis: { categories: categories, labels: { rotate: -45, style: { fontSize: '9px' } } },
            dataLabels: { enabled: true, style: { fontSize: '10px', colors: ['#333'] }, offsetY: -18 }
        });
    }

    function renderClusteredBarChart(id, categories, importData, exportData) {
        safeRender(id, {
            series: [
                { name: 'Imports Throughput (TEU)', data: importData },
                { name: 'Exports Throughput (TEU)', data: exportData }
            ],
            chart: { type: 'bar', height: 280, toolbar: { show: false } },
            colors: ['#059669', '#0891b2'],
            plotOptions: { bar: { dataLabels: { position: 'top' }, columnWidth: '65%' } },
            xaxis: { categories: categories, labels: { rotate: -45, style: { fontSize: '9px' } } },
            dataLabels: { enabled: true, style: { fontSize: '9px', colors: ['#333'] }, offsetY: -16 },
            legend: { position: 'top', horizontalAlign: 'right' }
        });
    }

    function renderDonutChart(id, labels, series) {
        safeRender(id, {
            series: series, labels: labels,
            chart: { type: 'pie', height: 200 },
            legend: { position: 'bottom', fontSize: '10px' }
        });
    }

    function renderScatterChart(id, points) {
        safeRender(id, {
            series: [{ name: 'Vessel Performance', data: points }],
            chart: { type: 'scatter', height: 240, toolbar: { show: false } },
            xaxis: { title: { text: 'Cranes Allocated', style: { fontSize: '11px' } }, tickAmount: 4 },
            yaxis: { title: { text: 'Velocity (TEU/hr)', style: { fontSize: '11px' } } }
        });
    }

    function renderDualAxisLineChart(id, categories, lineData, barData) {
        safeRender(id, {
            series: [{ name: 'Tide Level (m)', type: 'line', data: lineData }, { name: 'Active Delays', type: 'column', data: barData }],
            chart: { height: 240, type: 'line', toolbar: { show: false } },
            colors: ['#06b6d4', '#ef4444'],
            stroke: { width: [3, 0] },
            xaxis: { categories: categories, labels: { show: false } },
            yaxis: [{ title: { text: 'Water Level (m)', style: { fontSize: '11px' } } }, { opposite: true, title: { text: 'Disruption Counts', style: { fontSize: '11px' } } }]
        });
    }

    // ---------------------------------------------------------------------
    // TAB SWITCHING
    // ---------------------------------------------------------------------
    function switchTab(tabId) {
        app.currentTab = tabId;
        TABS.forEach(function (t) {
            var pane = document.getElementById('voc-tab-' + t);
            if (pane) { pane.classList.remove('voc-tab-content-active'); }
            var item = document.getElementById('voc-menu-' + t);
            if (item) { item.classList.remove('voc-menu-active'); }
        });
        var activePane = document.getElementById('voc-tab-' + tabId);
        if (activePane) { activePane.classList.add('voc-tab-content-active'); }
        var activeItem = document.getElementById('voc-menu-' + tabId);
        if (activeItem) { activeItem.classList.add('voc-menu-active'); }
        // Update the badge in the top-right header
        var badge = document.getElementById('voc-active-badge');
        if (badge) {
            var meta = TAB_META.filter(function (t) { return t.id === tabId; })[0];
            if (meta) { badge.textContent = meta.icon + ' ' + meta.label; }
        }
        // Defer by one frame: lets the browser apply display:block on the newly-active
        // pane so ApexCharts gets a non-zero offsetWidth when it first measures the container.
        window.setTimeout(function () {
            renderActiveTab();
        }, 0);
    }

    function verifyShiftMatch(timeStr, targetShift) {
        if (targetShift === 'ALL') { return true; }
        var hour = parseInt(timeStr.split(' ')[1].split(':')[0], 10);
        if (targetShift === 'MORNING') { return (hour >= 6 && hour < 14); }
        if (targetShift === 'AFTERNOON') { return (hour >= 14 && hour < 22); }
        if (targetShift === 'NIGHT') { return (hour >= 22 || hour < 6); }
        return true;
    }

    // ---------------------------------------------------------------------
    // CORE ANALYTICS + RENDER PASS
    // Mirrors renderActiveTab() from the HTML twin: every control change
    // (timeline, filters, search, sort, tab) re-runs this single pass over
    // app.events, then renders only the DOM for the active tab AND
    // re-publishes the 3D scene markers so the map matches the snapshot.
    // ---------------------------------------------------------------------
    function renderActiveTab() {
        if (!app.times.length) { return; }

        var selectedTimestamp = document.getElementById('voc-ts-select').value || app.times[app.timeIndex];
        var filterValue = document.getElementById('voc-status-filter').value;
        var searchQuery = document.getElementById('voc-search-input').value.toLowerCase().trim();
        var sortValue = document.getElementById('voc-matrix-sort').value;
        var dateScope = document.getElementById('voc-date-filter').value;
        var shiftScope = document.getElementById('voc-shift-filter').value;

        var cutoff = parseEventDate(selectedTimestamp);
        var cutoffTime = cutoff.getTime();

        var idx = app.times.indexOf(selectedTimestamp);
        if (idx !== -1) { app.timeIndex = idx; }

        // ---- Core filter pass ----
        var filtered = app.events.filter(function (r) {
            var d = parseEventDate(r.event_time);
            if (d.getTime() > cutoffTime) { return false; }
            if (dateScope !== 'ALL' && r.event_time.indexOf(dateScope) !== 0) { return false; }
            if (!verifyShiftMatch(r.event_time, shiftScope)) { return false; }
            return true;
        });

        var groups = {}, metadata = {};
        var activeInPort = 0, preArrival = 0, departed = 0;
        var totalImports = 0, totalExports = 0, cumulativeCapacity = 0;
        var sumAnchorageWait = 0, countAnchorage = 0;
        var sumCranes = 0, countCranes = 0, totalCargoHours = 0;
        var countDelayedVoyages = 0, totalVoyages = 0;

        var envWeather = 'CLEAR', envTide = 0.0;

        var shippingLineDelayMap = {}, delayReasonCounts = {}, containerTypeCounts = {};
        var opsScatterPoints = [], timelineTideMap = {}, timelineDelayCountMap = {};

        var strictBerthImports = {};
        var strictBerthExports = {};

        var vesselClassMap = {};
        var vesselStageMap = {};
        STAGES.forEach(function (s) { vesselStageMap[s] = 0; });
        var capacityRangeMap = { 'Under 3k TEU': 0, '3k - 6k TEU': 0, '6k - 10k TEU': 0, 'Above 10k TEU': 0 };

        filtered.forEach(function (r) {
            var key = r.voyage_no + '_' + r.vessel_id;
            if (!groups[key]) {
                groups[key] = [];
                metadata[key] = {
                    vesselId: r.vessel_id, voyageNo: r.voyage_no, shippingLine: r.shipping_line,
                    vesselClass: r.vessel_class, capacity: r.teu_capacity || 0,
                    importTeu: r.import_teu || 0, exportTeu: r.export_teu || 0,
                    anchorageWait: r.anchorage_wait_hours || 0, cargoHours: r.cargo_hours || 0,
                    cranes: r.cranes_assigned || 0, terminal: '-', berth: '-',
                    stageDelays: {}, substagesList: [], hasArrived: false, hasDeparted: false,
                    totalRowHours: 0, latestEventTime: parseEventDate(r.event_time), latestSubstage: '-',
                    latestRow: r
                };
            }

            var meta = metadata[key];
            if (r.terminal) { meta.terminal = r.terminal; }
            if (r.berth) { meta.berth = r.berth; }

            var timeStr = r.event_time;
            var currentEventDate = parseEventDate(timeStr);

            if (currentEventDate.getTime() >= meta.latestEventTime.getTime()) {
                meta.latestEventTime = currentEventDate;
                meta.latestSubstage = r.substage || r.stage;
                meta.latestRow = r;
            }

            if (!timelineTideMap.hasOwnProperty(timeStr)) {
                timelineTideMap[timeStr] = r.tide_level || 0;
                timelineDelayCountMap[timeStr] = 0;
            }

            if (r.delay_reason && String(r.delay_reason).trim() !== '') {
                meta.stageDelays[r.stage] = r.delay_reason;
                delayReasonCounts[r.delay_reason] = (delayReasonCounts[r.delay_reason] || 0) + 1;
                timelineDelayCountMap[timeStr]++;
                shippingLineDelayMap[r.shipping_line] = (shippingLineDelayMap[r.shipping_line] || 0) + 1;
            }

            if (r.container_type) {
                containerTypeCounts[r.container_type] = (containerTypeCounts[r.container_type] || 0) + 1;
            }

            if (currentEventDate.getTime() === cutoffTime) {
                if (r.weather) { envWeather = r.weather; }
                if (r.tide_level) { envTide = r.tide_level; }
            }

            meta.substagesList.push({
                timeStr: r.event_time, stage: r.stage, substage: r.substage,
                cranes: r.cranes_assigned || '-', weather: r.weather || '-', delay: r.delay_reason || '-'
            });

            if (r.stage === 'CARGO' && r.cranes_assigned > 0) {
                sumCranes += r.cranes_assigned;
                countCranes++;
            }

            groups[key].push({ time: currentEventDate, stage: r.stage });
        });

        var matrixDataRows = [];

        Object.keys(groups).forEach(function (key) {
            var meta = metadata[key];
            var events = groups[key].sort(function (a, b) { return a.time - b.time; });
            var latest = events[events.length - 1];

            if (events.some(function (e) { return e.stage !== 'PLANNING'; })) { meta.hasArrived = true; }
            if (latest.stage === 'DEPARTURE') { meta.hasDeparted = true; }

            var rowDurations = {};
            STAGES.forEach(function (s) { rowDurations[s] = 0; });
            for (var i = 0; i < events.length; i++) {
                var nextTime = (i < events.length - 1) ? events[i + 1].time : cutoff;
                rowDurations[events[i].stage] += Math.max(0, (nextTime - events[i].time) / (1000 * 60 * 60));
            }
            STAGES.forEach(function (s) { meta.totalRowHours += rowDurations[s]; });

            if (meta.hasArrived) {
                totalVoyages++;
                totalImports += meta.importTeu;
                totalExports += meta.exportTeu;
                cumulativeCapacity += meta.capacity;

                if (Object.keys(meta.stageDelays).length > 0) { countDelayedVoyages++; }
                if (meta.anchorageWait > 0) { sumAnchorageWait += meta.anchorageWait; countAnchorage++; }

                vesselClassMap[meta.vesselClass] = (vesselClassMap[meta.vesselClass] || 0) + 1;
                vesselStageMap[latest.stage] = (vesselStageMap[latest.stage] || 0) + 1;

                if (meta.capacity < 3000) { capacityRangeMap['Under 3k TEU']++; }
                else if (meta.capacity <= 6000) { capacityRangeMap['3k - 6k TEU']++; }
                else if (meta.capacity <= 10000) { capacityRangeMap['6k - 10k TEU']++; }
                else { capacityRangeMap['Above 10k TEU']++; }

                if (meta.terminal !== '-' && meta.berth !== '-') {
                    var geoKey = meta.terminal + '\u2794' + meta.berth;
                    strictBerthImports[geoKey] = (strictBerthImports[geoKey] || 0) + meta.importTeu;
                    strictBerthExports[geoKey] = (strictBerthExports[geoKey] || 0) + meta.exportTeu;
                }

                if (meta.cargoHours > 0) {
                    totalCargoHours += meta.cargoHours;
                    opsScatterPoints.push({ x: meta.cranes, y: parseFloat(((meta.importTeu + meta.exportTeu) / meta.cargoHours).toFixed(1)) });
                }

                if (meta.hasDeparted) { departed++; } else { activeInPort++; }
            } else {
                preArrival++;
            }

            if (filterValue === 'IN_PORT' && (!meta.hasArrived || meta.hasDeparted)) { return; }
            if (filterValue === 'PRE_ARRIVAL' && meta.hasArrived) { return; }
            if (filterValue === 'DEPARTED' && !meta.hasDeparted) { return; }

            if (searchQuery) {
                var mId = meta.vesselId.toLowerCase().indexOf(searchQuery) !== -1;
                var mLine = meta.shippingLine.toLowerCase().indexOf(searchQuery) !== -1;
                var mSub = meta.substagesList.some(function (s) { return s.substage.toLowerCase().indexOf(searchQuery) !== -1; });
                if (!mId && !mLine && !mSub) { return; }
            }

            matrixDataRows.push({ key: key, meta: meta, rowDurations: rowDurations });
        });

        matrixDataRows.sort(function (a, b) {
            if (sortValue === 'TOTAL_TIME_DESC') { return b.meta.totalRowHours - a.meta.totalRowHours; }
            if (sortValue === 'RECENT_EVENT_DESC') { return b.meta.latestEventTime - a.meta.latestEventTime; }
            if (sortValue === 'VESSEL_ID_ASC') { return a.meta.vesselId.localeCompare(b.meta.vesselId); }
            if (sortValue === 'CARGO_VOLUME_DESC') { return (b.meta.importTeu + b.meta.exportTeu) - (a.meta.importTeu + a.meta.exportTeu); }
            return 0;
        });

        // ---- Per-tab DOM rendering ----
        if (app.currentTab === 'executive') {
            document.getElementById('voc-kpi-exe-tat').textContent = totalVoyages > 0 ? (totalCargoHours / totalVoyages * 1.8).toFixed(1) + 'h' : '0.0h';
            document.getElementById('voc-kpi-exe-cap').textContent = cumulativeCapacity > 0 ? ((totalImports + totalExports) / cumulativeCapacity * 100).toFixed(1) + '%' : '0.0%';
            document.getElementById('voc-kpi-exe-delpct').textContent = totalVoyages > 0 ? (countDelayedVoyages / totalVoyages * 100).toFixed(1) + '%' : '0.0%';

            renderBarChart('voc-exe-demurrage-chart', Object.keys(shippingLineDelayMap), Object.values(shippingLineDelayMap), 'Delay Frequency');
            renderDonutChart('voc-exe-delay-pie', Object.keys(delayReasonCounts), Object.values(delayReasonCounts));

        } else if (app.currentTab === 'vessels') {
            document.getElementById('voc-kpi-vsl-active').textContent = activeInPort;
            document.getElementById('voc-kpi-vsl-plan').textContent = preArrival;
            document.getElementById('voc-kpi-vsl-anch').textContent = countAnchorage > 0 ? (sumAnchorageWait / countAnchorage).toFixed(1) + 'h' : '0.0h';

            var header = document.getElementById('voc-matrix-header');
            header.innerHTML = '<th style="position:sticky;left:0;z-index:5;">Vessel Infrastructure</th>';
            STAGES.forEach(function (s) { header.innerHTML += '<th>' + s + '</th>'; });
            header.innerHTML += '<th>Total</th>';

            var tbody = document.getElementById('voc-matrix-body');
            tbody.innerHTML = '';

            matrixDataRows.forEach(function (row) {
                var key = row.key, meta = row.meta, rowDurations = row.rowDurations;
                var subHtml = '';
                meta.substagesList.forEach(function (s) {
                    subHtml += '<tr><td>' + esc(s.timeStr) + '</td><td>' + esc(s.stage) + '</td><td><code>' + esc(s.substage) + '</code></td>' +
                        '<td>' + esc(s.cranes) + '</td><td>' + esc(s.weather) + '</td><td>' + esc(s.delay) + '</td></tr>';
                });

                var formattedTime = meta.latestEventTime.toISOString().split('T')[1].substring(0, 5);

                var rowHtml = '<tr class="voc-vessel-row" data-key="' + esc(key) + '">' +
                    '<td class="voc-vessel-axis-cell">' +
                        '\u25B6 ' + esc(meta.vesselId) + ' <span style="font-size:10px;font-weight:normal;color:#6b7280;">(' + esc(meta.voyageNo) + ')</span><br>' +
                        '<span class="voc-berth-badge">' + esc(meta.terminal) + '/' + esc(meta.berth) + '</span>' +
                        '<span style="display:block;font-size:9.5px;color:#4b5563;font-weight:normal;margin-top:3px;background:#f1f5f9;padding:1px 4px;border-radius:3px;">' +
                            '\u23F1\uFE0F Upd: ' + esc(meta.latestSubstage) + ' (' + formattedTime + ')' +
                        '</span>' +
                    '</td>';

                STAGES.forEach(function (s) {
                    var d = rowDurations[s];
                    var hClass = d > 0 ? (d <= 4 ? 'voc-cell-low' : d <= 24 ? 'voc-cell-med' : 'voc-cell-critical') : 'voc-cell-empty';
                    rowHtml += '<td class="' + hClass + '"><strong>' + (d > 0 ? d.toFixed(1) + 'h' : '-') + '</strong>' +
                        (meta.stageDelays[s] ? '<span class="voc-delay-warning-tag">\u26A0\uFE0F ' + esc(meta.stageDelays[s]) + '</span>' : '') + '</td>';
                });

                rowHtml += '<td>' + meta.totalRowHours.toFixed(1) + 'h</td></tr>' +
                    '<tr class="voc-drilldown-row" id="voc-sub-' + esc(key) + '"><td colspan="' + (STAGES.length + 2) + '"><div class="voc-drilldown-container">' +
                    '<table class="voc-subtable"><thead><tr><th>Timestamp</th><th>Stage</th><th>Substage</th><th>Cranes</th><th>Weather</th><th>Alert Context</th></tr></thead><tbody>' + subHtml + '</tbody></table>' +
                    '</div></td></tr>';

                tbody.innerHTML += rowHtml;
            });

            renderDonutChart('voc-vsl-mix-donut', Object.keys(vesselClassMap), Object.values(vesselClassMap));
            renderBarChart('voc-vsl-capacity-bar', Object.keys(capacityRangeMap), Object.values(capacityRangeMap), 'Vessels Count');
            renderBarChart('voc-vsl-stage-bar', Object.keys(vesselStageMap), Object.values(vesselStageMap), 'Queue Count');

        } else if (app.currentTab === 'terminals') {
            document.getElementById('voc-kpi-term-imp').textContent = totalImports.toLocaleString() + ' TEU';
            document.getElementById('voc-kpi-term-exp').textContent = totalExports.toLocaleString() + ' TEU';
            document.getElementById('voc-kpi-term-occupancy').textContent = activeInPort > 0 ? Math.min(100, (activeInPort * 12)).toFixed(0) + '%' : '0%';

            var allGeoCategories = uniqueSorted(Object.keys(strictBerthImports).concat(Object.keys(strictBerthExports)));
            var finalImportValues = allGeoCategories.map(function (cat) { return strictBerthImports[cat] || 0; });
            var finalExportValues = allGeoCategories.map(function (cat) { return strictBerthExports[cat] || 0; });

            renderClusteredBarChart('voc-term-geo-bar', allGeoCategories, finalImportValues, finalExportValues);
            renderDonutChart('voc-term-type-pie', Object.keys(containerTypeCounts), Object.values(containerTypeCounts));

        } else if (app.currentTab === 'operations') {
            document.getElementById('voc-kpi-ops-cranes').textContent = countCranes > 0 ? (sumCranes / countCranes).toFixed(1) : '0.0';
            document.getElementById('voc-kpi-ops-speed').textContent = totalCargoHours > 0 ? ((totalImports + totalExports) / totalCargoHours).toFixed(1) + ' TEU/h' : '0.0 TEU/h';

            renderScatterChart('voc-ops-efficiency-scatter', opsScatterPoints);

        } else if (app.currentTab === 'environment') {
            document.getElementById('voc-kpi-env-weather').textContent = envWeather;
            document.getElementById('voc-kpi-env-tide').textContent = envTide.toFixed(2) + 'm';

            var timesSorted = Object.keys(timelineTideMap).sort().slice(-15);
            var tides = timesSorted.map(function (t) { return parseFloat(timelineTideMap[t].toFixed(2)); });
            var delays = timesSorted.map(function (t) { return timelineDelayCountMap[t]; });

            renderDualAxisLineChart('voc-env-tide-line', timesSorted, tides, delays);
        }

        // ---- Keep the 3D scene in sync with whatever instant the console shows ----
        syncSceneMarkers(metadata, envTide);

        setStatus('Snapshot: ' + selectedTimestamp + ' | Step ' + (app.timeIndex + 1) + ' of ' + app.times.length +
            ' | Tide: ' + envTide.toFixed(2) + 'm | Weather: ' + envWeather +
            ' | In Port: ' + activeInPort + ' | Pre-Arrival: ' + preArrival + ' | Departed: ' + departed);

        document.getElementById('voc-ts-select').value = selectedTimestamp;
        app.isFirstLoad = false;
    }

    // ---------------------------------------------------------------------
    // TIMELINE PLAYBACK
    // ---------------------------------------------------------------------
    function stepToIndex(i) {
        app.timeIndex = i;
        document.getElementById('voc-ts-select').selectedIndex = i;
        renderActiveTab();
    }

    function stepPlayback(direction) {
        var next = app.timeIndex + direction;
        if (next < 0 || next >= app.times.length) { return; }
        stepToIndex(next);
    }

    function togglePlayback() {
        var btn = document.getElementById('voc-play-btn');
        if (app.playbackHandle) {
            window.clearInterval(app.playbackHandle);
            app.playbackHandle = null;
            app.playing = false;
            btn.textContent = '\u25B6 Play';
            btn.classList.remove('voc-active');
            return;
        }
        app.playing = true;
        btn.textContent = '\u23F8 Pause';
        btn.classList.add('voc-active');
        var intervalMs = +document.getElementById('voc-speed').value || CONFIG.DEFAULT_INTERVAL_MS;
        app.playbackHandle = window.setInterval(function () {
            var next = app.timeIndex + 1;
            if (next >= app.times.length) {
                window.clearInterval(app.playbackHandle);
                app.playbackHandle = null;
                app.playing = false;
                btn.textContent = '\u25B6 Play';
                btn.classList.remove('voc-active');
                return;
            }
            stepToIndex(next);
        }, intervalMs);
    }

    // ---------------------------------------------------------------------
    // LOAD
    // ---------------------------------------------------------------------
    function onLoad() {
        initUi();
        initBerthMarkers();
        publishTideMarker('-');
        setStatus('Loading ApexCharts and vessel lifecycle data...');

        ensureApexCharts()
            .then(function () { return apiGetText(CONFIG.CSV_URL); })
            .then(parseCsv)
            .then(function (rows) {
                app.events = rows.filter(function (x) { return x.event_time; });
                app.times = uniqueSorted(app.events.map(function (x) { return x.event_time; }));

                populateTimelineSelect();

                if (app.times.length) {
                    app.timeIndex = 0;
                    document.getElementById('voc-ts-select').selectedIndex = 0;
                    // Defer one frame so the widget body is fully painted before
                    // ApexCharts measures container dimensions for the first render.
                    window.setTimeout(function () {
                        renderActiveTab();
                    }, 0);
                } else {
                    setStatus('No events found in CSV', true);
                }
            })
            .catch(function (err) {
                setStatus('Failed to load vessel lifecycle CSV or chart library: ' +
                    (err && err.message ? err.message : err), true);
            });
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});
