/*global window, widget, define */

define('xCityLiveSTARApp',
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

    var CONFIG = {
        CSV_URL: 'https://test-app-lyart-six.vercel.app/jnpa_vessel_timeseries.csv',
        PLAYBACK_INTERVAL_MS: 3000,
        TRAIL_LENGTH: 10,
        MARKER_PREFIX: 'VESSEL_',
        TRAIL_PREFIX: 'TRAIL_'
    };

    var app = {
        frames: [],
        frameIndex: 0,
        byVessel: {},
        activeMarkerIds: [],
        activeTrailIds: [],
        selectedShipId: null,
        playbackHandle: null,
        container: null,
        statusBar: null,
        trails: {}
    };

    function safe(v) { return (v === undefined || v === null || v === '') ? '-' : String(v); }

    function esc(s) {
        return safe(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function parseCsv(text) {
        var lines = text.replace(/\r/g, '').trim().split('\n');
        if (!lines.length) { return []; }
        var headers = lines[0].split(',').map(function (h) { return h.trim(); });
        return lines.slice(1).map(function (line) {
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

    function groupFrames(rows) {
        var bucket = {};
        rows.forEach(function (r) {
            var ts = r.timestamp_utc;
            if (!bucket[ts]) { bucket[ts] = []; }
            bucket[ts].push({
                timestamp_utc: ts,
                vessel_id: r.vessel_id,
                vessel_name: r.vessel_name,
                imo: r.imo,
                mmsi: r.mmsi,
                vessel_type: r.vessel_type,
                latitude: parseFloat(r.latitude),
                longitude: parseFloat(r.longitude),
                speed_knots: parseFloat(r.speed_knots || '0'),
                heading_deg: parseFloat(r.heading_deg || '0'),
                route_segment: r.route_segment,
                berth_assignment: r.berth_assignment,
                destination: r.destination,
                alert_state: r.alert_state,
                remarks: r.remarks
            });
        });
        return Object.keys(bucket).sort().map(function (ts) {
            return { timestamp: ts, vessels: bucket[ts] };
        });
    }

    function removeContent(id) {
        if (!id) { return; }
        PlatformAPI.publish('3DEXPERIENCity.RemoveContent', id);
    }

    function clearMapObjects() {
        app.activeMarkerIds.forEach(removeContent);
        app.activeMarkerIds = [];
        app.activeTrailIds.forEach(removeContent);
        app.activeTrailIds = [];
    }

    function addMarker(ship) {
        var markerId = CONFIG.MARKER_PREFIX + ship.vessel_id;
        app.activeMarkerIds.push(markerId);
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: { x: ship.longitude, y: ship.latitude },
            layer: {
                id: markerId,
                name: ship.vessel_name,
                description:
                    '<b>Vessel:</b> ' + esc(ship.vessel_name) + '<br>' +
                    '<b>MMSI:</b> ' + esc(ship.mmsi) + '<br>' +
                    '<b>IMO:</b> ' + esc(ship.imo) + '<br>' +
                    '<b>Time:</b> ' + esc(ship.timestamp_utc) + '<br>' +
                    '<b>Speed:</b> ' + esc(ship.speed_knots) + ' kn<br>' +
                    '<b>Heading:</b> ' + esc(ship.heading_deg) + '°<br>' +
                    '<b>Route Segment:</b> ' + esc(ship.route_segment) + '<br>' +
                    '<b>Berth:</b> ' + esc(ship.berth_assignment)
            },
            render: {
                style: 'icon',
                color: '#D5E8F2',
                iconName: 'transportation-boat'
            },
            options: {
                projection: { from: 'WGS84' }
            }
        });
    }

    function addTrail(ship) {
        if (!app.trails[ship.vessel_id] || app.trails[ship.vessel_id].length < 2) {
            return;
        }
        var trailId = CONFIG.TRAIL_PREFIX + ship.vessel_id;
        app.activeTrailIds.push(trailId);
        PlatformAPI.publish('3DEXPERIENCity.AddLine', {
            json: [{
                type: 'LineString',
                properties: { STRID: ship.vessel_id },
                coordinates: app.trails[ship.vessel_id].map(function (p) { return [p.lon, p.lat]; })
            }],
            layer: {
                id: trailId,
                name: trailId,
                attributeMapping: { STRID: 'id' }
            },
            render: {
                color: '#4A90E2',
                lineWidth: 2
            },
            options: {
                projection: { from: 'WGS84' }
            }
        });
    }

    function renderDetail(ship) {
        app.container.empty();
        UWA.createElement('div', {
            html:
                '<div style="font-family:Arial,sans-serif;">' +
                '<h2 style="margin:0 0 8px 0;color:#0B5CAB;">' + esc(ship.vessel_name) + '</h2>' +
                '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
                '<div><b>MMSI:</b> ' + esc(ship.mmsi) + '</div>' +
                '<div><b>IMO:</b> ' + esc(ship.imo) + '</div>' +
                '<div><b>Type:</b> ' + esc(ship.vessel_type) + '</div>' +
                '<div><b>Time:</b> ' + esc(ship.timestamp_utc) + '</div>' +
                '<div><b>Lat:</b> ' + ship.latitude.toFixed(6) + '</div>' +
                '<div><b>Lon:</b> ' + ship.longitude.toFixed(6) + '</div>' +
                '<div><b>Speed:</b> ' + esc(ship.speed_knots) + ' kn</div>' +
                '<div><b>Heading:</b> ' + esc(ship.heading_deg) + '°</div>' +
                '<div><b>Segment:</b> ' + esc(ship.route_segment) + '</div>' +
                '<div><b>Berth:</b> ' + esc(ship.berth_assignment) + '</div>' +
                '<div><b>Destination:</b> ' + esc(ship.destination) + '</div>' +
                '<div><b>Alert:</b> ' + esc(ship.alert_state) + '</div>' +
                '</div>' +
                '<div style="margin-top:10px;"><b>Remarks:</b> ' + esc(ship.remarks) + '</div>' +
                '<div style="margin-top:10px;color:#666;">Movement is driven by time-series CSV playback, not simulated route generation.</div>' +
                '</div>'
        }).inject(app.container);
    }

    function renderDefault() {
        app.container.empty();
        UWA.createElement('div', {
            text: 'Time-series playback active. Click a vessel marker to view current frame details.',
            styles: { color: '#666', padding: '6px 0', fontFamily: 'Arial,sans-serif' }
        }).inject(app.container);
    }

    function renderFrame(frame) {
        clearMapObjects();
        frame.vessels.forEach(function (ship) {
            if (!app.trails[ship.vessel_id]) { app.trails[ship.vessel_id] = []; }
            app.trails[ship.vessel_id].push({ lon: ship.longitude, lat: ship.latitude });
            if (app.trails[ship.vessel_id].length > CONFIG.TRAIL_LENGTH) {
                app.trails[ship.vessel_id].shift();
            }
            app.byVessel[ship.vessel_id] = ship;
            addMarker(ship);
            addTrail(ship);
        });

        app.statusBar.setText('Playback time: ' + frame.timestamp + ' | Frame ' + (app.frameIndex + 1) + ' of ' + app.frames.length);

        if (app.selectedShipId && app.byVessel[app.selectedShipId]) {
            renderDetail(app.byVessel[app.selectedShipId]);
        }
    }

    function startPlayback() {
        if (app.playbackHandle) { window.clearInterval(app.playbackHandle); }
        app.playbackHandle = window.setInterval(function () {
            app.frameIndex = (app.frameIndex + 1) % app.frames.length;
            renderFrame(app.frames[app.frameIndex]);
        }, CONFIG.PLAYBACK_INTERVAL_MS);
    }

    function subscribeSelection() {
        PlatformAPI.subscribe('3DEXPERIENCity.OnItemSelect', function () {
            Promise.resolve().then(function () {
                return new Promise(function (resolve) {
                    PlatformAPI.publish('3DEXPERIENCity.GetSelectedItems');
                    PlatformAPI.subscribe('3DEXPERIENCity.GetSelectedItemsReturn', function (infos) {
                        PlatformAPI.unsubscribe('3DEXPERIENCity.GetSelectedItemsReturn');
                        resolve(infos);
                    });
                });
            }).then(function (infos) {
                if (!infos || !infos.length) { return; }
                var props = infos[0].properties || {};
                var id = String(props.id || props.STRID || '').replace(CONFIG.MARKER_PREFIX, '');
                if (app.byVessel[id]) {
                    app.selectedShipId = id;
                    renderDetail(app.byVessel[id]);
                }
            });
        });
    }

    function initUi() {
        widget.body.empty();
        var wrap = UWA.createElement('div', {
            styles: { padding: '12px', fontFamily: 'Arial,sans-serif' }
        }).inject(widget.body);

        UWA.createElement('h1', {
            text: 'JNPA Time-Series Vessel Tracking',
            styles: { color: '#0B5CAB', fontSize: '20px', margin: '0 0 8px 0' }
        }).inject(wrap);

        app.statusBar = UWA.createElement('div', {
            text: 'Initializing...',
            styles: { color: '#666', marginBottom: '10px' }
        }).inject(wrap);

        app.container = UWA.createElement('div').inject(wrap);
    }

    function onLoad() {
        initUi();
        subscribeSelection();
        apiGetText(CONFIG.CSV_URL)
            .then(parseCsv)
            .then(groupFrames)
            .then(function (frames) {
                app.frames = frames;
                app.frameIndex = 0;
                app.byVessel = {};
                app.trails = {};
                renderDefault();
                renderFrame(app.frames[0]);
                startPlayback();
            })
            .catch(function (err) {
                app.statusBar.setText('Failed to load time-series CSV');
                app.statusBar.setStyle('color', '#C0392B');
                app.container.empty();
                UWA.createElement('pre', {
                    text: safe(err && err.message ? err.message : err),
                    styles: { color: '#C0392B', whiteSpace: 'pre-wrap' }
                }).inject(app.container);
            });
    }

    widget.addEvent('onLoad', onLoad);
    return app;
});
