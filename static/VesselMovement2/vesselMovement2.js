/*global window, document, widget, define */

define('VesselMovement2',
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
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselMovement2/vessel_lifecycle_simulation.csv',
        DEFAULT_INTERVAL_MS: 350,
        FAST_INTERVAL_MS: 100,
        VESSEL_MARKER_PREFIX: 'VESSEL_',
        BERTH_MARKER_PREFIX: 'BERTH_',
        GRID_ROW_LIMIT: 13
    };

    // Static reference points / berth coordinates, ported 1:1 from the HTML twin
    var BERTHS = {
        B1: [18.935507, 72.9294711], B2: [18.937334, 72.9311121], B3: [18.940734, 72.9342451],
        B4: [18.944334, 72.9343691], B5: [18.946589, 72.9365791], B6: [18.948527, 72.9381561],
        B7: [18.954051, 72.9424451], B8: [18.95607,  72.9434641], B9: [18.957967, 72.9443541],
        B10: [18.960057, 72.9452341]
    };
    var ANCH = [18.888, 72.885];
    var CHANNEL = [18.918, 72.905];
    var SEA = [18.84, 72.78];

    // ---------------------------------------------------------------------
    // APP STATE
    // ---------------------------------------------------------------------
    var app = {
        events: [],
        times: [],
        timeIndex: 0,
        state: {},                 // cumulative per-vessel state, keyed by vessel_id (mirrors HTML's `state`)
        vesselMarkerIds: {},       // vessel_id -> marker id currently on the platform
        berthMarkerIds: {},        // berth code -> marker id (created once)
        berthOccupied: {},         // berth code -> bool, last published occupancy
        currentTide: '-',
        playbackHandle: null,
        playing: false,
        // DOM refs (resolved via getElementById after injection - same pattern as renderDetail in original file)
        container: null,
        statusBar: null
    };

    // ---------------------------------------------------------------------
    // HELPERS
    // ---------------------------------------------------------------------
    function safe(v) { return (v === undefined || v === null || v === '') ? '-' : String(v); }

    function esc(s) {
        return safe(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function parseCsv(text) {
        var lines = text.replace(/\r/g, '').trim().split('\n');
        if (!lines.length) { return []; }
        var headers = lines[0].split(',').map(function (h) { return h.trim(); });
        return lines.slice(1).filter(function (l) { return l.length; }).map(function (line) {
            var parts = line.split(',');
            var obj = {};
            headers.forEach(function (h, idx) { obj[h] = (parts[idx] || '').trim(); });
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

    function toXY(latlon) {
        return { x: latlon[1], y: latlon[0] };
    }

    function removeContent(id) {
        if (!id) { return; }
        PlatformAPI.publish('3DEXPERIENCity.RemoveContent', id);
    }

    // Mirrors pos() from the HTML twin exactly (same precedence order)
    function posFor(ev) {
        if (ev.substage && ev.substage.indexOf('ANCHORAGE') !== -1) { return ANCH; }
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
                position: toXY(BERTHS[b]),
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

    // Re-publishes a berth marker with updated color/description when its occupancy changes
    function setBerthOccupied(b, occupied) {
        if (!BERTHS[b] || app.berthOccupied[b] === occupied) { return; }
        app.berthOccupied[b] = occupied;
        removeContent(app.berthMarkerIds[b]);
        var markerId = CONFIG.BERTH_MARKER_PREFIX + b;
        app.berthMarkerIds[b] = markerId;
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: toXY(BERTHS[b]),
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
    // VESSEL MARKERS
    // ---------------------------------------------------------------------
    function publishVesselMarker(ev) {
        var id = ev.vessel_id;
        var markerId = CONFIG.VESSEL_MARKER_PREFIX + id;
        removeContent(app.vesselMarkerIds[id]); // drop previous position marker for this vessel, if any
        app.vesselMarkerIds[id] = markerId;
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: toXY(posFor(ev)),
            layer: {
                id: markerId,
                name: id,
                description:
                    '<b>Vessel:</b> ' + esc(id) + '<br>' +
                    '<b>Voyage:</b> ' + esc(ev.voyage_no) + '<br>' +
                    '<b>Line:</b> ' + esc(ev.shipping_line) + '<br>' +
                    '<b>Type:</b> ' + esc(ev.container_type) + '<br>' +
                    '<b>Terminal:</b> ' + esc(ev.terminal) + '<br>' +
                    '<b>Berth:</b> ' + esc(ev.berth) + '<br>' +
                    '<b>Stage:</b> ' + esc(ev.stage) + '<br>' +
                    '<b>Substage:</b> ' + esc(ev.substage)
            },
            render: {
                style: 'icon',
                color: '#D5E8F2',
                iconName: 'transportation-boat'
            },
            options: { projection: { from: 'WGS84' } }
        });
    }

    // ---------------------------------------------------------------------
    // UI - built dynamically (no static HTML), mirrors the sidebar/controls
    // from the digital twin (KPIs, fleet grid, berth status, playback controls)
    // ---------------------------------------------------------------------
    function initUi() {
        widget.body.empty();

        var html =
            '<div style="font-family:Arial,sans-serif;padding:12px;">' +
                '<h1 style="color:#0B5CAB;font-size:18px;margin:0 0 8px 0;">JNPA Vessel Lifecycle Playback</h1>' +
                '<div id="vm-status" style="color:#666;margin-bottom:10px;">Initializing...</div>' +

                '<div style="border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:10px;">' +
                    '<h3 style="margin:0 0 6px 0;color:#004b87;font-size:14px;border-bottom:2px solid #0073cf;padding-bottom:4px;">Operational Core</h3>' +
                    '<div id="vm-kpis"></div>' +
                '</div>' +

                '<div style="border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:10px;">' +
                    '<h3 style="margin:0 0 6px 0;color:#004b87;font-size:14px;border-bottom:2px solid #0073cf;padding-bottom:4px;">Active Fleet Positions</h3>' +
                    '<div id="vm-grid"></div>' +
                '</div>' +

                '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                    '<button id="vm-play" style="background:#0073cf;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;font-weight:bold;">Play Timeline</button>' +
                    '<select id="vm-speed">' +
                        '<option value="' + CONFIG.DEFAULT_INTERVAL_MS + '">Normal</option>' +
                        '<option value="' + CONFIG.FAST_INTERVAL_MS + '">Fast</option>' +
                    '</select>' +
                    '<input id="vm-timeline" type="range" min="0" max="0" value="0" style="flex:1;min-width:150px;">' +
                    '<div style="display:flex;flex-direction:column;align-items:flex-start;min-width:170px;">' +
                        '<span id="vm-current-time" style="font-family:monospace;font-size:12px;font-weight:bold;color:#004b87;"></span>' +
                        '<span id="vm-tide" style="font-size:12px;font-weight:bold;color:#d62728;margin-top:2px;">Current Tide: -</span>' +
                    '</div>' +
                '</div>' +
            '</div>';

        UWA.createElement('div', { html: html }).inject(widget.body);

        app.statusBar = document.getElementById('vm-status');
        app.container = document.getElementById('vm-grid');

        document.getElementById('vm-timeline').addEventListener('input', function (e) {
            renderToIndex(+e.target.value);
        });

        document.getElementById('vm-play').addEventListener('click', togglePlayback);
    }

    function updateKpis() {
        var dry = 0, reef = 0;
        Object.keys(app.state).forEach(function (id) {
            var v = app.state[id];
            if (v.status.indexOf('SAILED') === -1) {
                if (v.type === 'DRY_VAN') { dry++; }
                if (v.type === 'REEFER_CARGO') { reef++; }
            }
        });
        document.getElementById('vm-kpis').innerHTML =
            '<div style="background:#f8f9fa;margin:6px 0;padding:8px;border-radius:4px;border-left:4px solid #0073cf;font-size:12px;">' +
                'Tide Gauge Height: <b>' + esc(app.currentTide) + '</b></div>' +
            '<div style="background:#f8f9fa;margin:6px 0;padding:8px;border-radius:4px;border-left:4px solid #2ca02c;font-size:12px;">' +
                'Active Dry Van Fleets (T1/T2): <b>' + dry + '</b></div>' +
            '<div style="background:#f8f9fa;margin:6px 0;padding:8px;border-radius:4px;border-left:4px solid #ff7f0e;font-size:12px;">' +
                'Active Reefer Container (T3/T4): <b>' + reef + '</b></div>';

        document.getElementById('vm-tide').textContent = 'Current Tide: ' + safe(app.currentTide) + ' / 5.0';
    }

    function updateGrid() {
        var rows = Object.keys(app.state).slice(0, CONFIG.GRID_ROW_LIMIT);
        var h = '<table style="width:100%;border-collapse:collapse;margin-top:6px;font-size:11px;">' +
            '<tr><th style="border:1px solid #e0e0e0;padding:4px;background:#f7f9fa;">Vessel</th>' +
            '<th style="border:1px solid #e0e0e0;padding:4px;background:#f7f9fa;">JNPA Box Class</th>' +
            '<th style="border:1px solid #e0e0e0;padding:4px;background:#f7f9fa;">Terminal</th>' +
            '<th style="border:1px solid #e0e0e0;padding:4px;background:#f7f9fa;">Berth</th>' +
            '<th style="border:1px solid #e0e0e0;padding:4px;background:#f7f9fa;">Status</th></tr>';
        rows.forEach(function (id) {
            var v = app.state[id];
            h += '<tr>' +
                '<td style="border:1px solid #e0e0e0;padding:4px;"><b>' + esc(id) + '</b></td>' +
                '<td style="border:1px solid #e0e0e0;padding:4px;">' + esc(v.type) + '</td>' +
                '<td style="border:1px solid #e0e0e0;padding:4px;">' + esc(v.term) + '</td>' +
                '<td style="border:1px solid #e0e0e0;padding:4px;"><b style="color:#0073cf">' + safe(v.berth) + '</b></td>' +
                '<td style="border:1px solid #e0e0e0;padding:4px;">' + esc(v.status) + '</td>' +
                '</tr>';
        });
        h += '</table>';
        app.container.innerHTML = h;
    }

    function updateBerthOccupancy() {
        var occupied = {};
        Object.keys(app.state).forEach(function (id) {
            var v = app.state[id];
            if (v.berth && v.status.indexOf('SAILED') === -1 && v.status.indexOf('UNBERTHED') === -1) {
                occupied[v.berth] = true;
            }
        });
        Object.keys(BERTHS).forEach(function (b) {
            setBerthOccupied(b, !!occupied[b]);
        });
    }

    // ---------------------------------------------------------------------
    // TIMELINE PLAYBACK
    // ---------------------------------------------------------------------
    function renderToIndex(i) {
        app.timeIndex = i;
        var t = app.times[i];
        document.getElementById('vm-current-time').textContent = t;

        var cur = app.events.filter(function (e) { return e.event_time === t; });

        if (cur.length) {
            app.currentTide = cur[0].tide_level;
        }

        cur.forEach(function (ev) {
            publishVesselMarker(ev);
            app.state[ev.vessel_id] = {
                status: ev.substage,
                berth: ev.berth,
                line: ev.shipping_line,
                type: ev.container_type,
                tide: ev.tide_level,
                term: ev.terminal
            };
        });

        updateKpis();
        updateGrid();
        updateBerthOccupancy();

        app.statusBar.textContent = 'Playback time: ' + t + ' | Step ' + (i + 1) + ' of ' + app.times.length;
        document.getElementById('vm-timeline').value = i;
    }

    function togglePlayback() {
        var btn = document.getElementById('vm-play');
        if (app.playbackHandle) {
            window.clearInterval(app.playbackHandle);
            app.playbackHandle = null;
            app.playing = false;
            btn.textContent = 'Play Timeline';
            return;
        }
        app.playing = true;
        btn.textContent = 'Pause';
        var intervalMs = +document.getElementById('vm-speed').value || CONFIG.DEFAULT_INTERVAL_MS;
        app.playbackHandle = window.setInterval(function () {
            var idx = app.timeIndex + 1;
            if (idx >= app.times.length) {
                window.clearInterval(app.playbackHandle);
                app.playbackHandle = null;
                app.playing = false;
                btn.textContent = 'Play Timeline';
                return;
            }
            renderToIndex(idx);
        }, intervalMs);
    }

    // ---------------------------------------------------------------------
    // LOAD
    // ---------------------------------------------------------------------
    function onLoad() {
        initUi();
        initBerthMarkers();

        apiGetText(CONFIG.CSV_URL)
            .then(parseCsv)
            .then(function (rows) {
                app.events = rows.filter(function (x) { return x.event_time; });
                app.times = Array.prototype.slice.call(
                    rows.reduce(function (set, x) { if (x.event_time) { set.add(x.event_time); } return set; }, new Set())
                ).sort();

                document.getElementById('vm-timeline').max = app.times.length - 1;

                if (app.times.length) {
                    renderToIndex(0);
                } else {
                    app.statusBar.textContent = 'No events found in CSV';
                }
            })
            .catch(function (err) {
                app.statusBar.textContent = 'Failed to load vessel lifecycle CSV';
                app.statusBar.style.color = '#C0392B';
                app.container.innerHTML = '<pre style="color:#C0392B;white-space:pre-wrap;">' +
                    esc(err && err.message ? err.message : err) + '</pre>';
            });
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});
