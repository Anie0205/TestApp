/*global window, document, widget, define */

/*
 * VesselOpsCenter2
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

define('VesselOpsCenter2',
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
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselOpsCenter2/vessel_lifecycle_simulation.csv',
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
    // STATIC BERTH MARKERS (created once at load)
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
                color: '#2ca02c', // Your dynamic colors!
                iconName: 'transportation-dock' // The native guaranteed icon
            },
                options: { 
                    projection: { from: 'WGS84' },
                    stem: false             // Ensures no vertical stick drops down
                }
            });
        });
    }
    // Re-publishes a berth marker with updated color/description when its occupancy changes
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
                color: occupied ? '#d62728' : '#2ca02c', // Your dynamic colors!
                iconName: 'transportation-dock' // The native guaranteed icon
            },
            options: { 
                projection: { from: 'WGS84' },
                stem: false
            }
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
    // UI - built dynamically (no static HTML host page), mirrors the
    // Enterprise Port Command Center console from the HTML twin.
    // ---------------------------------------------------------------------
    var STYLE =
        '<style>' +
        '.voc-widget,.voc-widget *{box-sizing:border-box;}' +
        '.voc-widget{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:14px;background:#f3f4f6;color:#1f2937;line-height:1.4;}' +
        '.voc-header-title{font-size:1.35rem;font-weight:700;color:#111827;margin-bottom:4px;}' +
        '.voc-header-desc{font-size:12px;color:#6b7280;margin-bottom:12px;}' +
        '.voc-status-bar{font-size:11.5px;color:#374151;background:#fff;padding:7px 10px;border-radius:6px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);}' +
        '.voc-control-panel{background:#fff;padding:14px;border-radius:8px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,0.05);display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;}' +
        '.voc-control-group{display:flex;flex-direction:column;gap:4px;flex:1;min-width:165px;}' +
        '.voc-playback-group{display:flex;gap:8px;align-items:flex-end;flex:0 1 auto;min-width:auto;}' +
        '.voc-control-group label{font-weight:600;font-size:11px;color:#4b5563;}' +
        '.voc-control-group select,.voc-control-group input[type="text"]{padding:7px 10px;font-size:13px;border-radius:6px;border:1px solid #d1d5db;background:#fff;width:100%;outline:none;}' +
        '.voc-control-group select:focus,.voc-control-group input[type="text"]:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.15);}' +
        '.voc-btn{padding:8px 14px;font-size:13px;font-weight:600;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;white-space:nowrap;transition:all .2s;}' +
        '.voc-btn:hover{background:#f9fafb;border-color:#9ca3af;}' +
        '.voc-btn.voc-active{background:#fee2e2;color:#ef4444;border-color:#fca5a5;}' +
        '.voc-tab-bar{display:flex;gap:4px;margin-bottom:13px;border-bottom:2px solid #e5e7eb;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch;}' +
        '.voc-tab-bar::-webkit-scrollbar{display:none;}' +
        '.voc-tab-btn{padding:10px 14px;font-size:12.5px;font-weight:600;border:none;background:none;border-radius:6px 6px 0 0;cursor:pointer;color:#6b7280;border-bottom:2px solid transparent;margin-bottom:-2px;}' +
        '.voc-tab-btn.voc-tab-active{color:#3b82f6;border-bottom:2px solid #3b82f6;background:#fff;}' +
        '.voc-tab-content{display:none;}' +
        '.voc-tab-content.voc-tab-content-active{display:block;}' +
        '.voc-kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:10px;margin-bottom:13px;}' +
        '.voc-kpi-card{background:#fff;padding:12px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.05);display:flex;flex-direction:column;position:relative;}' +
        '.voc-kpi-card label{font-size:10.5px;font-weight:600;color:#4b5563;margin-bottom:2px;}' +
        '.voc-kpi-val{font-size:18px;font-weight:700;color:#111827;margin-bottom:5px;}' +
        '.voc-kpi-explanation{font-size:10px;color:#6b7280;border-top:1px dashed #e5e7eb;padding-top:4px;font-style:italic;line-height:1.3;}' +
        '.voc-vessel-panel-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;}' +
        '@media(max-width:1024px){.voc-vessel-panel-grid{grid-template-columns:1fr;}}' +
        '.voc-matrix-container{background:#fff;padding:14px;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,0.05);overflow-x:auto;margin-bottom:14px;}' +
        '.voc-matrix-container table{width:100%;border-collapse:collapse;min-width:850px;text-align:center;}' +
        '.voc-matrix-container th,.voc-matrix-container td{padding:8px 5px;border:1px solid #e5e7eb;font-size:11.5px;}' +
        '.voc-matrix-container th{background:#f9fafb;font-weight:600;color:#374151;}' +
        '.voc-vessel-row{cursor:pointer;}' +
        '.voc-vessel-row:hover td{background:#f8fafc;}' +
        '.voc-vessel-axis-cell{text-align:left;font-weight:bold;background:#f9fafb;min-width:180px;color:#111827;position:sticky;left:0;box-shadow:2px 0 5px -2px rgba(0,0,0,0.1);}' +
        '.voc-drilldown-row{background:#f8fafc;display:none;}' +
        '.voc-drilldown-container{padding:10px;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:6px;margin:4px auto;width:98%;overflow-x:auto;}' +
        '.voc-subtable{width:100%;border-collapse:collapse;min-width:700px;}' +
        '.voc-subtable th{background:#f1f5f9;color:#475569;font-size:10.5px;padding:5px;}' +
        '.voc-subtable td{padding:5px;font-size:10.5px;border:1px solid #e2e8f0;background:#fff;}' +
        '.voc-berth-badge{display:inline-block;padding:2px 4px;font-size:10px;border-radius:4px;font-weight:600;margin-top:4px;background:#f3e8ff;color:#6b21a8;border:1px solid #e9d5ff;}' +
        '.voc-delay-warning-tag{display:block;font-size:9px;color:#b91c1c;font-weight:bold;margin-top:4px;text-transform:uppercase;background:rgba(254,226,226,0.6);padding:1px 2px;border-radius:3px;}' +
        '.voc-cell-empty{background:#fcfcfd;color:#d1d5db;}' +
        '.voc-cell-low{background:#dcfce7;color:#166534;}' +
        '.voc-cell-med{background:#eff6ff;color:#1e40af;}' +
        '.voc-cell-critical{background:#fee2e2;color:#991b1b;}' +
        '.voc-charts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:8px;}' +
        '.voc-chart-card{background:#fff;padding:14px;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,0.05);width:100%;overflow:hidden;display:flex;flex-direction:column;}' +
        '.voc-chart-card.voc-span2{grid-column:1/-1;}' +
        '.voc-chart-title{font-weight:600;font-size:13px;color:#374151;margin-bottom:2px;border-bottom:1px solid #e5e7eb;padding-bottom:5px;}' +
        '.voc-chart-explanation{font-size:10.5px;color:#6b7280;font-style:italic;margin-bottom:10px;margin-top:2px;line-height:1.3;}' +
        '.voc-grid-col{display:flex;flex-direction:column;gap:14px;}' +
        '.voc-tip{font-size:11px;color:#6b7280;font-style:italic;display:block;margin-bottom:8px;}' +
        '</style>';

    function kpiCard(id, label, color, explanation) {
        return '<div class="voc-kpi-card" style="border-left:4px solid ' + color + ';">' +
            '<label>' + label + '</label>' +
            '<div class="voc-kpi-val" id="' + id + '">-</div>' +
            '<div class="voc-kpi-explanation">' + explanation + '</div>' +
            '</div>';
    }

    function tabButton(id, label, isFirst) {
        return '<button class="voc-tab-btn' + (isFirst ? ' voc-tab-active' : '') + '" id="voc-btn-' + id + '">' + label + '</button>';
    }

    function buildHtml() {
        var html = STYLE + '<div class="voc-widget">' +
            '<div class="voc-header-title">Enterprise Port Command Center</div>' +
            '<div class="voc-header-desc">Dynamic role-based operational intelligence console - synced live with the 3D port scene.</div>' +
            '<div class="voc-status-bar" id="voc-status">Initializing...</div>' +

            '<div class="voc-control-panel">' +
                '<div class="voc-control-group">' +
                    '<label for="voc-ts-select">Snapshot Timeline (Time Slider)</label>' +
                    '<select id="voc-ts-select"></select>' +
                '</div>' +
                '<div class="voc-control-group voc-playback-group">' +
                    '<button class="voc-btn" id="voc-play-btn">\u25B6 Play</button>' +
                    '<button class="voc-btn" id="voc-next-btn">Next \u2794</button>' +
                    '<select id="voc-speed" style="width:auto;">' +
                        '<option value="' + CONFIG.DEFAULT_INTERVAL_MS + '">Normal</option>' +
                        '<option value="' + CONFIG.FAST_INTERVAL_MS + '">Fast</option>' +
                    '</select>' +
                '</div>' +
                '<div class="voc-control-group">' +
                    '<label for="voc-date-filter">Date Scope Filter</label>' +
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
                '<div class="voc-control-group">' +
                    '<label for="voc-shift-filter">Work Shift Window</label>' +
                    '<select id="voc-shift-filter">' +
                        '<option value="ALL" selected>All Shifts (24 Hours)</option>' +
                        '<option value="MORNING">Morning Shift (06:00 - 14:00)</option>' +
                        '<option value="AFTERNOON">Afternoon Shift (14:00 - 22:00)</option>' +
                        '<option value="NIGHT">Night Shift (22:00 - 06:00)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="voc-control-group">' +
                    '<label for="voc-status-filter">Vessel Tracking Pipeline</label>' +
                    '<select id="voc-status-filter">' +
                        '<option value="IN_PORT" selected>In Port (Active Operations)</option>' +
                        '<option value="ALL">All Tracked Voyages</option>' +
                        '<option value="PRE_ARRIVAL">Pre-Arrival Only</option>' +
                        '<option value="DEPARTED">Departed Only</option>' +
                    '</select>' +
                '</div>' +
                '<div class="voc-control-group">' +
                    '<label for="voc-matrix-sort">Matrix Sorting Priority</label>' +
                    '<select id="voc-matrix-sort">' +
                        '<option value="TOTAL_TIME_DESC">Total Time Spent (Max \u2794 Min)</option>' +
                        '<option value="RECENT_EVENT_DESC" selected>Most Recent Update Timeline</option>' +
                        '<option value="VESSEL_ID_ASC">Vessel ID (A \u2794 Z)</option>' +
                        '<option value="CARGO_VOLUME_DESC">Total Cargo Volume (Max TEU)</option>' +
                    '</select>' +
                '</div>' +
                '<div class="voc-control-group">' +
                    '<label for="voc-search-input">Universal Quick Search Lookup</label>' +
                    '<input type="text" id="voc-search-input" placeholder="Search ID, Line, Substage...">' +
                '</div>' +
            '</div>' +

            '<div class="voc-tab-bar">' +
                tabButton('executive', 'Executive Insights', true) +
                tabButton('vessels', 'Vessel Tracking Matrix', false) +
                tabButton('terminals', 'Terminal &amp; Berth', false) +
                tabButton('operations', 'Operations &amp; Cranes', false) +
                tabButton('environment', 'Environmental Context', false) +
            '</div>' +

            // ---- Executive tab ----
            '<div id="voc-tab-executive" class="voc-tab-content voc-tab-content-active">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-exe-tat', 'Avg Turnaround Time (TAT)', '#3b82f6', 'Total elapsed hours from port footprint entry to final open sea sail validation milestone.') +
                    kpiCard('voc-kpi-exe-cap', 'Capacity Utilization Load', '#10b981', 'Percentage ratio of active TEU exchange compared against total maximum vessel capacity sizes.') +
                    kpiCard('voc-kpi-exe-delpct', 'Delayed Voyage Ratio', '#ef4444', 'Percentage share of total active vessel manifests reporting active disruption exception logs.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card">' +
                        '<div class="voc-chart-title">Congestion Gaps by Carrier Line (Hours)</div>' +
                        '<div class="voc-chart-explanation">Tracks accumulated demurrage/idle hours spent waiting across operations by carrier account tags.</div>' +
                        '<div id="voc-exe-demurrage-chart"></div>' +
                    '</div>' +
                    '<div class="voc-chart-card">' +
                        '<div class="voc-chart-title">Primary Logistical Delay Factor Distribution (Pie)</div>' +
                        '<div class="voc-chart-explanation">Frequencies breakdown showing the leading operational root cause bottlenecks across the system.</div>' +
                        '<div id="voc-exe-delay-pie"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // ---- Vessels tab ----
            '<div id="voc-tab-vessels" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-vsl-active', 'Active Hulls In Port', '#2563eb', 'Vessels currently berthed or transiting within port operational limits.') +
                    kpiCard('voc-kpi-vsl-plan', 'Pre-Arrival Pipeline', '#d97706', 'Vessels currently listed in the planning stages with active ETA receipts logged.') +
                    kpiCard('voc-kpi-vsl-anch', 'Avg Anchorage Idle Time', '#dc2626', 'Average duration vessels sit at sea waiting for pilot channel access validation.') +
                '</div>' +
                '<div class="voc-vessel-panel-grid">' +
                    '<div class="voc-matrix-container">' +
                        '<span class="voc-tip">\uD83D\uDCA1 Tip: Click on a row to expand its comprehensive sub-stage timeline. The 3D scene tracks whichever snapshot is selected above.</span>' +
                        '<table><thead><tr id="voc-matrix-header"></tr></thead><tbody id="voc-matrix-body"></tbody></table>' +
                    '</div>' +
                    '<div class="voc-grid-col">' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Vessel Fleet Mix Profile (Pie)</div><div id="voc-vsl-mix-donut"></div></div>' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Capacity Threshold Allocation (TEU Capacity Ranges)</div><div id="voc-vsl-capacity-bar"></div></div>' +
                        '<div class="voc-chart-card"><div class="voc-chart-title">Vessels Queue Count by Active Stage</div><div id="voc-vsl-stage-bar"></div></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // ---- Terminals tab ----
            '<div id="voc-tab-terminals" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-term-imp', 'Total Imports Handled', '#059669', 'Cumulative discharge container volume targets achieved up to the selected timestamp.') +
                    kpiCard('voc-kpi-term-exp', 'Total Exports Handled', '#0891b2', 'Cumulative loaded container volume targets processed out to outbound manifests.') +
                    kpiCard('voc-kpi-term-occupancy', 'Active Berth Occupancy Index', '#4f46e5', 'Percentage calculation of fixed mooring locations currently holding active hull weights.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2">' +
                        '<div class="voc-chart-title">Terminal \u2794 Berth Dynamic Usage: Side-by-Side Imports &amp; Exports Insights</div>' +
                        '<div class="voc-chart-explanation">Provides clear visual asset evaluation showing exactly how much inbound (Import) vs outbound (Export) container counts passed through each independent structural berth node.</div>' +
                        '<div id="voc-term-geo-bar"></div>' +
                    '</div>' +
                    '<div class="voc-chart-card voc-span2">' +
                        '<div class="voc-chart-title">Physical Container Load Category Type Proportions (Pie)</div>' +
                        '<div class="voc-chart-explanation">Tracks specialized distribution configurations (Dry Van vs. Reefer Cargo plug configurations).</div>' +
                        '<div id="voc-term-type-pie"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // ---- Operations tab ----
            '<div id="voc-tab-operations" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-ops-cranes', 'Avg Cranes Assigned Intensity', '#7c3aed', 'Mean intensity volume of heavy machinery crane sets allocated per vessel loading phase.') +
                    kpiCard('voc-kpi-ops-speed', 'Mean Crane Velocity Pace', '#2563eb', 'Calculated handling exchange velocity mapping cargo volumes directly against crane operational hours.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2">' +
                        '<div class="voc-chart-title">Crane Allocation Count Density vs Handling Velocity Rate</div>' +
                        '<div class="voc-chart-explanation">Scatter analysis checking whether high crane clustering actually maximizes operational speeds.</div>' +
                        '<div id="voc-ops-efficiency-scatter"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // ---- Environment tab ----
            '<div id="voc-tab-environment" class="voc-tab-content">' +
                '<div class="voc-kpi-row">' +
                    kpiCard('voc-kpi-env-weather', 'Current Weather Metric', '#4b5563', 'Categorical atmospheric descriptor tracker (Clear, Rainy, Rough) logged at current timestamp.') +
                    kpiCard('voc-kpi-env-tide', 'Real-Time Tide Water Level', '#06b6d4', 'Physical hydrographic water level displacement height logged in meters - also driving the 3D tide-gauge marker.') +
                '</div>' +
                '<div class="voc-charts-grid">' +
                    '<div class="voc-chart-card voc-span2">' +
                        '<div class="voc-chart-title">Environmental Correlation: Tide Level Fluctuations vs Active Port Disruptions</div>' +
                        '<div class="voc-chart-explanation">Cross-references water level drops against active delay spike frequency logs across the channel.</div>' +
                        '<div id="voc-env-tide-line"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +

        '</div>';

        return html;
    }

    function initUi() {
        widget.body.empty();
        UWA.createElement('div', { html: buildHtml() }).inject(widget.body);

        app.statusBar = document.getElementById('voc-status');

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

        document.getElementById('voc-play-btn').addEventListener('click', togglePlayback);
        document.getElementById('voc-next-btn').addEventListener('click', function () { stepPlayback(1); });

        TABS.forEach(function (t) {
            document.getElementById('voc-btn-' + t).addEventListener('click', function () { switchTab(t); });
        });

        // Event delegation: expand/collapse a vessel's sub-stage timeline drilldown
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
    // CHART RENDERING (ApexCharts) - same chart helpers as the HTML twin
    // ---------------------------------------------------------------------
    function safeRender(id, config) {
        if (app.chartsMap[id]) {
            config.chart.animations = { enabled: false };
            app.chartsMap[id].updateOptions(config, false, false);
        } else {
            config.chart.animations = { enabled: app.isFirstLoad, animateOnDataChange: false };
            var el = document.getElementById(id);
            if (el && window.ApexCharts) {
                app.chartsMap[id] = new window.ApexCharts(el, config);
                app.chartsMap[id].render();
            }
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
            document.getElementById('voc-btn-' + t).classList.remove('voc-tab-active');
            document.getElementById('voc-tab-' + t).classList.remove('voc-tab-content-active');
        });
        document.getElementById('voc-btn-' + tabId).classList.add('voc-tab-active');
        document.getElementById('voc-tab-' + tabId).classList.add('voc-tab-content-active');
        renderActiveTab();
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
