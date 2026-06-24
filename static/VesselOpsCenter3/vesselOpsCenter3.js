/*global window, document, widget, define */

/*
 * VesselOpsCenter
 * ---------------------------------------------------------------------
 * This widget merges two source artifacts into a single DS/UWA widget
 * module:
 *
 * 1. vessel_heatmap8.html  - "Enterprise Port Command Center", a
 * multi-tab analytics console (Executive / Vessel Tracking Matrix /
 * Terminal & Berth / Operations & Cranes / Environmental Context)
 * built with ApexCharts, a snapshot timeline, and filter controls.
 *
 * 2. vesselMovement2.js    - the 3D-scene twin that publishes vessel,
 * berth and tide-gauge markers onto the platform via PlatformAPI as
 * the timeline plays back.
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
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselOpsCenter/vessel_lifecycle_simulation.csv',
        APEXCHARTS_URL: 'https://cdn.jsdelivr.net/npm/apexcharts',
        DEFAULT_INTERVAL_MS: 350,
        FAST_INTERVAL_MS: 100,
        VESSEL_MARKER_PREFIX: 'VESSEL_',
        BERTH_MARKER_PREFIX: 'BERTH_',
        VESSEL_MARKER_ELEVATION: 80,
        VESSEL_MARKER_SCALE: 1.4,
        BERTH_MARKER_ELEVATION: 0,
        TIDE_MARKER_ID: 'TIDE_GAUGE',
        TIDE_LOCATION: [18.94543, 72.92450],
        ANCHORAGE_SLOTS: 12,
        ANCHORAGE_RADIUS_DEG: 0.0018,
        VESSEL_SYMBOL: '\uD83D\uDEA2'
    };

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
        vesselMarkerIds: {},
        berthMarkerIds: {},
        berthOccupied: {},
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
    // STATIC BERTH MARKERS
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
    // TIDE GAUGE MARKER
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
        removeContent(app.vesselMarkerIds[id]);
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
                style: 'text',
                text: CONFIG.VESSEL_SYMBOL,
                color: '#0B5CAB',
                scale: CONFIG.VESSEL_MARKER_SCALE
            },
            options: { projection: { from: 'WGS84' } }
        });
    }

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
    var STYLE = '<style>' +
        '.voc-wrap,.voc-wrap *{box-sizing:border-box;}' +
        '.voc-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'background:#f3f4f6;color:#1f2937;line-height:1.4;' +
        'width:100%;height:100%;min-height:320px;' +
        'overflow:auto;}' +
        '.voc-inner{padding:14px;min-width:420px;}' +
        '.voc-topbar{display:flex;align-items:center;gap:8px;margin-bottom:8px;position:relative;}' +
        '.voc-topbar-left{flex:1;min-width:0;}' +
        '.voc-title{font-size:1.2rem;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
        '.voc-subtitle{font-size:11px;color:#6b7280;}' +
        '.voc-topbar-right{display:flex;gap:6px;align-items:center;flex-shrink:0;}' +
        '.voc-active-badge{font-size:11.5px;font-weight:600;color:#3b82f6;background:#eff6ff;' +
        'border:1px solid #bfdbfe;padding:3px 9px;border-radius:20px;white-space:nowrap;cursor:default;}' +
        '.voc-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid #d1d5db;background:#fff;' +
        'cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;' +
        'transition:background .15s,border-color .15s;}' +
        '.voc-icon-btn:hover{background:#f0f9ff;border-color:#93c5fd;}' +
        '.voc-icon-btn.voc-active{background:#eff6ff;border-color:#3b82f6;}' +
        '.voc-status-bar{font-size:11px;color:#374151;background:#fff;padding:6px 10px;border-radius:6px;' +
        'margin-bottom:11px;box-shadow:0 1px 3px rgba(0,0,0,.05);word-break:break-all;}' +
        '.voc-burger-menu{position:absolute;top:42px;right:0;z-index:200;' +
        'background:#fff;border:1px solid #e5e7eb;border-radius:10px;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:230px;padding:6px 0;display:none;}' +
        '.voc-burger-menu.voc-open{display:block;}' +
        '.voc-menu-section{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;' +
        'padding:6px 14px 2px 14px;letter-spacing:0.5px;}' +
        '.voc-menu-item{display:flex;align-items:center;padding:8px 14px;font-size:13px;' +
        'color:#374151;cursor:pointer;transition:background .15s;text-align:left;width:100%;border:none;background:none;}' +
        '.voc-menu-item:hover{background:#f3f4f6;color:#111827;}' +
        '.voc-menu-item.voc-selected{font-weight:600;color:#2563eb;background:#f0f9ff;}' +
        '.voc-main-layout{display:flex;flex-direction:column;gap:12px;}' +
        '.voc-control-card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);' +
        'display:flex;flex-wrap:wrap;align-items:center;gap:12px;}' +
        '.voc-select-group{display:flex;flex-direction:column;gap:3px;flex:1;min-width:160px;}' +
        '.voc-select-group label{font-size:11px;font-weight:600;color:#4b5563;}' +
        '.voc-select{padding:6px 10px;font-size:13px;border-radius:6px;border:1px solid #d1d5db;' +
        'background:#fff;outline:none;width:100%;height:32px;}' +
        '.voc-select:focus{border-color:#3b82f6;}' +
        '.voc-playback-rig{display:flex;gap:6px;align-items:flex-end;height:32px;margin-top:auto;}' +
        '.voc-btn{height:32px;padding:0 12px;font-size:12.5px;font-weight:600;border-radius:6px;' +
        'border:1px solid #d1d5db;background:#fff;cursor:pointer;display:flex;align-items:center;' +
        'justify-content:center;gap:4px;transition:all .15s;white-space:nowrap;}' +
        '.voc-btn:hover{background:#f9fafb;border-color:#9ca3af;}' +
        '.voc-btn-primary{background:#3b82f6;color:#fff;border-color:#2563eb;}' +
        '.voc-btn-primary:hover{background:#2563eb;border-color:#1d4ed8;}' +
        '.voc-btn-danger{background:#fee2e2;color:#ef4444;border-color:#fca5a5;}' +
        '.voc-btn-danger:hover{background:#fca5a5;}' +
        '.voc-kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;}' +
        '.voc-kpi-card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);' +
        'display:flex;flex-direction:column;position:relative;}' +
        '.voc-kpi-card label{font-size:10.5px;font-weight:600;color:#4b5563;margin-bottom:2px;}' +
        '.voc-kpi-val{font-size:18px;font-weight:700;color:#111827;margin-bottom:4px;}' +
        '.voc-kpi-exp{font-size:10px;color:#6b7280;border-top:1px dashed #e5e7eb;padding-top:4px;font-style:italic;line-height:1.2;}' +
        '.voc-pane{display:none;}' +
        '.voc-pane.voc-active{display:block;}' +
        '.voc-charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;}' +
        '.voc-chart-card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);' +
        'width:100%;overflow:hidden;display:flex;flex-direction:column;min-height:240px;}' +
        '.voc-chart-title{font-weight:600;font-size:13px;color:#374151;margin-bottom:2px;' +
        'border-bottom:1px solid #e5e7eb;padding-bottom:4px;}' +
        '.voc-chart-exp{font-size:10.5px;color:#6b7280;font-style:italic;margin-bottom:10px;margin-top:2px;line-height:1.2;}' +
        '.voc-card-body{width:100%;flex:1;min-height:180px;}' +
        '.voc-matrix-container{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.05);' +
        'overflow-x:auto;margin-bottom:4px;}' +
        '.voc-table{width:100%;border-collapse:collapse;min-width:700px;text-align:center;}' +
        '.voc-table th,.voc-table td{padding:8px 5px;border:1px solid #e5e7eb;font-size:11.5px;}' +
        '.voc-table th{background:#f9fafb;font-weight:600;color:#374151;}' +
        '.voc-vessel-row{cursor:pointer;}' +
        '.voc-vessel-row:hover td{background:#f8fafc;}' +
        '.voc-vessel-axis-cell{text-align:left;font-weight:bold;background:#f9fafb;min-width:140px;' +
        'color:#111827;position:sticky;left:0;box-shadow:2px 0 5px -2px rgba(0,0,0,0.1);z-index:2;}' +
        '.voc-drilldown-row{background:#f8fafc;display:none;}' +
        '.voc-drilldown-row.voc-open{display:table-row;}' +
        '.voc-drilldown-container{padding:10px;text-align:left;background:#fff;border:1px solid #e2e8f0;' +
        'border-radius:6px;margin:4px auto;width:98%;overflow-x:auto;}' +
        '.voc-subtable{width:100%;border-collapse:collapse;min-width:600px;}' +
        '.voc-subtable th{background:#f1f5f9;color:#475569;font-size:10.5px;padding:5px;}' +
        '.voc-subtable td{padding:5px;font-size:10.5px;border:1px solid #e2e8f0;background:#fff!important;}' +
        '.voc-berth-badge{display:inline-block;padding:2px 4px;font-size:9.5px;border-radius:4px;' +
        'font-weight:600;margin-top:2px;background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;}' +
        '.voc-status-badge{display:inline-block;padding:2px 4px;font-size:9.5px;border-radius:4px;font-weight:600;margin-top:2px;margin-right:4px;}' +
        '.voc-status-in-port{background:#dbeafe;color:#1e40af;}' +
        '.voc-status-departed{background:#f3f4f6;color:#4b5563;}' +
        '.voc-status-planning{background:#fef3c7;color:#92400e;}' +
        '.voc-delay-tag{display:block;font-size:8.5px;color:#b91c1c;font-weight:bold;margin-top:2px;' +
        'text-transform:uppercase;background:rgba(254,226,226,0.6);padding:1px 2px;border-radius:3px;}' +
        '.voc-c-empty{background:#fcfcfd;color:#d1d5db;}' +
        '.voc-c-low{background:#dcfce7;color:#166534;}' +
        '.voc-c-med{background:#eff6ff;color:#1e40af;}' +
        '.voc-c-critical{background:#fee2e2;color:#991b1b;}' +
        '.voc-vessel-panel-grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;}' +
        '</style>';

    // ---------------------------------------------------------------------
    // CALCULATORS & PROCESSING (Ported directly from HTML source)
    // ---------------------------------------------------------------------
    function getSnapshotData() {
        var currentSnapshotTime = app.times[app.timeIndex];
        var lookupTime = parseEventDate(currentSnapshotTime);

        var snapshotEvents = app.events.filter(function (x) {
            return parseEventDate(x.event_time) <= lookupTime;
        });

        var latestPerVessel = {};
        snapshotEvents.forEach(function (ev) {
            latestPerVessel[ev.vessel_id] = ev;
        });

        var metadata = {};
        app.events.forEach(function (ev) {
            if (!metadata[ev.vessel_id]) {
                metadata[ev.vessel_id] = {
                    vessel_id: ev.vessel_id, voyage_no: ev.voyage_no, shipping_line: ev.shipping_line,
                    container_type: ev.container_type, teu_capacity: ev.teu_capacity, terminal: ev.terminal,
                    import_teu: ev.import_teu, export_teu: ev.export_teu, cargo_hours: ev.cargo_hours,
                    hasArrived: false, hasDeparted: false, currentStage: 'PLANNING', currentSubstage: '-',
                    berth: '-', cranes: 0, waitHours: 0, lifecycle: [], latestRow: null
                };
            }
        });

        snapshotEvents.forEach(function (ev) {
            var meta = metadata[ev.vessel_id];
            meta.latestRow = ev;
            meta.lifecycle.push(ev);
            if (ev.stage === 'ARRIVAL') { meta.hasArrived = true; }
            if (ev.stage === 'DEPARTURE') { meta.hasDeparted = true; }
            meta.currentStage = ev.stage;
            meta.currentSubstage = ev.substage || '-';
            meta.berth = ev.berth || '-';
            meta.cranes = ev.cranes_assigned || 0;
            meta.waitHours = ev.anchorage_wait_hours || 0;
        });

        var activeTide = 0;
        var matchingTideEvent = snapshotEvents.slice().reverse().find(function (x) { return x.tide_level > 0; });
        if (matchingTideEvent) { activeTide = matchingTideEvent.tide_level; }

        return { metadata: metadata, envTide: activeTide, snapshotTime: currentSnapshotTime };
    }

    function calculateMetrics(metadata) {
        var activeInPort = 0, totalTeuHandled = 0, totalCranesAllocated = 0, totalWaitHours = 0;
        var delayedVesselsCount = 0, berthsOccupiedCount = 0;
        var stageCounts = {}, lineTeu = {}, stageWaitTimes = {};

        STAGES.forEach(function (s) { stageCounts[s] = 0; stageWaitTimes[s] = { total: 0, count: 0 }; });

        Object.keys(metadata).forEach(function (vId) {
            var m = metadata[vId];
            stageCounts[m.currentStage] = (stageCounts[m.currentStage] || 0) + 1;

            if (m.hasArrived && !m.hasDeparted) {
                activeInPort++;
                totalCranesAllocated += m.cranes;
                totalWaitHours += m.waitHours;
                if (m.waitHours > 12) { delayedVesselsCount++; }
                if (m.berth !== '-') { berthsOccupiedCount++; }
            }

            m.lifecycle.forEach(function (row) {
                if (row.stage === 'CARGO' || row.substage === 'ALL_FAST') {
                    totalTeuHandled += (row.import_teu + row.export_teu);
                    lineTeu[m.shipping_line] = (lineTeu[m.shipping_line] || 0) + (row.import_teu + row.export_teu);
                }
                if (row.anchorage_wait_hours > 0 && stageWaitTimes[row.stage]) {
                    stageWaitTimes[row.stage].total += row.anchorage_wait_hours;
                    stageWaitTimes[row.stage].count++;
                }
            });
        });

        return {
            activeInPort: activeInPort, totalTeuHandled: totalTeuHandled, totalCranesAllocated: totalCranesAllocated,
            totalWaitHours: totalWaitHours, delayedVesselsCount: delayedVesselsCount, berthsOccupiedCount: berthsOccupiedCount,
            stageCounts: stageCounts, lineTeu: lineTeu, stageWaitTimes: stageWaitTimes
        };
    }

    // ---------------------------------------------------------------------
    // APEXCHARTS RENDER RIG
    // ---------------------------------------------------------------------
    function safeRender(id, options) {
        var el = document.getElementById(id);
        if (!el) { return; }
        if (app.chartsMap[id]) {
            app.chartsMap[id].updateOptions(options);
        } else {
            el.innerHTML = '';
            var c = new window.ApexCharts(el, options);
            c.render();
            app.chartsMap[id] = c;
        }
    }

    function destroyAllCharts() {
        Object.keys(app.chartsMap).forEach(function (k) {
            try { app.chartsMap[k].destroy(); } catch(e){}
        });
        app.chartsMap = {};
    }

    function renderExecutiveTabCharts(metrics) {
        var stageLabels = STAGES;
        var stageValues = stageLabels.map(function (s) { return metrics.stageCounts[s] || 0; });
        safeRender('voc-chart-exec-lifecycle', {
            series: [{ name: 'Vessels', data: stageValues }],
            chart: { type: 'bar', height: 200, toolbar: { show: false } },
            colors: ['#3b82f6'],
            plotOptions: { bar: { borderRadius: 4, horizontal: false } },
            xaxis: { categories: stageLabels, labels: { style: { fontSize: '9px' } } },
            dataLabels: { enabled: true, style: { fontSize: '10px' } }
        });

        var lineLabels = Object.keys(metrics.lineTeu);
        var lineValues = lineLabels.map(function (k) { return metrics.lineTeu[k]; });
        safeRender('voc-chart-exec-share', {
            series: lineValues, labels: lineLabels,
            chart: { type: 'pie', height: 200 },
            legend: { position: 'bottom', fontSize: '10px' }
        });
    }

    function renderTerminalsTabCharts(metadata) {
        var berthUtilization = {};
        Object.keys(BERTHS).forEach(function (b) { berthUtilization[b] = 0; });
        Object.keys(metadata).forEach(function (k) {
            var m = metadata[k];
            if (m.berth !== '-' && m.hasArrived && !m.hasDeparted) {
                berthUtilization[m.berth] = 100;
            }
        });

        var categories = Object.keys(berthUtilization);
        var dataValues = categories.map(function (c) { return berthUtilization[c]; });

        safeRender('voc-chart-term-util', {
            series: [{ name: 'Utilization %', data: dataValues }],
            chart: { type: 'bar', height: 200, toolbar: { show: false } },
            colors: ['#10b981'],
            xaxis: { categories: categories },
            yaxis: { max: 100 },
            dataLabels: { enabled: true, formatter: function (v) { return v + '%'; } }
        });
    }

    function renderOperationsTabCharts(metrics, metadata) {
        var points = [];
        Object.keys(metadata).forEach(function (k) {
            var m = metadata[k];
            if (m.hasArrived && !m.hasDeparted && m.cranes > 0) {
                var velocity = m.cargo_hours > 0 ? ((m.import_teu + m.export_teu) / m.cargo_hours) : 0;
                points.push({ x: m.cranes, y: Math.round(velocity) });
            }
        });

        safeRender('voc-chart-ops-scatter', {
            series: [{ name: 'Vessel Performance', data: points }],
            chart: { type: 'scatter', height: 200, toolbar: { show: false } },
            xaxis: { title: { text: 'Cranes Allocated', style: { fontSize: '10px' } }, tickAmount: 4 },
            yaxis: { title: { text: 'Velocity (TEU/hr)', style: { fontSize: '10px' } } }
        });
    }

    function renderEnvironmentTabCharts(envTide, metrics) {
        var categories = STAGES;
        var barData = categories.map(function (s) { return metrics.stageWaitTimes[s].total; });
        var lineData = categories.map(function () { return envTide; });

        safeRender('voc-chart-env-dual', {
            series: [{ name: 'Tide Level (m)', type: 'line', data: lineData }, { name: 'Active Delays', type: 'column', data: barData }],
            chart: { height: 200, type: 'line', toolbar: { show: false } },
            stroke: { width: [2, 0] },
            colors: ['#ef4444', '#3b82f6'],
            xaxis: { categories: categories },
            yaxis: [{ title: { text: 'Tide Level (m)' } }, { opposite: true, title: { text: 'Cumulative Delays (hrs)' } }]
        });
    }

    // ---------------------------------------------------------------------
    // MATRIX MATRIX GRID RENDERER (Ported directly from Tab 2 matrix grid)
    // ---------------------------------------------------------------------
    function renderVesselMatrix(metadata) {
        var container = document.getElementById('voc-matrix-space');
        if (!container) { return; }

        var html = '<div class="voc-matrix-container">' +
            '<table class="voc-table">' +
            '<thead>' +
            '<tr>' +
            '<th style="text-align:left; position:sticky; left:0; z-index:3; background:#f9fafb;">Vessel Core Identifier</th>';
        
        STAGES.forEach(function (s) {
            html += '<th>' + esc(s) + '</th>';
        });
        html += '</tr></thead><tbody>';

        Object.keys(metadata).forEach(function (vId) {
            var m = metadata[vId];
            html += '<tr class="voc-vessel-row" data-vessel="' + esc(vId) + '">' +
                '<td class="voc-vessel-axis-cell">' +
                '<div>' + esc(vId) + '</div>' +
                '<div style="font-size:9.5px; color:#6b7280; font-weight:normal;">Voy: ' + esc(m.voyage_no) + ' | ' + esc(m.shipping_line) + '</div>' +
                (m.berth !== '-' && m.hasArrived && !m.hasDeparted ? '<span class="voc-berth-badge">Berth: ' + esc(m.berth) + '</span>' : '') +
                '</td>';

            STAGES.forEach(function (s) {
                var isCurrent = (m.currentStage === s);
                var cellClass = 'voc-c-empty';
                var cellContent = '-';

                if (isCurrent) {
                    if (m.hasDeparted) {
                        cellClass = 'voc-c-low';
                        cellContent = '<span class="voc-status-badge voc-status-departed">DEPARTED</span>';
                    } else if (m.currentStage === 'PLANNING') {
                        cellClass = 'voc-c-med';
                        cellContent = '<span class="voc-status-badge voc-status-planning">PLANNING</span>';
                    } else {
                        cellClass = (m.waitHours > 12) ? 'voc-c-critical' : 'voc-c-med';
                        cellContent = '<span class="voc-status-badge voc-status-in-port">' + esc(m.currentSubstage) + '</span>';
                        if (m.waitHours > 0) {
                            cellContent += '<div style="font-size:9.5px; margin-top:2px;">Wait: ' + m.waitHours + 'h</div>';
                        }
                        if (m.waitHours > 12) {
                            cellContent += '<span class="voc-delay-tag">CRITICAL DELAY</span>';
                        }
                    }
                } else {
                    var passed = m.lifecycle.some(function (x) { return x.stage === s; });
                    if (passed) {
                        cellClass = 'voc-c-low';
                        cellContent = '\u2713';
                    }
                }

                html += '<td class="' + cellClass + '">' + cellContent + '</td>';
            });

            html += '</tr>';

            // Hidden drilldown subtable accordion row
            html += '<tr id="voc-drilldown-' + esc(vId) + '" class="voc-drilldown-row">' +
                '<td colspan="' + (STAGES.length + 1) + '">' +
                '<div class="voc-drilldown-container">' +
                '<h4 style="margin-bottom:6px; font-size:12px; color:#1e3a8a;">Detailed Execution Log Trail: ' + esc(vId) + '</h4>' +
                '<table class="voc-subtable">' +
                '<thead><tr><th>Timestamp</th><th>Stage</th><th>Substage</th><th>Berth</th><th>Cranes</th><th>Wait Time</th><th>Cargo Hrs</th><th>TEU (Imp/Exp)</th></tr></thead>' +
                '<tbody>';

            if (m.lifecycle.length === 0) {
                html += '<tr><td colspan="8" style="text-align:center; color:#9ca3af;">No state transits compiled in this token slice.</td></tr>';
            } else {
                m.lifecycle.forEach(function (row) {
                    html += '<tr>' +
                        '<td>' + esc(row.event_time) + '</td>' +
                        '<td>' + esc(row.stage) + '</td>' +
                        '<td>' + esc(row.substage || '-') + '</td>' +
                        '<td>' + esc(row.berth || '-') + '</td>' +
                        '<td>' + safe(row.cranes_assigned) + '</td>' +
                        '<td>' + safe(row.anchorage_wait_hours) + 'h</td>' +
                        '<td>' + safe(row.cargo_hours) + 'h</td>' +
                        '<td>' + safe(row.import_teu) + ' / ' + safe(row.export_teu) + '</td>' +
                        '</tr>';
                });
            }

            html += '</tbody></table></div></td></tr>';
        });

        html += '</tbody></table></div>';
        container.innerHTML = html;

        // Bind drilldown toggle event listeners
        var rows = container.getElementsByClassName('voc-vessel-row');
        Array.prototype.forEach.call(rows, function (r) {
            r.addEventListener('click', function () {
                var vId = this.getAttribute('data-vessel');
                var drill = document.getElementById('voc-drilldown-' + vId);
                if (drill) {
                    if (drill.classList.contains('voc-open')) {
                        drill.classList.remove('voc-open');
                    } else {
                        drill.classList.add('voc-open');
                    }
                }
            });
        });
    }

    // ---------------------------------------------------------------------
    // MAIN TAB RENDERING ROUTER
    // ---------------------------------------------------------------------
    function renderActiveTab() {
        if (!app.times.length) { return; }
        
        var snap = getSnapshotData();
        var metrics = calculateMetrics(snap.metadata);

        // Update Global KPIs (always visible at top of tabs)
        document.getElementById('voc-kpi-active').textContent = metrics.activeInPort;
        document.getElementById('voc-kpi-teu').textContent = metrics.totalTeuHandled.toLocaleString();
        document.getElementById('voc-kpi-cranes').textContent = metrics.totalCranesAllocated;
        document.getElementById('voc-kpi-tide').textContent = snap.envTide ? snap.envTide.toFixed(2) + ' m' : '-';

        // Synchronize 3D Markers via PlatformAPI
        syncSceneMarkers(snap.metadata, snap.envTide);

        // Hide all frames, then unhide current active layout frame
        TABS.forEach(function (t) {
            var pane = document.getElementById('voc-pane-' + t);
            if (pane) { pane.classList.remove('voc-active'); }
        });
        var activePane = document.getElementById('voc-pane-' + app.currentTab);
        if (activePane) { activePane.classList.add('voc-active'); }

        // Render tab-specific visualizations
        if (app.currentTab === 'executive') {
            renderExecutiveTabCharts(metrics);
        } else if (app.currentTab === 'vessels') {
            renderVesselMatrix(snap.metadata);
        } else if (app.currentTab === 'terminals') {
            renderTerminalsTabCharts(snap.metadata);
        } else if (app.currentTab === 'operations') {
            renderOperationsTabCharts(metrics, snap.metadata);
        } else if (app.currentTab === 'environment') {
            renderEnvironmentTabCharts(snap.metadata, metrics);
        }

        setStatus('Snapshot synchrony complete at timeline sequence index frame: ' + snap.snapshotTime);
    }

    // ---------------------------------------------------------------------
    // UI BUILD & WINDOW INTERFACES
    // ---------------------------------------------------------------------
    function initUi() {
        var styleEl = document.createElement('div');
        styleEl.innerHTML = STYLE;
        document.head.appendChild(styleEl.firstChild);

        var html = 
        '<div class="voc-wrap">' +
            '<div class="voc-inner">' +
                // Top Header Bar
                '<div class="voc-topbar">' +
                    '<div class="voc-topbar-left">' +
                        '<div class="voc-title">Enterprise Port Command Center</div>' +
                        '<div class="voc-subtitle">Dynamic Role-Based Operational Intelligence Console Matrix</div>' +
                    '</div>' +
                    '<div class="voc-topbar-right">' +
                        '<div id="voc-active-tab-badge" class="voc-active-badge">Executive View</div>' +
                        '<button id="voc-burger-btn" class="voc-icon-btn" title="Switch Views Menu">\u2630</button>' +
                        // Burger drop menu structure
                        '<div id="voc-burger-menu" class="voc-burger-menu">' +
                            '<div class="voc-menu-section">Operational Perspectives</div>' +
                            '<button class="voc-menu-item voc-selected" data-tab="executive">Executive Dashboard</button>' +
                            '<button class="voc-menu-item" data-tab="vessels">Vessel Tracking Matrix</button>' +
                            '<button class="voc-menu-item" data-tab="terminals">Terminal & Berth View</button>' +
                            '<button class="voc-menu-item" data-tab="operations">Operations & Cranes</button>' +
                            '<button class="voc-menu-item" data-tab="environment">Environmental Context</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                // Status Notification Strip
                '<div id="voc-status" class="voc-status-bar">Initializing control deck...</div>' +

                '<div class="voc-main-layout">' +
                    // Control Panel Card
                    '<div class="voc-control-card">' +
                        '<div class="voc-select-group">' +
                            '<label>Snapshot Timeline (Time Slider)</label>' +
                            '<select id="voc-ts-select" class="voc-select"><option>Loading time keys...</option></select>' +
                        '</div>' +
                        '<div class="voc-playback-rig">' +
                            '<button id="voc-btn-play" class="voc-btn voc-btn-primary" title="Automate Playback">\u25B6 Play</button>' +
                            '<button id="voc-btn-next" class="voc-btn" title="Step Next Snapshot">\u23ED Next</button>' +
                            '<button id="voc-btn-speed" class="voc-btn" title="Toggle Speed Metric">Speed: Normal</button>' +
                        '</div>' +
                    '</div>' +

                    // Global Context KPI Metric Row Grid
                    '<div class="voc-kpi-row">' +
                        '<div class="voc-kpi-card">' +
                            '<label>Active Vessels In-Port</label>' +
                            '<div id="voc-kpi-active" class="voc-kpi-val">-</div>' +
                            '<div class="voc-kpi-exp">Anchored or berthed tracking</div>' +
                        '</div>' +
                        '<div class="voc-kpi-card">' +
                            '<label>Cumulative TEU Handled</label>' +
                            '<div id="voc-kpi-teu" class="voc-kpi-val">-</div>' +
                            '<div class="voc-kpi-exp">Aggregated throughput scale</div>' +
                        '</div>' +
                        '<div class="voc-kpi-card">' +
                            '<label>Active Crane Allocation</label>' +
                            '<div id="voc-kpi-cranes" class="voc-kpi-val">-</div>' +
                            '<div class="voc-kpi-exp">Total machinery load lines</div>' +
                        '</div>' +
                        '<div class="voc-kpi-card">' +
                            '<label>Hydrographic Tide Gauge</label>' +
                            '<div id="voc-kpi-tide" class="voc-kpi-val">-</div>' +
                            '<div class="voc-kpi-exp">Live coastal baseline meter</div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 1 Frame View Content
                    '<div id="voc-pane-executive" class="voc-pane voc-active">' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card">' +
                                '<div class="voc-chart-title">Vessel Lifecycle Stage Distribution Matrix</div>' +
                                '<div class="voc-chart-exp">Real-time load allocation across operational stages</div>' +
                                '<div id="voc-chart-exec-lifecycle" class="voc-card-body"></div>' +
                            '</div>' +
                            '<div class="voc-chart-card">' +
                                '<div class="voc-chart-title">Shipping Line Volume Share Throughput</div>' +
                                '<div class="voc-chart-exp">Total TEU split by carrier line</div>' +
                                '<div id="voc-chart-exec-share" class="voc-card-body"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 2 Frame View Content
                    '<div id="voc-pane-vessels" class="voc-pane">' +
                        '<div id="voc-matrix-space"></div>' +
                    '</div>' +

                    // Tab 3 Frame View Content
                    '<div id="voc-pane-terminals" class="voc-pane">' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card">' +
                                '<div class="voc-chart-title">Berth Occupies & Quay Allocation Percentage</div>' +
                                '<div class="voc-chart-exp">Live active footprints across individual berth slots</div>' +
                                '<div id="voc-chart-term-util" class="voc-card-body"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 4 Frame View Content
                    '<div id="voc-pane-operations" class="voc-pane">' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card">' +
                                '<div class="voc-chart-title">Crane Allocation vs Cargo Handling Velocity Correlation</div>' +
                                '<div class="voc-chart-exp">Scatter distribution of gang allocations relative to TEU velocity performance</div>' +
                                '<div id="voc-chart-ops-scatter" class="voc-card-body"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 5 Frame View Content
                    '<div id="voc-pane-environment" class="voc-pane">' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card">' +
                                '<div class="voc-chart-title">Hydrographic Tide Footprint vs Cumulative Stage Delay Indices</div>' +
                                '<div class="voc-chart-exp">Dual-axis correlation of tide thresholds mapped against anchorage queue hours</div>' +
                                '<div id="voc-chart-env-dual" class="voc-card-body"></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                '</div>' +
            '</div>' +
        '</div>';

        widget.body.innerHTML = html;
        app.statusBar = document.getElementById('voc-status');

        // Toggle Burger drop system panel
        var burgerBtn = document.getElementById('voc-burger-btn');
        var burgerMenu = document.getElementById('voc-burger-menu');
        burgerBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            burgerMenu.classList.toggle('voc-open');
        });

        document.addEventListener('click', function () {
            burgerMenu.classList.remove('voc-open');
        });

        // Tab selection change routing event listeners
        var menuItems = burgerMenu.getElementsByClassName('voc-menu-item');
        var badge = document.getElementById('voc-active-tab-badge');
        Array.prototype.forEach.call(menuItems, function (item) {
            item.addEventListener('click', function () {
                Array.prototype.forEach.call(menuItems, function (x) { x.classList.remove('voc-selected'); });
                this.classList.add('voc-selected');
                
                app.currentTab = this.getAttribute('data-tab');
                badge.textContent = this.textContent;
                
                destroyAllCharts();
                renderActiveTab();
            });
        });

        // Timeline drop selection index adjustment hook
        var select = document.getElementById('voc-ts-select');
        select.addEventListener('change', function () {
            app.timeIndex = parseInt(this.value, 10) || 0;
            renderActiveTab();
        });

        // Playback automate triggers
        var playBtn = document.getElementById('voc-btn-play');
        playBtn.addEventListener('click', function () {
            if (app.playing) {
                stopPlayback();
            } else {
                startPlayback();
            }
        });

        var nextBtn = document.getElementById('voc-btn-next');
        nextBtn.addEventListener('click', function () {
            stopPlayback();
            stepNext();
        });

        var speedBtn = document.getElementById('voc-btn-speed');
        var intervalMs = CONFIG.DEFAULT_INTERVAL_MS;
        speedBtn.addEventListener('click', function () {
            if (intervalMs === CONFIG.DEFAULT_INTERVAL_MS) {
                intervalMs = CONFIG.FAST_INTERVAL_MS;
                this.textContent = 'Speed: Fast';
            } else {
                intervalMs = CONFIG.DEFAULT_INTERVAL_MS;
                this.textContent = 'Speed: Normal';
            }
            if (app.playing) {
                stopPlayback();
                startPlayback();
            }
        });
    }

    function populateTimelineSelect() {
        var select = document.getElementById('voc-ts-select');
        if (!select) { return; }
        var h = '';
        app.times.forEach(function (t, idx) {
            h += '<option value="' + idx + '">' + esc(t) + '</option>';
        });
        select.innerHTML = h;
    }

    function stepNext() {
        if (!app.times.length) { return; }
        app.timeIndex = (app.timeIndex + 1) % app.times.length;
        document.getElementById('voc-ts-select').value = app.timeIndex;
        renderActiveTab();
    }

    function startPlayback() {
        var btn = document.getElementById('voc-btn-play');
        if (!btn) { return; }
        app.playing = true;
        btn.textContent = '\u23F8 Pause';
        btn.classList.add('voc-btn-danger');

        var speedBtn = document.getElementById('voc-btn-speed');
        var currentInterval = (speedBtn && speedBtn.textContent.indexOf('Fast') !== -1) ? 
            CONFIG.FAST_INTERVAL_MS : CONFIG.DEFAULT_INTERVAL_MS;

        app.playbackHandle = setInterval(function () {
            stepNext();
        }, currentInterval);
    }

    function stopPlayback() {
        var btn = document.getElementById('voc-btn-play');
        if (!btn) { return; }
        app.playing = false;
        btn.textContent = '\u25B6 Play';
        btn.classList.remove('voc-btn-danger');
        if (app.playbackHandle) {
            clearInterval(app.playbackHandle);
            app.playbackHandle = null;
        }
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
                    renderActiveTab();
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
