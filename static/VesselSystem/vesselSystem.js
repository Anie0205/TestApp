/*global window, widget, define*/

define('VesselUnifiedApp',
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
        // Restored original CSV path
        CSV_URL: 'https://test-app-lyart-six.vercel.app/static/VesselMovement/jnpa_vessel_timeseries.csv',
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

    // -----------------------------------------------------
    // Helper dynamically extracted from vesselInfo.js
    // -----------------------------------------------------
    function formatKey(key) {
        key = key.replace(/_/g, ' ');
        return key.charAt(0).toUpperCase() + key.slice(1);
    }

    // -----------------------------------------------------
    // Network Fetcher from vesselMovement.js
    // -----------------------------------------------------
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

    function parseCsv(text) {
        var lines = text.replace(/\r/g, '').trim().split('\n');
        if (!lines.length) { return []; }
        var headers = lines[0].split(',').map(function (h) { return h.trim(); });
        return lines.slice(1).map(function (line) {
            var parts = line.split(',');
            var obj = {};
            headers.forEach(function (h, idx) { obj[h] = (parts[idx] || '').trim(); });
            obj.latitude = parseFloat(obj.latitude);
            obj.longitude = parseFloat(obj.longitude);
            return obj;
        });
    }

    function groupFrames(rows) {
        var bucket = {};
        rows.forEach(function (r) {
            var ts = r.timestamp_utc;
            if (!bucket[ts]) { bucket[ts] = []; }
            bucket[ts].push(r);
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
        
        // -----------------------------------------------------
        // SEAMLESS INTEGRATION: No 'description' attribute 
        // ensures attributes DO NOT pop up on the 3D screen
        // -----------------------------------------------------
        PlatformAPI.publish('3DEXPERIENCity.AddMarker', {
            widgetID: widget.id,
            position: { x: ship.longitude, y: ship.latitude },
            layer: {
                id: markerId,
                name: ship.vessel_name
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

    // -----------------------------------------------------
    // Blended info generation logic from vesselInfo.js
    // dynamically renders all keys of the CSV
    // -----------------------------------------------------
    function renderDetail(ship) {
        app.container.empty();
        
        var wrapper = UWA.createElement('div', {
            styles: { fontFamily: 'Arial,sans-serif' }
        }).inject(app.container);
        
        UWA.createElement('h2', {
            text: ship.vessel_name || 'Vessel Information',
            styles: { margin: '0 0 8px 0', color: '#0B5CAB' }
        }).inject(wrapper);

        var grid = UWA.createElement('div', {
            styles: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }
        }).inject(wrapper);

        Object.keys(ship).forEach(function (key) {
            if (key !== 'vessel_name') {
                UWA.createElement('div', {
                    html: '<b>' + formatKey(key) + ':</b> ' + esc(ship[key])
                }).inject(grid);
            }
        });
        
        UWA.createElement('div', {
            text: 'Movement is driven by time-series CSV playback, not simulated route generation.',
            styles: { marginTop: '15px', color: '#666', fontStyle: 'italic' }
        }).inject(wrapper);
    }

    function renderDefault() {
        app.container.empty();
        UWA.createElement('div', {
            text: 'Time-series playback active. Click a vessel marker to view current frame details directly in this panel.',
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
                
                var selected;
                if (infos.data && infos.data.length > 0) {
                    selected = infos.data[infos.data.length - 1];
                } else if (infos.length > 0) {
                    selected = infos[0];
                }
                
                if (!selected) return;
                
                var props = selected.properties || selected || {};
                var id = String(props.id || props.STRID || '').replace(CONFIG.MARKER_PREFIX, '');
                
                // Fallback check matching logic for flexible integration
                if (!app.byVessel[id]) {
                    var foundShip = null;
                    Object.keys(app.byVessel).forEach(function(vid) {
                        if (app.byVessel[vid].vessel_name === id || app.byVessel[vid].vessel_id === id) {
                            foundShip = app.byVessel[vid];
                        }
                    });
                    if (foundShip) id = foundShip.vessel_id;
                }

                if (app.byVessel[id]) {
                    app.selectedShipId = id;
                    renderDetail(app.byVessel[id]);
                }
            });
        });
        
        PlatformAPI.subscribe('3DEXPERIENCity.OnItemDeselect', function () {
            app.selectedShipId = null;
            renderDefault();
        });
    }

    function initUi() {
        widget.body.empty();
        var wrap = UWA.createElement('div', {
            styles: { padding: '12px', fontFamily: 'Arial,sans-serif' }
        }).inject(widget.body);

        UWA.createElement('h1', {
            text: 'JNPA Integrated Vessel Tracking',
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
        
        // Restored network fetch chain
        apiGetText(CONFIG.CSV_URL)
            .then(parseCsv)
            .then(groupFrames)
            .then(function (frames) {
                app.frames = frames;
                app.frameIndex = 0;
                app.byVessel = {};
                app.trails = {};
                renderDefault();
                
                if (app.frames.length > 0) {
                    renderFrame(app.frames[0]);
                    startPlayback();
                } else {
                    app.statusBar.setText('No valid data found in CSV.');
                }
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