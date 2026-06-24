/*global window, document, widget, define */

/*
 * VesselOpsCenter
 * ---------------------------------------------------------------------
 * Fully optimized version mapping 100% of the analytical, filtering, 
 * matrix processing, and custom chart telemetry from vessel_heatmap8.html
 * into the required platform AMD structure.
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

    function verifyShiftMatch(timeStr, targetShift) {
        if (targetShift === 'ALL') { return true; }
        var parts = timeStr.split(' ');
        if (parts.length < 2) { return true; }
        var hour = parseInt(parts[1].split(':')[0], 10);
        if (targetShift === 'MORNING') { return (hour >= 6 && hour < 14); }
        if (targetShift === 'AFTERNOON') { return (hour >= 14 && hour < 22); }
        if (targetShift === 'NIGHT') { return (hour >= 22 || hour < 6); }
        return true;
    }

    // ---------------------------------------------------------------------
    // GLOBAL STYLING DICTIONARY
    // ---------------------------------------------------------------------
    var STYLE = '<style>' +
        '.voc-wrap,.voc-wrap *{box-sizing:border-box;}' +
        '.voc-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'background:#f3f4f6;color:#1f2937;line-height:1.4;width:100%;height:100%;min-height:320px;overflow:auto;}' +
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
        '.voc-delay-tag{display:block;font-size:8.5px;color:#b91c1c;font-weight:bold;margin-top:2px;' +
        'text-transform:uppercase;background:rgba(254,226,226,0.6);padding:1px 2px;border-radius:3px;}' +
        '.voc-cell-empty{background:#fcfcfd;color:#d1d5db;}' +
        '.voc-cell-low{background:#dcfce7;color:#166534;}' +
        '.voc-cell-med{background:#eff6ff;color:#1e40af;}' +
        '.voc-cell-critical{background:#fee2e2;color:#991b1b;}' +
        '.voc-vessel-panel-grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;}' +
        '@media(max-width:1024px){.voc-vessel-panel-grid{grid-template-columns:1fr;}}' +
        '</style>';

    // ---------------------------------------------------------------------
    // APEXCHARTS OPTIMIZED RENDER SYSTEM
    // ---------------------------------------------------------------------
    function safeRender(id, options) {
        var el = document.getElementById(id);
        if (!el) { return; }
        if (app.chartsMap[id]) {
            options.chart = options.chart || {};
            options.chart.animations = { enabled: false };
            app.chartsMap[id].updateOptions(options, false, false);
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

    // ---------------------------------------------------------------------
    // CENTRAL TIMELINE SYNC ENGINE (Harvested fully from HTML script)
    // ---------------------------------------------------------------------
    function renderActiveTab() {
        if (!app.times.length) { return; }

        var selectedTimestamp = document.getElementById('voc-ts-select').value;
        var dateScope = document.getElementById('voc-date-filter').value;
        var shiftScope = document.getElementById('voc-shift-filter').value;
        var filterValue = document.getElementById('voc-status-filter').value;
        var sortValue = document.getElementById('voc-matrix-sort').value;
        var searchQuery = document.getElementById('voc-search-input').value.toLowerCase().trim();

        var cutoff = new Date(selectedTimestamp.replace(' ', 'T'));

        // Core filter optimization
        var filtered = app.events.filter(function (r) {
            var d = parseEventDate(r.event_time);
            if (d > cutoff) { return false; }
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

        var envWeather = "CLEAR", envTide = 0.0;
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
                    latestRow: null
                };
            }

            var meta = metadata[key];
            meta.latestRow = r;
            if (r.terminal && r.terminal !== "NaN") { meta.terminal = r.terminal; }
            if (r.berth && r.berth !== "NaN") { meta.berth = r.berth; }

            var timeStr = r.event_time;
            var currentEventDate = parseEventDate(timeStr);

            if (currentEventDate >= meta.latestEventTime) {
                meta.latestEventTime = currentEventDate;
                meta.latestSubstage = r.substage || r.stage;
            }

            if (!timelineTideMap[timeStr]) {
                timelineTideMap[timeStr] = r.tide_level || 0;
                timelineDelayCountMap[timeStr] = 0;
            }

            if (r.delay_reason && r.delay_reason !== "NaN" && String(r.delay_reason).trim() !== "") {
                meta.stageDelays[r.stage] = r.delay_reason;
                delayReasonCounts[r.delay_reason] = (delayReasonCounts[r.delay_reason] || 0) + 1;
                timelineDelayCountMap[timeStr]++;
                shippingLineDelayMap[r.shipping_line] = (shippingLineDelayMap[r.shipping_line] || 0) + 1;
            }

            if (r.container_type && r.container_type !== "NaN") {
                containerTypeCounts[r.container_type] = (containerTypeCounts[r.container_type] || 0) + 1;
            }

            if (parseEventDate(r.event_time).getTime() === cutoff.getTime()) {
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

                if (meta.vesselClass) { vesselClassMap[meta.vesselClass] = (vesselClassMap[meta.vesselClass] || 0) + 1; }
                vesselStageMap[latest.stage] = (vesselStageMap[latest.stage] || 0) + 1;

                if (meta.capacity < 3000) { capacityRangeMap['Under 3k TEU']++; }
                else if (meta.capacity <= 6000) { capacityRangeMap['3k - 6k TEU']++; }
                else if (meta.capacity <= 10000) { capacityRangeMap['6k - 10k TEU']++; }
                else { capacityRangeMap['Above 10k TEU']++; }

                if (meta.terminal !== '-' && meta.berth !== '-') {
                    var geoKey = meta.terminal + '➔' + meta.berth;
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
                var mSub = meta.substagesList.some(function (s) { return (s.substage || '').toLowerCase().indexOf(searchQuery) !== -1; });
                if (!mId && !mLine && !mSub) { return; }
            }

            matrixDataRows.push({ key: key, meta: meta, rowDurations: rowDurations });
        });

        // Dynamic multi-tier matrix sorting routing
        matrixDataRows.sort(function (a, b) {
            if (sortValue === 'TOTAL_TIME_DESC') { return b.meta.totalRowHours - a.meta.totalRowHours; }
            if (sortValue === 'RECENT_EVENT_DESC') { return b.meta.latestEventTime - a.meta.latestEventTime; }
            if (sortValue === 'VESSEL_ID_ASC') { return a.meta.vesselId.localeCompare(b.meta.vesselId); }
            if (sortValue === 'CARGO_VOLUME_DESC') { return (b.meta.importTeu + b.meta.exportTeu) - (a.meta.importTeu + a.meta.exportTeu); }
            return 0;
        });

        // Sync 3D markers twin tracking
        syncSceneMarkers(metadata, envTide);

        // Hide/Unhide view content panes
        TABS.forEach(function (t) {
            var pane = document.getElementById('voc-pane-' + t);
            if (pane) { pane.classList.remove('voc-active'); }
        });
        var activePane = document.getElementById('voc-pane-' + app.currentTab);
        if (activePane) { activePane.classList.add('voc-active'); }

        // ---------------------------------------------------------------------
        // PERSPECTIVE DISPATCH ROUTER (Tab specific visualization loading)
        // ---------------------------------------------------------------------
        if (app.currentTab === 'executive') {
            document.getElementById('kpi-exe-tat').textContent = totalVoyages > 0 ? (totalCargoHours / totalVoyages * 1.8).toFixed(1) + "h" : "0.0h";
            document.getElementById('kpi-exe-cap').textContent = cumulativeCapacity > 0 ? ((totalImports + totalExports) / cumulativeCapacity * 100).toFixed(1) + "%" : "0.0%";
            document.getElementById('kpi-exe-delpct').textContent = totalVoyages > 0 ? (countDelayedVoyages / totalVoyages * 100).toFixed(1) + "%" : "0.0%";

            safeRender('voc-exe-demurrage-chart', {
                series: [{ name: 'Delay Frequency', data: Object.values(shippingLineDelayMap) }],
                chart: { type: 'bar', height: 200, toolbar: { show: false } },
                colors: ['#3b82f6'],
                plotOptions: { bar: { dataLabels: { position: 'top' } } },
                xaxis: { categories: Object.keys(shippingLineDelayMap), labels: { rotate: -45, style: { fontSize: '9px' } } },
                dataLabels: { enabled: true, style: { fontSize: '10px', colors: ["#333"] }, offsetY: -18 }
            });

            safeRender('voc-exe-delay-pie', {
                series: Object.values(delayReasonCounts), labels: Object.keys(delayReasonCounts),
                chart: { type: 'pie', height: 200 },
                legend: { position: 'bottom', fontSize: '10px' }
            });

        } else if (app.currentTab === 'vessels') {
            document.getElementById('kpi-vsl-active').textContent = activeInPort;
            document.getElementById('kpi-vsl-plan').textContent = preArrival;
            document.getElementById('kpi-vsl-anch').textContent = countAnchorage > 0 ? (sumAnchorageWait / countAnchorage).toFixed(1) + "h" : "0.0h";

            var header = document.getElementById('voc-matrix-header');
            var hHtml = '<th style="position: sticky; left:0; z-index:5;">Vessel Infrastructure</th>';
            STAGES.forEach(function (s) { hHtml += '<th>' + esc(s) + '</th>'; });
            hHtml += '<th>Total</th>';
            header.innerHTML = hHtml;

            var tbody = document.getElementById('voc-matrix-body');
            tbody.innerHTML = '';

            matrixDataRows.forEach(function (rowObj) {
                var mKey = rowObj.key;
                var meta = rowObj.meta;
                var durations = rowObj.rowDurations;

                var subHtml = '';
                meta.substagesList.forEach(function (s) {
                    subHtml += '<tr><td>' + esc(s.timeStr) + '</td><td>' + esc(s.stage) + '</td><td><code>' + esc(s.substage || '-') + '</code></td><td>' + esc(s.cranes) + '</td><td>' + esc(s.weather) + '</td><td>' + esc(s.delay) + '</td></tr>';
                });

                var formattedTime = meta.latestEventTime.toISOString().split('T')[1].substring(0, 5);

                var rowHtml = '<tr class="voc-vessel-row" id="voc-row-click-' + esc(mKey) + '">' +
                    '<td class="voc-vessel-axis-cell">' +
                        '▶ ' + esc(meta.vesselId) + ' <span style="font-size:10px; font-weight:normal; color:#6b7280;">(' + esc(meta.voyageNo) + ')</span><br>' +
                        '<span class="voc-berth-badge">' + esc(meta.terminal) + '/' + esc(meta.berth) + '</span>' +
                        '<span style="display:block; font-size:9.5px; color:#4b5563; font-weight:normal; margin-top:3px; background:#f1f5f9; padding:1px 4px; border-radius:3px;">' +
                            '⏱️ Upd: ' + esc(meta.latestSubstage) + ' (' + formattedTime + ')' +
                        '</span>' +
                    '</td>';

                STAGES.forEach(function (s) {
                    var d = durations[s];
                    var hClass = d > 0 ? (d <= 4 ? 'voc-cell-low' : d <= 24 ? 'voc-cell-med' : 'voc-cell-critical') : 'voc-cell-empty';
                    rowHtml += '<td class="' + hClass + '"><strong>' + (d > 0 ? d.toFixed(1) + 'h' : '-') + '</strong>' + (meta.stageDelays[s] ? '<span class="voc-delay-tag">⚠️ ' + esc(meta.stageDelays[s]) + '</span>' : '') + '</td>';
                });

                rowHtml += '<td>' + meta.totalRowHours.toFixed(1) + 'h</td></tr>' +
                    '<tr class="voc-drilldown-row" id="voc-sub-' + esc(mKey) + '"><td colspan="' + (STAGES.length + 2) + '"><div class="voc-drilldown-container">' +
                        '<table class="voc-subtable"><thead><tr><th>Timestamp</th><th>Stage</th><th>Substage</th><th>Cranes</th><th>Weather</th><th>Alert Context</th></tr></thead><tbody>' + subHtml + '</tbody></table>' +
                    '</div></td></tr>';

                tbody.innerHTML += rowHtml;
            });

            // Re-bind accordion clicks
            matrixDataRows.forEach(function (rowObj) {
                var clickTarget = document.getElementById('voc-row-click-' + rowObj.key);
                if (clickTarget) {
                    clickTarget.addEventListener('click', function () {
                        var targetRow = document.getElementById('voc-sub-' + rowObj.key);
                        if (targetRow) {
                            if (targetRow.classList.contains('voc-open')) {
                                targetRow.classList.remove('voc-open');
                            } else {
                                targetRow.classList.add('voc-open');
                            }
                        }
                    });
                }
            });

            safeRender('voc-vsl-mix-donut', {
                series: Object.values(vesselClassMap), labels: Object.keys(vesselClassMap),
                chart: { type: 'pie', height: 200 },
                legend: { position: 'bottom', fontSize: '10px' }
            });

            safeRender('voc-vsl-capacity-bar', {
                series: [{ name: 'Vessels Count', data: Object.values(capacityRangeMap) }],
                chart: { type: 'bar', height: 200, toolbar: { show: false } },
                colors: ['#3b82f6'],
                xaxis: { categories: Object.keys(capacityRangeMap) }
            });

            safeRender('voc-vsl-stage-bar', {
                series: [{ name: 'Queue Count', data: Object.values(vesselStageMap) }],
                chart: { type: 'bar', height: 200, toolbar: { show: false } },
                colors: ['#3b82f6'],
                xaxis: { categories: Object.keys(vesselStageMap) }
            });

        } else if (app.currentTab === 'terminals') {
            document.getElementById('kpi-term-imp').textContent = totalImports.toLocaleString() + " TEU";
            document.getElementById('kpi-term-exp').textContent = totalExports.toLocaleString() + " TEU";
            document.getElementById('kpi-term-occupancy').textContent = activeInPort > 0 ? Math.min(100, (activeInPort * 12)).toFixed(0) + "%" : "0%";

            var allGeoCategories = Array.from(new Set([].concat(Object.keys(strictBerthImports), Object.keys(strictBerthExports)))).sort();
            var finalImportValues = allGeoCategories.map(function (cat) { return strictBerthImports[cat] || 0; });
            var finalExportValues = allGeoCategories.map(function (cat) { return strictBerthExports[cat] || 0; });

            safeRender('voc-term-geo-bar', {
                series: [
                    { name: 'Imports Throughput (TEU)', data: finalImportValues },
                    { name: 'Exports Throughput (TEU)', data: finalExportValues }
                ],
                chart: { type: 'bar', height: 280, toolbar: { show: false } },
                colors: ['#059669', '#0891b2'],
                plotOptions: { bar: { dataLabels: { position: 'top' }, columnWidth: '65%' } },
                xaxis: { categories: allGeoCategories, labels: { rotate: -45, style: { fontSize: '9px' } } },
                dataLabels: { enabled: true, style: { fontSize: '9px', colors: ["#333"] }, offsetY: -16 },
                legend: { position: 'top', horizontalAlign: 'right' }
            });

            safeRender('voc-term-type-pie', {
                series: Object.values(containerTypeCounts), labels: Object.keys(containerTypeCounts),
                chart: { type: 'pie', height: 200 },
                legend: { position: 'bottom', fontSize: '10px' }
            });

        } else if (app.currentTab === 'operations') {
            document.getElementById('kpi-ops-cranes').textContent = countCranes > 0 ? (sumCranes / countCranes).toFixed(1) : "0.0";
            document.getElementById('kpi-ops-speed').textContent = totalCargoHours > 0 ? ((totalImports + totalExports) / totalCargoHours).toFixed(1) + " TEU/h" : "0.0 TEU/h";

            safeRender('voc-ops-efficiency-scatter', {
                series: [{ name: 'Vessel Performance', data: opsScatterPoints }],
                chart: { type: 'scatter', height: 240, toolbar: { show: false } },
                xaxis: { title: { text: 'Cranes Allocated', style: { fontSize: '11px' } }, tickAmount: 4 },
                yaxis: { title: { text: 'Velocity (TEU/hr)', style: { fontSize: '11px' } } }
            });

        } else if (app.currentTab === 'environment') {
            document.getElementById('kpi-env-weather').textContent = envWeather;
            document.getElementById('kpi-env-tide').textContent = envTide.toFixed(2) + "m";

            var timesSorted = Object.keys(timelineTideMap).sort().slice(-15);
            var tides = timesSorted.map(function (t) { return parseFloat(timelineTideMap[t].toFixed(2)); });
            var delays = timesSorted.map(function (t) { return timelineDelayCountMap[t]; });

            safeRender('voc-env-tide-line', {
                series: [{ name: 'Tide Level (m)', type: 'line', data: tides }, { name: 'Active Delays', type: 'column', data: delays }],
                chart: { height: 240, type: 'line', toolbar: { show: false } },
                colors: ['#06b6d4', '#ef4444'],
                stroke: { width: [3, 0] },
                xaxis: { categories: timesSorted, labels: { show: false } },
                yaxis: [{ title: { text: 'Water Level (m)', style: { fontSize: '11px' } } }, { opposite: true, title: { text: 'Disruption Counts', style: { fontSize: '11px' } } }]
            });
        }

        app.isFirstLoad = false;
        setStatus('Snapshot synchronized successfully at ' + selectedTimestamp);
    }

    // ---------------------------------------------------------------------
    // FRAMEWORK INTERFACES RENDER
    // ---------------------------------------------------------------------
    function initUi() {
        var styleEl = document.createElement('div');
        styleEl.innerHTML = STYLE;
        document.head.appendChild(styleEl.firstChild);

        var html = 
        '<div class="voc-wrap">' +
            '<div class="voc-inner">' +
                '<div class="voc-topbar">' +
                    '<div class="voc-topbar-left">' +
                        '<div class="voc-title">Enterprise Port Command Center</div>' +
                        '<div class="voc-subtitle">Dynamic Role-Based Operational Intelligence Console Matrix</div>' +
                    '</div>' +
                    '<div class="voc-topbar-right">' +
                        '<div id="voc-active-tab-badge" class="voc-active-badge">Executive Insights</div>' +
                        '<button id="voc-burger-btn" class="voc-icon-btn" title="Perspectives Menu">\u2630</button>' +
                        '<div id="voc-burger-menu" class="voc-burger-menu">' +
                            '<div class="voc-menu-section">Operational Perspectives</div>' +
                            '<button class="voc-menu-item voc-selected" data-tab="executive">Executive Insights</button>' +
                            '<button class="voc-menu-item" data-tab="vessels">Vessel Tracking Matrix</button>' +
                            '<button class="voc-menu-item" data-tab="terminals">Terminal & Berth</button>' +
                            '<button class="voc-menu-item" data-tab="operations">Operations & Cranes</button>' +
                            '<button class="voc-menu-item" data-tab="environment">Environmental Context</button>' +
                        '</div>' +
                    '</div>' +
                '</div>' +

                '<div id="voc-status" class="voc-status-bar">Initializing control console dashboard...</div>' +

                '<div class="voc-main-layout">' +
                    // Control Deck Panel
                    '<div class="voc-control-card">' +
                        '<div class="voc-select-group">' +
                            '<label>Snapshot Timeline (Time Slider)</label>' +
                            '<select id="voc-ts-select" class="voc-select"><option>Loading times...</option></select>' +
                        '</div>' +
                        '<div class="voc-playback-rig">' +
                            '<button id="voc-btn-play" class="voc-btn voc-btn-primary" title="Play">\u25B6 Play</button>' +
                            '<button id="voc-btn-next" class="voc-btn" title="Next snapshot">Next \u2794</button>' +
                        '</div>' +
                        '<div class="voc-select-group">' +
                            '<label>Date Scope Filter</label>' +
                            '<select id="voc-date-filter" class="voc-select">' +
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
                        '<div class="voc-select-group">' +
                            '<label>Work Shift Window</label>' +
                            '<select id="voc-shift-filter" class="voc-select">' +
                                '<option value="ALL" selected>All Shifts (24 Hours)</option>' +
                                '<option value="MORNING">Morning Shift (06:00 - 14:00)</option>' +
                                '<option value="AFTERNOON">Afternoon Shift (14:00 - 22:00)</option>' +
                                '<option value="NIGHT">Night Shift (22:00 - 06:00)</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="voc-select-group">' +
                            '<label>Vessel Tracking Pipeline</label>' +
                            '<select id="voc-status-filter" class="voc-select">' +
                                '<option value="IN_PORT" selected>In Port (Active Operations)</option>' +
                                '<option value="ALL">All Tracked Voyages</option>' +
                                '<option value="PRE_ARRIVAL">Pre-Arrival Only</option>' +
                                '<option value="DEPARTED">Departed Only</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="voc-select-group">' +
                            '<label>Matrix Sorting Priority</label>' +
                            '<select id="voc-matrix-sort" class="voc-select">' +
                                '<option value="TOTAL_TIME_DESC">Total Time Spent (Max \u2794 Min)</option>' +
                                '<option value="RECENT_EVENT_DESC" selected>Most Recent Update Timeline</option>' +
                                '<option value="VESSEL_ID_ASC">Vessel ID (A \u2794 Z)</option>' +
                                '<option value="CARGO_VOLUME_DESC">Total Cargo Volume (Max TEU)</option>' +
                            '</select>' +
                        '</div>' +
                        '<div class="voc-select-group">' +
                            '<label>Universal Quick Search Lookup</label>' +
                            '<input type="text" id="voc-search-input" placeholder="Search ID, Line, Substage..." />' +
                        } +
                    '</div>' +

                    // Tab 1 Frame View Content
                    '<div id="voc-pane-executive" class="voc-pane voc-active">' +
                        '<div class="voc-kpi-row">' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #3b82f6;"><label>Avg Turnaround Time (TAT)</label><div id="kpi-exe-tat" class="voc-kpi-val">0.0h</div><div class="voc-kpi-exp">Total elapsed hours from port footprint entry to final open sea sail validation milestone.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #10b981;"><label>Capacity Utilization Load</label><div id="kpi-exe-cap" class="voc-kpi-val">0.0%</div><div class="voc-kpi-exp">Percentage ratio of active TEU exchange compared against total maximum vessel capacity sizes.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #ef4444;"><label>Delayed Voyage Ratio</label><div id="kpi-exe-delpct" class="voc-kpi-val">0.0%</div><div class="voc-kpi-exp">Percentage share of total active vessel manifests reporting active disruption exception logs.</div></div>' +
                        '</div>' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card"><div class="voc-chart-title">Congestion Gaps by Carrier Line (Hours)</div><div class="voc-chart-exp">Tracks accumulated demurrage/idle hours spent waiting across operations by carrier account tags.</div><div id="voc-exe-demurrage-chart" class="voc-card-body"></div></div>' +
                            '<div class="voc-chart-card"><div class="voc-chart-title">Primary Logistical Delay Factor Distribution (Pie)</div><div class="voc-chart-exp">Frequencies breakdown showing the leading operational root cause bottlenecks across the system.</div><div id="voc-exe-delay-pie" class="voc-card-body"></div></div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 2 Frame View Content
                    '<div id="voc-pane-vessels" class="voc-pane">' +
                        '<div class="voc-kpi-row">' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #2563eb;"><label>Active Hulls In Port</label><div id="kpi-vsl-active" class="voc-kpi-val">0</div><div class="voc-kpi-exp">Vessels currently berthed or transiting within port operational limits.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #d97706;"><label>Pre-Arrival Pipeline</label><div id="kpi-vsl-plan" class="voc-kpi-val">0</div><div class="voc-kpi-exp">Vessels currently listed in the planning stages with active ETA receipts logged.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #dc2626;"><label>Avg Anchorage Idle Time</label><div id="kpi-vsl-anch" class="voc-kpi-val">0.0h</div><div class="voc-kpi-exp">Average duration vessels sit at sea waiting for pilot channel access validation.</div></div>' +
                        '</div>' +
                        '<div class="voc-vessel-panel-grid">' +
                            '<div class="voc-matrix-container">' +
                                '<span style="font-size:11px; color:#6b7280; font-style:italic; display:block; margin-bottom:8px;">\uD83D\uDCA1 Tip: Click on a row to expand its comprehensive sub-stage timeline.</span>' +
                                '<table class="voc-table"><thead><tr id="voc-matrix-header"></tr></thead><tbody id="voc-matrix-body"></tbody></table>' +
                            '</div>' +
                            '<div style="display:flex; flex-direction:column; gap:12px;">' +
                                '<div class="voc-chart-card"><div class="voc-chart-title">Vessel Fleet Mix Profile (Pie)</div><div id="voc-vsl-mix-donut" class="voc-card-body"></div></div>' +
                                '<div class="voc-chart-card"><div class="voc-chart-title">Capacity Threshold Allocation (TEU Capacity Ranges)</div><div id="voc-vsl-capacity-bar" class="voc-card-body"></div></div>' +
                                '<div class="voc-chart-card"><div class="voc-chart-title">Vessels Queue Count by Active Stage</div><div id="voc-vsl-stage-bar" class="voc-card-body"></div></div>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 3 Frame View Content
                    '<div id="voc-pane-terminals" class="voc-pane">' +
                        '<div class="voc-kpi-row">' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #059669;"><label>Total Imports Handled</label><div id="kpi-term-imp" class="voc-kpi-val">0 TEU</div><div class="voc-kpi-exp">Cumulative discharge container volume targets achieved up to the selected timestamp.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #0891b2;"><label>Total Exports Handled</label><div id="kpi-term-exp" class="voc-kpi-val">0 TEU</div><div class="voc-kpi-exp">Cumulative loaded container volume targets processed out to outbound manifests.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #4f46e5;"><label>Active Berth Occupancy Index</label><div id="kpi-term-occupancy" class="voc-kpi-val">0%</div><div class="voc-kpi-exp">Percentage calculation of fixed mooring locations currently holding active hull weights.</div></div>' +
                        '</div>' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card" style="grid-column: 1 / -1;"><div class="voc-chart-title">Terminal \u2794 Berth Dynamic Usage: Side-by-Side Imports & Exports Insights</div><div class="voc-chart-exp">Provides clear visual asset evaluation showing exactly how much inbound (Import) vs outbound (Export) container counts passed through each independent structural berth node.</div><div id="voc-term-geo-bar" class="voc-card-body"></div></div>' +
                            '<div class="voc-chart-card" style="grid-column: 1 / -1;"><div class="voc-chart-title">Physical Container Load Category Type Proportions (Pie)</div><div class="voc-chart-exp">Tracks specialized distribution configurations (Dry Van vs. Reefer Cargo plug configurations).</div><div id="voc-term-type-pie" class="voc-card-body"></div></div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 4 Frame View Content
                    '<div id="voc-pane-operations" class="voc-pane">' +
                        '<div class="voc-kpi-row">' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #7c3aed;"><label>Avg Cranes Assigned Intensity</label><div id="kpi-ops-cranes" class="voc-kpi-val">0.0</div><div class="voc-kpi-exp">Mean intensity volume of heavy machinery crane sets allocated per vessel loading phase.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #2563eb;"><label>Mean Crane Velocity Pace</label><div id="kpi-ops-speed" class="voc-kpi-val">0.0 TEU/h</div><div class="voc-kpi-exp">Calculated handling exchange velocity mapping cargo volumes directly against crane operational hours.</div></div>' +
                        '</div>' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card" style="grid-column: 1 / -1;"><div class="voc-chart-title">Crane Allocation Count Density vs Handling Velocity Rate</div><div class="voc-chart-exp">Scatter analysis checking whether high crane clustering actually maximizes operational speeds.</div><div id="voc-ops-efficiency-scatter" class="voc-card-body"></div></div>' +
                        '</div>' +
                    '</div>' +

                    // Tab 5 Frame View Content
                    '<div id="voc-pane-environment" class="voc-pane">' +
                        '<div class="voc-kpi-row">' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #4b5563;"><label>Current Weather Metric</label><div id="kpi-env-weather" class="voc-kpi-val">-</div><div class="voc-kpi-exp">Categorical atmospheric descriptor tracker (Clear, Rainy, Rough) logged at current timestamp.</div></div>' +
                            '<div class="voc-kpi-card" style="border-left:4px solid #06b6d4;"><label>Real-Time Tide Water Level</label><div id="kpi-env-tide" class="voc-kpi-val">0.00m</div><div class="voc-kpi-exp">Physical hydrographic water level displacement height logged in meters.</div></div>' +
                        '</div>' +
                        '<div class="voc-charts-grid">' +
                            '<div class="voc-chart-card" style="grid-column: 1 / -1;"><div class="voc-chart-title">Environmental Correlation: Tide Level Fluctuations vs Active Port Disruptions</div><div class="voc-chart-exp">Cross-references water level drops against active delay spike frequency logs across the channel.</div><div id="voc-env-tide-line" class="voc-card-body"></div></div>' +
                        '</div>' +
                    '</div>' +

                '</div>' +
            '</div>' +
        '</div>';

        widget.body.innerHTML = html;
        app.statusBar = document.getElementById('voc-status');

        // Toggle Burger perspectives dropdown panel bar setup
        var burgerBtn = document.getElementById('voc-burger-btn');
        var burgerMenu = document.getElementById('voc-burger-menu');
        burgerBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            burgerMenu.classList.toggle('voc-open');
        });

        document.addEventListener('click', function () {
            burgerMenu.classList.remove('voc-open');
        });

        // Register filter core change update hooks
        var filtersList = ['voc-date-filter', 'voc-shift-filter', 'voc-status-filter', 'voc-matrix-sort', 'voc-ts-select'];
        filtersList.forEach(function (fid) {
            document.getElementById(fid).addEventListener('change', function () {
                if (this.id === 'voc-ts-select') { app.timeIndex = this.selectedIndex; }
                renderActiveTab();
            });
        });

        document.getElementById('voc-search-input').addEventListener('input', function () {
            renderActiveTab();
        });

        // Tab routing perspective buttons trigger actions
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

        // Automate timeline simulation tools
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
    }

    function populateTimelineSelect() {
        var select = document.getElementById('voc-ts-select');
        if (!select) { return; }
        var h = '';
        app.times.forEach(function (t, idx) {
            h += '<option value="' + esc(t) + '">' + esc(t) + '</option>';
        });
        select.innerHTML = h;
    }

    function stepNext() {
        if (!app.times.length) { return; }
        app.timeIndex = (app.timeIndex + 1) % app.times.length;
        var sel = document.getElementById('voc-ts-select');
        sel.selectedIndex = app.timeIndex;
        renderActiveTab();
    }

    function startPlayback() {
        var btn = document.getElementById('voc-btn-play');
        if (!btn) { return; }
        app.playing = true;
        btn.textContent = '\u23F8 Pause';
        btn.classList.add('voc-btn-danger');

        app.playbackHandle = setInterval(function () {
            stepNext();
        }, CONFIG.DEFAULT_INTERVAL_MS);
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
    // LOAD BOOTSTRAPPING
    // ---------------------------------------------------------------------
    function onLoad() {
        initUi();
        initBerthMarkers();
        publishTideMarker('-');
        setStatus('Loading chart libraries and contextual port telemetry matrices...');

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
                    setStatus('Telemetry event data log keys look empty.', true);
                }
            })
            .catch(function (err) {
                setStatus('Failed to load asset stream parameters: ' +
                    (err && err.message ? err.message : err), true);
            });
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});